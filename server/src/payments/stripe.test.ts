// The adapter's mapping from Stripe's outcomes to the port's, against a stubbed client.
// The live suite (server/test/live) checks the same cases against real test mode.
import { cents } from '@holdfast/shared';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { TransientPaymentsError } from './port.ts';
import { StripePayments, type StripeLike, stripeAudit, stripeClient } from './stripe.ts';

const req = {
  idempotencyKey: 'bid-1',
  userId: 'u1',
  amount: cents(1_500),
  metadata: { bidId: 'bid-1', auctionId: 'a1' },
};
const card = { customerId: 'cus_1', paymentMethodId: 'pm_1' };

function intent(over: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_1',
    amount: 1_500,
    amount_capturable: 1_500,
    status: 'requires_capture',
    metadata: { bidId: 'bid-1', auctionId: 'a1' },
    ...over,
  } as Stripe.PaymentIntent;
}

type RawError = Parameters<typeof Stripe.errors.StripeError.generate>[0];

/** A Stripe error built the way the SDK builds one from a response. */
function err(raw: { statusCode: number; type?: string; code?: string; decline_code?: string }) {
  return Stripe.errors.StripeError.generate({
    message: 'stub',
    ...raw,
    type: raw.type ?? 'api_error',
  } as RawError);
}

/** An async-iterable list, the shape auto-pagination gives. */
function list(items: Stripe.PaymentIntent[]) {
  return {
    [Symbol.asyncIterator]: () => {
      const it = items[Symbol.iterator]();
      return { next: () => Promise.resolve(it.next()) };
    },
  };
}

function stub(over: Partial<Record<keyof StripeLike['paymentIntents'], unknown>> = {}) {
  const paymentIntents = {
    create: vi.fn(() => Promise.resolve(intent())),
    cancel: vi.fn(() => Promise.resolve(intent({ status: 'canceled' }))),
    capture: vi.fn(() => Promise.resolve(intent({ status: 'succeeded' }))),
    retrieve: vi.fn(() => Promise.resolve(intent())),
    list: vi.fn(() => list([])),
    ...over,
  };
  const client = { paymentIntents } as unknown as StripeLike;
  const payments = new StripePayments({ client, customerFor: () => Promise.resolve(card) });
  return { paymentIntents, payments, client };
}

describe('StripePayments.authorize', () => {
  it('creates and confirms a manual-capture, off-session intent keyed by the bid id', async () => {
    const { payments, paymentIntents } = stub();
    expect(await payments.authorize(req)).toEqual({
      ok: true,
      paymentIntentId: 'pi_1',
      status: 'requires_capture',
      amountCapturable: 1_500,
    });
    expect(paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_500,
        customer: 'cus_1',
        payment_method: 'pm_1',
        capture_method: 'manual',
        confirm: true,
        off_session: true,
        metadata: { bidId: 'bid-1', auctionId: 'a1' },
      }),
      { idempotencyKey: 'bid-1' },
    );
  });

  it('refuses a bidder with no saved card without calling Stripe', async () => {
    const { client, paymentIntents } = stub();
    const payments = new StripePayments({ client, customerFor: () => Promise.resolve(null) });
    expect(await payments.authorize(req)).toEqual({ ok: false, reason: 'no_payment_method' });
    expect(paymentIntents.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        statusCode: 402,
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
      },
      'insufficient_funds',
    ],
    [
      { statusCode: 402, type: 'card_error', code: 'authentication_required' },
      'authentication_required',
    ],
  ])('maps a card error to a refusal: %o', async (raw, reason) => {
    const { payments } = stub({ create: vi.fn(() => Promise.reject(err(raw))) });
    expect(await payments.authorize(req)).toEqual({ ok: false, reason });
  });

  it('cancels an intent left needing action and refuses the bid', async () => {
    const { payments, paymentIntents } = stub({
      create: vi.fn(() => Promise.resolve(intent({ status: 'requires_action' }))),
    });
    expect(await payments.authorize(req)).toEqual({
      ok: false,
      reason: 'authentication_required',
    });
    expect(paymentIntents.cancel).toHaveBeenCalledWith('pi_1');
  });

  it.each([
    [
      'a 409 for a key still in flight',
      err({ statusCode: 409, type: 'idempotency_error', code: 'idempotency_key_in_use' }),
    ],
    ['a 429', err({ statusCode: 429, code: 'rate_limit' })],
    ['a lost connection', new Stripe.errors.StripeConnectionError({ message: 'stub' })],
  ])('leaves the bid pending on %s', async (_, e) => {
    const { payments } = stub({ create: vi.fn(() => Promise.reject(e)) });
    await expect(payments.authorize(req)).rejects.toBeInstanceOf(TransientPaymentsError);
  });

  it('after a 500, finds the hold the request placed by bid id', async () => {
    const { payments, paymentIntents } = stub({
      create: vi.fn(() => Promise.reject(err({ statusCode: 500 }))),
      list: vi.fn(() =>
        list([intent({ id: 'pi_other', metadata: { bidId: 'bid-0' } }), intent({ id: 'pi_7' })]),
      ),
    });
    expect(await payments.authorize(req)).toMatchObject({ ok: true, paymentIntentId: 'pi_7' });
    expect(paymentIntents.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1' }),
    );
  });

  it('after a 500 that placed no hold, refuses the bid instead of leaving it pending', async () => {
    const { payments } = stub({ create: vi.fn(() => Promise.reject(err({ statusCode: 500 }))) });
    expect(await payments.authorize(req)).toEqual({ ok: false, reason: 'processing_error' });
  });

  it.each([
    ['a bad key', err({ statusCode: 401, type: 'invalid_request_error' })],
    ['a key reused with other parameters', err({ statusCode: 400, type: 'idempotency_error' })],
    [
      'an invalid request',
      err({ statusCode: 400, type: 'invalid_request_error', code: 'parameter_missing' }),
    ],
  ])('throws %s: a bug, not a decline', async (_, e) => {
    const { payments } = stub({ create: vi.fn(() => Promise.reject(e)) });
    await expect(payments.authorize(req)).rejects.toBe(e);
  });
});

