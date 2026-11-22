// The shared Stripe fake over HTTP: the same behavior as the in-process fake, reachable from
// every instance. The first test is the bug it fixes: with a fake per process, a hold placed
// through one instance couldn't be released through another.
import { cents } from '@holdfast/shared';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePayments } from '../src/payments/fake.ts';
import { fakeStripeServer, listen } from '../src/payments/fake-server.ts';
import { HttpFakePayments } from '../src/payments/http-fake.ts';
import { TransientPaymentsError } from '../src/payments/port.ts';

const req = (key: string, amount = 1_500) => ({
  idempotencyKey: key,
  userId: 'u1',
  amount: cents(amount),
  metadata: { bidId: key, auctionId: 'a1' },
});

let server: Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (!s) return;
  // fetch keeps connections alive; without this, close() waits on them forever.
  s.closeAllConnections();
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
});

async function shared(fake = new FakePayments()) {
  server = fakeStripeServer(fake);
  const port = await listen(server, 0);
  const url = `http://127.0.0.1:${String(port)}`;
  // Two clients: two server instances pointing at the one fake.
  return { a: new HttpFakePayments(url), b: new HttpFakePayments(url), fake };
}

describe('per-process fakes (why the shared one exists)', () => {
  it('lose a hold placed through the other instance', async () => {
    const instanceA = new FakePayments();
    const instanceB = new FakePayments();
    const hold = await instanceA.authorize(req('k1'));
    if (!hold.ok) throw new Error('expected a hold');
    expect(await instanceB.cancel(hold.paymentIntentId, { idempotencyKey: 'c1' })).toEqual({
      ok: false,
      reason: 'not_found',
      retryable: false,
    });
    // ...and the hold stays open: an orphan (invariant 4).
    expect((await instanceA.retrieve(hold.paymentIntentId))?.status).toBe('requires_capture');
  });
});

describe('the shared fake', () => {
  it('releases through one instance a hold placed through the other', async () => {
    const { a, b } = await shared();
    const hold = await a.authorize(req('k1'));
    if (!hold.ok) throw new Error('expected a hold');
    expect(await b.cancel(hold.paymentIntentId, { idempotencyKey: 'c1' })).toEqual({ ok: true });
    expect((await a.retrieve(hold.paymentIntentId))?.status).toBe('canceled');
  });

  it('captures, replays keys, and audits every intent', async () => {
    const { a, b } = await shared();
    const first = await a.authorize(req('k2', 2_000));
    expect(await b.authorize(req('k2', 2_000))).toEqual(first);
    if (!first.ok) throw new Error('expected a hold');
    expect(await b.capture(first.paymentIntentId, { amount: 2_000, idempotencyKey: 'p1' })).toEqual(
      { ok: true },
    );
    const audit = await a.audit();
    expect([...audit.intents.values()].map((i) => i.status)).toEqual(['succeeded']);
    expect(await a.retrieve('pi_missing')).toBeNull();
  });

  it('turns a lost response into a transient error, and the retry finds the hold', async () => {
    const { a, b } = await shared(
      new FakePayments({ decide: () => ({ error: 'after_authorize' }) }),
    );
    await expect(a.authorize(req('k3'))).rejects.toBeInstanceOf(TransientPaymentsError);
    const retry = await b.authorize(req('k3'));
    expect(retry).toMatchObject({ ok: true });
    expect((await a.audit()).intents.size).toBe(1);
  });

  it('declines as an answer, not an error', async () => {
    const { a } = await shared(
      new FakePayments({ decide: () => ({ approve: false, reason: 'card_declined' }) }),
    );
    expect(await a.authorize(req('k4'))).toEqual({ ok: false, reason: 'card_declined' });
  });

  it('treats an unreachable fake as transient: the bid waits, the effect retries', async () => {
    const down = new HttpFakePayments('http://127.0.0.1:1');
    await expect(down.authorize(req('k5'))).rejects.toBeInstanceOf(TransientPaymentsError);
    expect(await down.cancel('pi_x', { idempotencyKey: 'c' })).toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});
