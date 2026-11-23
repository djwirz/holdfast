// The real provider behind the Payments port (ADR 0006): Stripe, test mode only. It maps
// Stripe's outcomes onto the port's, and copes with two things the key alone doesn't cover
// (spec §5): a 500 is saved and replayed for its key, and a second request while the
// first with that key still runs gets a 409.
import Stripe from 'stripe';
import {
  type AuthorizeRequest,
  type AuthorizeResult,
  type EffectResult,
  type PaymentIntentStatus,
  type PaymentIntentView,
  type Payments,
  TransientPaymentsError,
} from './port.ts';

/** The slice of the Stripe client this adapter uses, so unit tests can stub it. */
export interface StripeLike {
  paymentIntents: Pick<
    Stripe['paymentIntents'],
    'create' | 'cancel' | 'capture' | 'retrieve' | 'list'
  >;
}

export interface SavedCard {
  customerId: string;
  paymentMethodId: string;
}

export interface StripePaymentsOptions {
  client: StripeLike;
  /** The bidder's Stripe Customer and saved card; null if they haven't added one. */
  customerFor: (userId: string) => Promise<SavedCard | null>;
}

/** A Stripe client that refuses anything but a test-mode secret key. */
export function stripeClient(secretKey: string): Stripe {
  if (!secretKey.startsWith('sk_test_')) {
    // Never echo the key: only say what kind it isn't.
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)');
  }
  // The API version is the one this SDK release was built for, so types match responses.
  // Retries reuse our idempotency key, so they can't place a second hold.
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
}

const HELD: readonly PaymentIntentStatus[] = ['requires_capture', 'canceled', 'succeeded'];

/** How a Stripe error bears on the outcome. */
type Failure =
  | { kind: 'declined'; reason: string }
  /** The request may not have run (or ran and its result is unknown): try again later. */
  | { kind: 'unknown'; reason: string }
  /** A 500: the request ran to the end, and Stripe replays this error for the key. */
  | { kind: 'server_error'; reason: string }
  | { kind: 'state'; reason: string };

function classify(e: unknown): Failure {
  if (!(e instanceof Stripe.errors.StripeError)) throw e;
  if (e instanceof Stripe.errors.StripeCardError) {
    return { kind: 'declined', reason: e.decline_code || e.code || 'card_declined' };
  }
  if (e instanceof Stripe.errors.StripeConnectionError) {
    return { kind: 'unknown', reason: 'connection_error' };
  }
  const status = e.statusCode ?? 0;
  // 409: another request with this key is still running. 429: rate limited before running.
  // Stripe saves neither, so the same key can be tried again.
  if (status === 409 || status === 429)
    return { kind: 'unknown', reason: e.code ?? String(status) };
  if (status >= 500) return { kind: 'server_error', reason: e.code ?? 'api_error' };
  if (e.code === 'payment_intent_unexpected_state') return { kind: 'state', reason: e.code };
  // Bad keys, permissions, a key reused with other parameters, invalid requests: bugs, not
  // outcomes. They surface instead of being retried forever.
  throw e;
}

export class StripePayments implements Payments {
  private readonly client: StripeLike;
  private readonly customerFor: StripePaymentsOptions['customerFor'];