describe('StripePayments.cancel and capture', () => {
  const unexpected = () =>
    Promise.reject(
      err({
        statusCode: 400,
        type: 'invalid_request_error',
        code: 'payment_intent_unexpected_state',
      }),
    );

  it('passes the outbox key through', async () => {
    const { payments, paymentIntents } = stub();
    expect(await payments.cancel('pi_1', { idempotencyKey: 'cancel_hold:b:1' })).toEqual({
      ok: true,
    });
    expect(paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      { cancellation_reason: 'abandoned' },
      { idempotencyKey: 'cancel_hold:b:1' },
    );
    expect(
      await payments.capture('pi_1', { amount: 1_500, idempotencyKey: 'capture:b:1' }),
    ).toEqual({ ok: true });
    expect(paymentIntents.capture).toHaveBeenCalledWith(
      'pi_1',
      { amount_to_capture: 1_500 },
      { idempotencyKey: 'capture:b:1' },
    );
  });

  it.each([
    ['cancel', 'canceled', { ok: true }],
    ['cancel', 'succeeded', { ok: false, reason: 'already_captured', retryable: false }],
    ['capture', 'succeeded', { ok: true }],
    ['capture', 'canceled', { ok: false, reason: 'cannot_capture_canceled', retryable: false }],
  ] as const)('judges a %s in the wrong state by the intent: %s', async (op, status, expected) => {
    const { payments } = stub({
      cancel: vi.fn(unexpected),
      capture: vi.fn(unexpected),
      retrieve: vi.fn(() => Promise.resolve(intent({ status }))),
    });
    const res =
      op === 'cancel'
        ? await payments.cancel('pi_1', { idempotencyKey: 'k' })
        : await payments.capture('pi_1', { amount: 1_500, idempotencyKey: 'k' });
    expect(res).toEqual(expected);
  });

  it('marks a 500 or a lost connection retryable', async () => {
    const { payments } = stub({
      cancel: vi.fn(() => Promise.reject(err({ statusCode: 500 }))),
      capture: vi.fn(() =>
        Promise.reject(new Stripe.errors.StripeConnectionError({ message: 'x' })),
      ),
    });
    expect(await payments.cancel('pi_1', { idempotencyKey: 'k' })).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await payments.capture('pi_1', { amount: 1, idempotencyKey: 'k' })).toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});

describe('stripeAudit and stripeClient', () => {
  it('audits only intents that held money', async () => {
    const { client } = stub({
      list: vi.fn(() =>
        list([
          intent({ id: 'pi_a' }),
          intent({ id: 'pi_b', status: 'canceled' }),
          intent({ id: 'pi_c', status: 'requires_payment_method' }),
        ]),
      ),
    });
    const audit = await stripeAudit(client, ['cus_1']);
    expect([...audit.intents.keys()]).toEqual(['pi_a', 'pi_b']);
  });

  it('refuses a key that is not test mode, without echoing it', () => {
    expect(() => stripeClient('sk_live_secret')).toThrow(/must be a test-mode key/);
    expect(() => stripeClient('sk_live_secret')).not.toThrow(/secret/);
    expect(stripeClient('sk_test_stub')).toBeInstanceOf(Stripe);
  });
});
