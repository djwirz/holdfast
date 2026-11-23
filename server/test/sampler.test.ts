// The sampler behind the alerts (spec §8): which holds count as orphaned, and the outbox and
// auction numbers, against real Postgres and the fake's own record of holds.
import { cents } from '@holdfast/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { auctions, outbox } from '../src/db/schema.ts';
import { tickLifecycleOnce } from '../src/lifecycle.ts';
import { FakePayments } from '../src/payments/fake.ts';
import { sampleOnce } from '../src/sampler.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';

let testDb: TestDb;
let db: Db;
let alice: string;
let bob: string;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  [alice = '', bob = ''] = await createUsers(db, 2);
});

afterAll(async () => {
  await testDb.close();
});

let keys = 0;
const bid = (payments: FakePayments, auctionId: string, userId: string, amount: number) =>
  placeBid({ db, payments }, { auctionId, userId, amount, idempotencyKey: `s-${String(++keys)}` });

describe('the orphaned-hold check', () => {
  it("doesn't count the current high, or a hold whose cancellation was just queued", async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    await bid(payments, auction.id, alice, 1_000);
    await bid(payments, auction.id, bob, 1_100); // alice outbid: cancel queued, not yet run
    const sample = await sampleOnce({ db, payments });
    expect(sample.orphanedHolds).toEqual([]);
  });

  it('counts an outbid hold whose cancellation never happened, once the grace is over', async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    const first = await bid(payments, auction.id, alice, 1_000);
    await bid(payments, auction.id, bob, 1_100);
    // The cancellation row exists but sits undone past the grace period.
    const sample = await sampleOnce({ db, payments }, { cancelGraceMs: 0 });
    expect(sample.orphanedHolds).toEqual([first.paymentIntentId]);
  });

  it("counts a hold for a bid that doesn't exist in a known auction", async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const ghostBid = '00000000-0000-4000-8000-00000000abcd';
    const hold = await payments.authorize({
      idempotencyKey: ghostBid,
      userId: alice,
      amount: cents(2_000),
      metadata: { bidId: ghostBid, auctionId: auction.id },
    });
    if (!hold.ok) throw new Error('expected a hold');
    expect((await sampleOnce({ db, payments })).orphanedHolds).toEqual([hold.paymentIntentId]);
  });

  it("ignores holds for auctions this database doesn't know (another environment)", async () => {
    const payments = new FakePayments();
    await payments.authorize({
      idempotencyKey: 'other-env',
      userId: alice,
      amount: cents(2_000),
      metadata: { bidId: '00000000-0000-4000-8000-0000000000ff', auctionId: 'live-123' },
    });
    expect((await sampleOnce({ db, payments })).orphanedHolds).toEqual([]);
  });

  it("doesn't count a closed auction's winner while its capture is pending", async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db, { startingPrice: 1_000 });
    await bid(payments, auction.id, alice, 1_000);
    await db
      .update(auctions)
      .set({ endsAt: sql`clock_timestamp()` })
      .where(eq(auctions.id, auction.id));
    await tickLifecycleOnce({ db });
    expect((await sampleOnce({ db, payments }, { cancelGraceMs: 0 })).orphanedHolds).toEqual([]);
  });
});

describe('the outbox and auction numbers', () => {
  it('counts failed rows by kind, stale pending bids and unsettled auctions', async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db, { startingPrice: 1_000 });
    await bid(payments, auction.id, alice, 1_000);
    await db.execute(sql`
      update outbox set failed_at = clock_timestamp(), last_error = 'drill'
       where kind = 'publish' and payload->>'auctionId' = ${auction.id}`);
    // A closed auction long past its end, still waiting on its capture.
    await db
      .update(auctions)
      .set({ endsAt: sql`clock_timestamp()` })
      .where(eq(auctions.id, auction.id));
    await tickLifecycleOnce({ db });
    const sample = await sampleOnce({ db, payments }, { unsettledAfterMs: 0, staleAfterMs: 0 });
    expect(sample.outboxFailed['publish']).toBeGreaterThanOrEqual(1);
    expect(sample.unsettled).toBeGreaterThanOrEqual(1);
    expect(sample.outboxLagSeconds).toBeGreaterThanOrEqual(0);
    const rows = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.failedAt} is not null`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
