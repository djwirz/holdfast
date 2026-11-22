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