  constructor(options: StripePaymentsOptions) {
    this.client = options.client;
    this.customerFor = options.customerFor;
  }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const card = await this.customerFor(req.userId);
    if (!card) return { ok: false, reason: 'no_payment_method' };
    let intent: Stripe.PaymentIntent;
    try {
      intent = await this.client.paymentIntents.create(
        {
          amount: req.amount,
          currency: 'usd',
          customer: card.customerId,
          payment_method: card.paymentMethodId,
          capture_method: 'manual',
          confirm: true,
          // Bids are confirmed without the bidder present; a card that wants 3-D Secure
          // fails with authentication_required instead of waiting for a challenge (spec §1).
          off_session: true,
          metadata: { bidId: req.metadata.bidId, auctionId: req.metadata.auctionId },
        },
        { idempotencyKey: req.idempotencyKey },
      );
    } catch (e) {
      const failure = classify(e);
      if (failure.kind === 'declined') return { ok: false, reason: failure.reason };
      if (failure.kind === 'server_error') {
        // The request finished, so any hold it placed exists by now, and retrying the key
        // would only replay this 500. Look for the hold by bid id instead.
        const found = await this.findHold(card.customerId, req.metadata.bidId);
        return found ?? { ok: false, reason: 'processing_error' };
      }
      throw new TransientPaymentsError(`stripe: ${failure.reason}`);
    }
    return this.toAuthorizeResult(intent);
  }

  private async toAuthorizeResult(intent: Stripe.PaymentIntent): Promise<AuthorizeResult> {
    if (intent.status === 'requires_capture') {
      return {
        ok: true,
        paymentIntentId: intent.id,
        status: 'requires_capture',
        amountCapturable: intent.amount_capturable,
      };
    }
    // No hold. Off-session, requires_action means the card wants authentication. Cancel the
    // stray intent so nothing is left half-open; it holds no money either way.
    await this.client.paymentIntents.cancel(intent.id).catch(() => undefined);
    return {
      ok: false,
      reason: intent.status === 'requires_action' ? 'authentication_required' : intent.status,
    };
  }

  /**
   * A live hold for this bid, if one exists. List, not Search: Search can lag by up to a
   * minute, and the hold we're looking for may be seconds old.
   */
  private async findHold(customerId: string, bidId: string): Promise<AuthorizeResult | null> {
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    for await (const intent of this.client.paymentIntents.list({
      customer: customerId,
      created: { gte: since },
      limit: 100,
    })) {
      if (intent.metadata['bidId'] === bidId && intent.status === 'requires_capture') {
        return {
          ok: true,
          paymentIntentId: intent.id,
          status: 'requires_capture',
          amountCapturable: intent.amount_capturable,
        };
      }
    }
    return null;
  }

  async cancel(
    paymentIntentId: string,
    options: { idempotencyKey: string },
  ): Promise<EffectResult> {
    try {
      await this.client.paymentIntents.cancel(
        paymentIntentId,
        { cancellation_reason: 'abandoned' },
        { idempotencyKey: options.idempotencyKey },
      );
      return { ok: true };
    } catch (e) {
      return this.effectFailure(e, paymentIntentId, (status) =>
        status === 'canceled'
          ? { ok: true }
          : {
              ok: false,
              reason: status === 'succeeded' ? 'already_captured' : status,
              retryable: false,
            },
      );
    }
  }

  async capture(
    paymentIntentId: string,
    options: { amount: number; idempotencyKey: string },
  ): Promise<EffectResult> {
    try {
      await this.client.paymentIntents.capture(
        paymentIntentId,
        { amount_to_capture: options.amount },
        { idempotencyKey: options.idempotencyKey },
      );
      return { ok: true };
    } catch (e) {
      return this.effectFailure(e, paymentIntentId, (status) =>
        status === 'succeeded'
          ? { ok: true }
          : { ok: false, reason: `cannot_capture_${status}`, retryable: false },
      );
    }
  }

  /**
   * A cancel or capture that failed. If the intent was in the wrong state, its current
   * state decides: canceling a canceled hold succeeded, as the port promises, even after
   * Stripe has forgotten the idempotency key.
   */
  private async effectFailure(
    e: unknown,
    paymentIntentId: string,
    judge: (status: Stripe.PaymentIntent.Status) => EffectResult,
  ): Promise<EffectResult> {
    const failure = classify(e);
    if (failure.kind === 'state') {
      const intent = await this.client.paymentIntents.retrieve(paymentIntentId);
      return judge(intent.status);
    }
    // A 500 or a lost connection: the effect may or may not have happened. The outbox
    // retries with a new key per attempt, so a replayed 500 can't block it, and if the
    // first attempt did land, the wrong-state check above settles the second.
    return { ok: false, reason: failure.reason, retryable: failure.kind !== 'declined' };
  }

  async listHolds(): Promise<PaymentIntentView[]> {
    // A hold lasts 7 days (spec §2), so older intents can't be holding money.
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const holds: PaymentIntentView[] = [];
    for await (const intent of this.client.paymentIntents.list({
      created: { gte: since },
      limit: 100,
    })) {
      // Only this app's bids: other intents on the account aren't ours to judge.
      if (intent.status !== 'requires_capture' || !intent.metadata['bidId']) continue;
      const view = toView(intent);
      if (view) holds.push(view);
    }
    return holds;
  }

  async retrieve(paymentIntentId: string): Promise<PaymentIntentView | null> {
    const intent = await this.client.paymentIntents.retrieve(paymentIntentId);
    return toView(intent);
  }
}

/** Our view of an intent, or null if it never held money (declined, or awaiting action). */
export function toView(intent: Stripe.PaymentIntent): PaymentIntentView | null {
  const status = intent.status as PaymentIntentStatus;
  if (!HELD.includes(status)) return null;
  return {
    id: intent.id,
    amount: intent.amount,
    amountCapturable: intent.amount_capturable,
    status,
    metadata: {
      bidId: intent.metadata['bidId'] ?? '',
      auctionId: intent.metadata['auctionId'] ?? '',
    },
  };
}

/**
 * Every intent these customers ever had that held money, for the invariant checker's
 * audit. Listing by customer sees intents our database never recorded, such as a second
 * hold made by a duplicated request, which is what invariant 5 needs.
 */
export async function stripeAudit(
  client: StripeLike,
  customerIds: readonly string[],
): Promise<{ intents: Map<string, PaymentIntentView> }> {
  const intents = new Map<string, PaymentIntentView>();
  for (const customer of customerIds) {
    for await (const intent of client.paymentIntents.list({ customer, limit: 100 })) {
      const view = toView(intent);
      if (view) intents.set(view.id, view);
    }
  }
  return { intents };
}
