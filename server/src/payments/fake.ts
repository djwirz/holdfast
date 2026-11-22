// A stateful in-process stand-in for Stripe's PaymentIntent subset (ADR 0006). Unlike a
// stateless mock, it remembers intents, so the invariant checker can audit every hold,
// and it can fail on demand in the ways spec §7 lists.
import { randomUUID } from 'node:crypto';
import {
  type AuthorizeRequest,
  type AuthorizeResult,
  type EffectResult,
  type Payments,
  type PaymentIntentView,
  TransientPaymentsError,
} from './port.ts';

export type Decision =
  | { approve: true }
  | { approve: false; reason: string }
  /** Nothing happened, and the caller can't tell: a timeout before Stripe acted. */
  | { error: 'transient' }
  /** The hold was placed, then the response was lost (spec §7). A retry finds it. */
  | { error: 'after_authorize' }
  /**
   * A 500 from the provider. Stripe saves it and replays it for the same key for at least
   * 24 hours, so a retry can't find the hold through the key. `created` says whether a hold
   * was placed before the error.
   */
  | { error: 'server_error'; created: boolean };

export type EffectFault =
  undefined | { retryable: true; reason: string } | { retryable: false; reason: string };

export interface FakePaymentsOptions {
  /** Milliseconds before the authorization returns. Tests use it to force an order. */
  latency?: (req: AuthorizeRequest) => number;
  decide?: (req: AuthorizeRequest) => Decision;
  /** Make a cancel or capture fail; undefined lets it through. */
  effectFault?: (op: 'cancel' | 'capture', paymentIntentId: string) => EffectFault;
}

type Settled =
  | { kind: 'result'; result: AuthorizeResult }
  | { kind: 'intent'; id: string }
  | { kind: 'server_error' };

export class FakePayments implements Payments {
  readonly intents = new Map<string, PaymentIntentView>();
  /** Authorize calls per idempotency key, including retries. */
  readonly callsByKey = new Map<string, number>();
  /** Cancel and capture calls per idempotency key, including retries. */
  readonly cancelCalls = new Map<string, number>();
  readonly captureCalls = new Map<string, number>();
  /** Like Stripe's idempotency keys: the first completed outcome per key is replayed. */
  private readonly settled = new Map<string, Settled>();
  private readonly inFlight = new Set<string>();
  private readonly latency: (req: AuthorizeRequest) => number;
  private readonly decide: (req: AuthorizeRequest) => Decision;
  private readonly effectFault: NonNullable<FakePaymentsOptions['effectFault']>;

  constructor(options: FakePaymentsOptions = {}) {
    this.latency = options.latency ?? (() => 0);
    this.decide = options.decide ?? (() => ({ approve: true }));
    this.effectFault = options.effectFault ?? (() => undefined);
  }

  authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    bump(this.callsByKey, req.idempotencyKey);
    const done = this.settled.get(req.idempotencyKey);
    if (done) return Promise.resolve(this.replay(done, req));
    if (this.inFlight.has(req.idempotencyKey)) {
      // Stripe refuses a second request while the first with that key is still running
      // (409 idempotency_key_in_use) and saves nothing for it, so a later retry can succeed.
      return Promise.reject(new TransientPaymentsError('fake: idempotency_key_in_use'));
    }
    this.inFlight.add(req.idempotencyKey);
    return this.run(req).finally(() => this.inFlight.delete(req.idempotencyKey));
  }

  private replay(done: Settled, req: AuthorizeRequest): AuthorizeResult {
    if (done.kind === 'result') return done.result;
    if (done.kind === 'server_error') return this.recoverFromServerError(req);
    const intent = this.intents.get(done.id);
    if (!intent) throw new Error(`fake lost intent ${done.id}`);
    return {
      ok: true,
      paymentIntentId: intent.id,
      status: 'requires_capture',
      amountCapturable: intent.amountCapturable,
    };
  }

  private async run(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const ms = this.latency(req);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    const decision = this.decide(req);
    if ('error' in decision && decision.error === 'transient') {
      // Not remembered: Stripe doesn't store a result for a request it never acted on.
      throw new TransientPaymentsError('fake: timed out before authorizing');
    }
    if ('approve' in decision && !decision.approve) {
      const result: AuthorizeResult = { ok: false, reason: decision.reason };
      this.settled.set(req.idempotencyKey, { kind: 'result', result });
      return result;
    }
    if ('error' in decision && decision.error === 'server_error') {
      if (decision.created) this.createIntent(req);
      this.settled.set(req.idempotencyKey, { kind: 'server_error' });
      return this.recoverFromServerError(req);
    }
    const id = this.createIntent(req);
    this.settled.set(req.idempotencyKey, { kind: 'intent', id });
    if ('error' in decision) {
      throw new TransientPaymentsError('fake: authorized, then the response was lost');
    }
    return {
      ok: true,
      paymentIntentId: id,
      status: 'requires_capture',
      amountCapturable: req.amount,
    };
  }

  private createIntent(req: AuthorizeRequest): string {
    // Globally unique, like Stripe's ids: fakes in different tests share one database.
    const id = `pi_fake_${randomUUID().replaceAll('-', '')}`;
    this.intents.set(id, {
      id,
      amount: req.amount,
      amountCapturable: req.amount,
      status: 'requires_capture',
      metadata: req.metadata,
    });
    return id;
  }

  /**
   * What the Stripe adapter does after a 500: the request finished, so any hold it placed
   * exists now. Find it by bid id, or report that there is none (spec §5). Without this, the
   * replayed 500 would leave the bid pending for a day.
   */
  private recoverFromServerError(req: AuthorizeRequest): AuthorizeResult {
    for (const intent of this.intents.values()) {
      if (intent.metadata.bidId === req.metadata.bidId && intent.status === 'requires_capture') {
        return {
          ok: true,
          paymentIntentId: intent.id,
          status: 'requires_capture',
          amountCapturable: intent.amountCapturable,
        };
      }
    }
    return { ok: false, reason: 'processing_error' };
  }

  cancel(paymentIntentId: string, options: { idempotencyKey: string }): Promise<EffectResult> {
    bump(this.cancelCalls, options.idempotencyKey);
    const fault = this.effectFault('cancel', paymentIntentId);
    if (fault) return Promise.resolve({ ok: false, ...fault });
    const intent = this.intents.get(paymentIntentId);
    if (!intent) return Promise.resolve({ ok: false, reason: 'not_found', retryable: false });
    if (intent.status === 'succeeded') {
      return Promise.resolve({ ok: false, reason: 'already_captured', retryable: false });
    }
    this.intents.set(paymentIntentId, { ...intent, status: 'canceled', amountCapturable: 0 });
    return Promise.resolve({ ok: true });
  }

  capture(
    paymentIntentId: string,
    options: { amount: number; idempotencyKey: string },
  ): Promise<EffectResult> {
    bump(this.captureCalls, options.idempotencyKey);
    const fault = this.effectFault('capture', paymentIntentId);
    if (fault) return Promise.resolve({ ok: false, ...fault });
    const intent = this.intents.get(paymentIntentId);
    if (!intent) return Promise.resolve({ ok: false, reason: 'not_found', retryable: false });
    if (intent.status === 'succeeded') return Promise.resolve({ ok: true });
    if (intent.status === 'canceled' || options.amount > intent.amountCapturable) {
      return Promise.resolve({
        ok: false,
        reason: `cannot_capture_${intent.status}`,
        retryable: false,
      });
    }
    this.intents.set(paymentIntentId, { ...intent, status: 'succeeded', amountCapturable: 0 });
    return Promise.resolve({ ok: true });
  }

  retrieve(paymentIntentId: string): Promise<PaymentIntentView | null> {
    const intent = this.intents.get(paymentIntentId);
    return Promise.resolve(intent ? { ...intent } : null);
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** mulberry32: a tiny seeded PRNG, so a failing storm can be replayed from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
