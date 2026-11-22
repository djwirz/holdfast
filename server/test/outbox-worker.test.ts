import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { outbox } from '../src/db/schema.ts';
import { MemoryPublisher } from '../src/outbox/publisher.ts';
import { runOutboxOnce } from '../src/outbox/worker.ts';
import { FakePayments, type FakePaymentsOptions } from '../src/payments/fake.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';
import { FAST_OUTBOX } from './support/settle.ts';

let testDb: TestDb;
let db: Db;
let users: string[];

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  users = await createUsers(db, 2);
});

afterAll(async () => {
  await testDb.close();
});

let keys = 0;

/** Clear the outbox so each test sees only its own rows (they share a database). */
async function freshOutbox() {
  await db.execute(sql`delete from outbox`);
}

/** An auction where the first bid was outbid: one cancel_hold and two publish rows. */
async function outbidHistory(options: FakePaymentsOptions = {}) {
  await freshOutbox();
  const payments = new FakePayments(options);
  const auction = await openAuction(db);
  const deps = { db, payments };
  const first = await placeBid(deps, {
    auctionId: auction.id,
    userId: users[0] ?? '',
    amount: 2_000,
    idempotencyKey: `ow-${String(++keys)}`,
  });
  await placeBid(deps, {
    auctionId: auction.id,
    userId: users[1] ?? '',
    amount: 2_100,
    idempotencyKey: `ow-${String(++keys)}`,
  });
  return { payments, first, publisher: new MemoryPublisher() };
}

describe('runOutboxOnce', () => {
  it('cancels the outbid hold once and publishes both events', async () => {
    const { payments, first, publisher } = await outbidHistory();
    const result = await runOutboxOnce({ db, payments, publisher }, FAST_OUTBOX);

    expect(result).toEqual({ claimed: 3, done: 3, retried: 0, failed: 0 });
    expect((await payments.retrieve(first.paymentIntentId ?? ''))?.status).toBe('canceled');
    expect(payments.cancelCalls.get(`cancel_hold:${first.id}:1`)).toBe(1);
    expect(publisher.events.map((e) => e.event)).toEqual(['bid.accepted', 'bid.accepted']);
    expect(await runOutboxOnce({ db, payments, publisher }, FAST_OUTBOX)).toMatchObject({
      claimed: 0,
    });
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    let failures = 2;
    const { payments, first, publisher } = await outbidHistory({
      effectFault: () => (failures-- > 0 ? { retryable: true, reason: 'rate_limited' } : undefined),
    });
    const deps = { db, payments, publisher };
    expect(await runOutboxOnce(deps, FAST_OUTBOX)).toMatchObject({ retried: 1 });
    const [row] = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));
    expect(row).toMatchObject({ attempts: 1, lastError: 'rate_limited', doneAt: null });

    for (
      let i = 0;
      i < 20 && (await payments.retrieve(first.paymentIntentId ?? ''))?.status !== 'canceled';
      i++
    ) {
      await new Promise((r) => setTimeout(r, 25));
      await runOutboxOnce(deps, FAST_OUTBOX);
    }
    expect((await payments.retrieve(first.paymentIntentId ?? ''))?.status).toBe('canceled');
    const [after] = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));
    expect(after).toMatchObject({ attempts: 3, lastError: null });
    expect(after?.doneAt).not.toBeNull();
  });

  it('marks a permanent failure failed and never retries it', async () => {
    const { payments, publisher } = await outbidHistory({
      effectFault: () => ({ retryable: false, reason: 'not_found' }),
    });
    const deps = { db, payments, publisher };
    expect(await runOutboxOnce(deps, FAST_OUTBOX)).toMatchObject({ failed: 1, done: 2 });
    const [row] = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));
    expect(row?.failedAt).not.toBeNull();
    expect(row?.lastError).toBe('not_found');
    await new Promise((r) => setTimeout(r, 30));
    expect(await runOutboxOnce(deps, FAST_OUTBOX)).toMatchObject({ claimed: 0 });
  });

  it('gives up after max attempts', async () => {
    const { payments, publisher } = await outbidHistory({
      effectFault: () => ({ retryable: true, reason: 'still_down' }),
    });
    const deps = { db, payments, publisher };
    for (let i = 0; i < 10; i++) {
      await runOutboxOnce(deps, { ...FAST_OUTBOX, maxAttempts: 3 });
      await new Promise((r) => setTimeout(r, 25));
    }
    const [row] = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));
    expect(row).toMatchObject({ attempts: 3, lastError: 'still_down' });
    expect(row?.failedAt).not.toBeNull();
  });

  it('lets two workers drain 100 rows with each effect done exactly once', async () => {
    await freshOutbox();
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const rows = [];
    for (let i = 0; i < 100; i++) {
      const bidId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const auth = await payments.authorize({
        idempotencyKey: bidId,
        userId: 'u',
        amount: 1_000 as never,
        metadata: { bidId, auctionId: auction.id },
      });
      if (!auth.ok) throw new Error('expected approval');
      rows.push({
        kind: 'cancel_hold' as const,
        payload: { paymentIntentId: auth.paymentIntentId, bidId, auctionId: auction.id },
      });
    }
    await db.insert(outbox).values(rows);
    const deps = { db, payments, publisher: new MemoryPublisher() };
    const drain = async () => {
      while ((await runOutboxOnce(deps, { ...FAST_OUTBOX, batch: 7 })).claimed > 0) {
        /* keep going */
      }
    };
    await Promise.all([drain(), drain()]);

    expect([...payments.cancelCalls.values()]).toEqual(Array.from({ length: 100 }, () => 1));
    expect([...payments.intents.values()].every((i) => i.status === 'canceled')).toBe(true);
  });

  it("reclaims a dead worker's rows once their lease runs out", async () => {
    const { payments, first, publisher } = await outbidHistory();
    // A worker claims everything with a short lease, then dies without doing anything.
    await db.execute(sql`
      update outbox set available_at = clock_timestamp() + interval '200 milliseconds',
                        attempts = attempts + 1
       where done_at is null`);
    const deps = { db, payments, publisher };
    expect(await runOutboxOnce(deps, FAST_OUTBOX)).toMatchObject({ claimed: 0 });
    await new Promise((r) => setTimeout(r, 250));
    expect(await runOutboxOnce(deps, FAST_OUTBOX)).toMatchObject({ claimed: 3, done: 3 });
    expect((await payments.retrieve(first.paymentIntentId ?? ''))?.status).toBe('canceled');
  });
});
