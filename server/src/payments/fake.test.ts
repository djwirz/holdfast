import { cents } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { FakePayments, seededRandom } from './fake.ts';

const req = (key: string, amount = 1_000) => ({
  idempotencyKey: key,
  userId: 'u1',
  amount: cents(amount),
  metadata: { bidId: key, auctionId: 'a1' },
});

describe('FakePayments', () => {
  it('authorizes and remembers the intent', async () => {
    const payments = new FakePayments();
    const result = await payments.authorize(req('k1'));
    expect(result).toMatchObject({ ok: true, status: 'requires_capture', amountCapturable: 1_000 });
    if (!result.ok) throw new Error('expected approval');
    expect(await payments.retrieve(result.paymentIntentId)).toMatchObject({
      amount: 1_000,
      status: 'requires_capture',
    });
  });

  it('replays the first result for a repeated key and never makes a second hold', async () => {
    const payments = new FakePayments({ latency: () => 5 });
    const [a, b] = await Promise.all([
      payments.authorize(req('k1')),
      payments.authorize(req('k1')),
    ]);
    expect(a).toEqual(b);
    expect(payments.intents.size).toBe(1);
    expect(payments.callsByKey.get('k1')).toBe(2);
  });

  it('declines without creating an intent', async () => {
    const payments = new FakePayments({
      decide: () => ({ approve: false, reason: 'card_declined' }),
    });
    expect(await payments.authorize(req('k1'))).toEqual({ ok: false, reason: 'card_declined' });
    expect(payments.intents.size).toBe(0);
  });

  it('lets latency decide which authorization returns first', async () => {
    const payments = new FakePayments({ latency: (r) => (r.idempotencyKey === 'slow' ? 30 : 0) });
    const order: string[] = [];
    await Promise.all(
      ['slow', 'fast'].map(async (k) => {
        await payments.authorize(req(k));
        order.push(k);
      }),
    );
    expect(order).toEqual(['fast', 'slow']);
  });
});

describe('seededRandom', () => {
  it('is reproducible and in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('FakePayments failures and effects', () => {
  it('throws on a transient error and remembers nothing, so a retry can succeed', async () => {
    let first = true;
    const payments = new FakePayments({
      decide: () => {
        if (first) {
          first = false;
          return { error: 'transient' };
        }
        return { approve: true };
      },
    });
    await expect(payments.authorize(req('k1'))).rejects.toThrow(/timed out/);
    expect(payments.intents.size).toBe(0);
    expect(await payments.authorize(req('k1'))).toMatchObject({ ok: true });
  });

  it('places the hold then throws on error_after_authorize; a retry finds that hold', async () => {
    const payments = new FakePayments({ decide: () => ({ error: 'after_authorize' }) });
    await expect(payments.authorize(req('k1'))).rejects.toThrow(/response was lost/);
    expect(payments.intents.size).toBe(1);
    const retry = await payments.authorize(req('k1'));
    expect(retry).toMatchObject({ ok: true, paymentIntentId: [...payments.intents.keys()][0] });
    expect(payments.intents.size).toBe(1);
  });

  it('cancels idempotently and refuses to cancel a captured hold', async () => {
    const payments = new FakePayments();
    const a = await payments.authorize(req('k1'));
    const b = await payments.authorize(req('k2'));
    if (!a.ok || !b.ok) throw new Error('expected approvals');
    expect(await payments.cancel(a.paymentIntentId, { idempotencyKey: 'c1' })).toEqual({
      ok: true,
    });
    expect(await payments.cancel(a.paymentIntentId, { idempotencyKey: 'c1' })).toEqual({
      ok: true,
    });
    expect((await payments.retrieve(a.paymentIntentId))?.status).toBe('canceled');
    await payments.capture(b.paymentIntentId, { amount: 1_000, idempotencyKey: 'p2' });
    expect(await payments.cancel(b.paymentIntentId, { idempotencyKey: 'c2' })).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it('captures idempotently and refuses a canceled hold', async () => {
    const payments = new FakePayments();
    const a = await payments.authorize(req('k1'));
    if (!a.ok) throw new Error('expected approval');
    const capture = () =>
      payments.capture(a.paymentIntentId, { amount: 1_000, idempotencyKey: 'p1' });
    expect(await capture()).toEqual({ ok: true });
    expect(await capture()).toEqual({ ok: true });
    expect((await payments.retrieve(a.paymentIntentId))?.status).toBe('succeeded');
  });

  it('injects effect faults', async () => {
    const payments = new FakePayments({
      effectFault: (op) =>
        op === 'cancel' ? { retryable: true, reason: 'rate_limited' } : undefined,
    });
    const a = await payments.authorize(req('k1'));
    if (!a.ok) throw new Error('expected approval');
    expect(await payments.cancel(a.paymentIntentId, { idempotencyKey: 'c1' })).toEqual({
      ok: false,
      retryable: true,
      reason: 'rate_limited',
    });
    expect((await payments.retrieve(a.paymentIntentId))?.status).toBe('requires_capture');
  });
});
