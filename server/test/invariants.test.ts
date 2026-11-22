// The checker must catch each kind of violation, or the storm's "zero violations" means
// nothing. Each case builds a valid history, confirms it's clean, corrupts one thing, and
// expects violations of exactly that invariant.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Bid, placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { auctions, bids, outbox } from '../src/db/schema.ts';
import { type Violation, checkInvariants } from '../src/invariants.ts';
import { FakePayments } from '../src/payments/fake.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';

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

/** Three accepted bids: 2000, 2100, 2200, alternating bidders. */
async function validHistory() {
  const payments = new FakePayments();
  const auction = await openAuction(db);
  const placed: Bid[] = [];
  for (const [i, amount] of [2_000, 2_100, 2_200].entries()) {
    placed.push(
      await placeBid(
        { db, payments },
        {
          auctionId: auction.id,
          userId: users[i % 2] ?? '',
          amount,
          idempotencyKey: `inv-${String(++keys)}`,
        },
      ),
    );
  }
  const [b1, b2, b3] = placed;
  if (!b1 || !b2 || !b3) throw new Error('history not built');
  const check = () => checkInvariants(db, payments, { auctionId: auction.id, audit: payments });
  expect(await check()).toEqual([]);
  return { auction, payments, b1, b2, b3, check };
}

function onlyInvariant(violations: Violation[], invariant: Violation['invariant']) {
  expect(violations.length).toBeGreaterThan(0);
  expect(violations.map((v) => v.invariant)).toEqual(violations.map(() => invariant));
}

describe('checkInvariants catches', () => {
  it('1: an accepted bid whose hold is missing', async () => {
    const h = await validHistory();
    h.payments.intents.delete(h.b3.paymentIntentId ?? '');
    onlyInvariant(await h.check(), 1);
  });

  it('1: an accepted bid whose hold is smaller than the bid', async () => {
    const h = await validHistory();
    const intent = h.payments.intents.get(h.b2.paymentIntentId ?? '');
    if (!intent) throw new Error('no intent');
    h.payments.intents.set(intent.id, { ...intent, amount: 2_099 });
    onlyInvariant(await h.check(), 1);
  });

  it('2: an increment smaller than min_increment', async () => {
    const h = await validHistory();
    await db.update(bids).set({ amount: 2_050 }).where(eq(bids.id, h.b2.id));
    onlyInvariant(await h.check(), 2);
  });

  it('2: a gap in auction versions', async () => {
    const h = await validHistory();
    await db.update(bids).set({ auctionVersion: 4 }).where(eq(bids.id, h.b3.id));
    onlyInvariant(await h.check(), 2);
  });

  it('2: two bids both marked accepted', async () => {
    const h = await validHistory();
    await db.update(bids).set({ status: 'accepted' }).where(eq(bids.id, h.b2.id));
    onlyInvariant(await h.check(), 2);
  });

  it('2: current_high_bid_id pointing at an older bid', async () => {
    const h = await validHistory();
    await db
      .update(auctions)
      .set({ currentHighBidId: h.b2.id })
      .where(eq(auctions.id, h.auction.id));
    const violations = await h.check();
    // The stale pointer also makes b2's queued cancel look wrong (4); 2 must be among them.
    expect(violations.some((v) => v.invariant === 2)).toBe(true);
  });

  it('3: a bid accepted at or after ends_at', async () => {
    const h = await validHistory();
    await db
      .update(auctions)
      .set({ endsAt: h.b3.resolvedAt ?? new Date() })
      .where(eq(auctions.id, h.auction.id));
    onlyInvariant(await h.check(), 3);
  });

  it('4: an outbid hold never queued for cancellation', async () => {
    const h = await validHistory();
    await db
      .delete(outbox)
      .where(and(eq(outbox.kind, 'cancel_hold'), sql`${outbox.payload}->>'bidId' = ${h.b1.id}`));
    onlyInvariant(await h.check(), 4);
  });

  it("4: the current high's hold queued for cancellation", async () => {
    const h = await validHistory();
    await db.insert(outbox).values({
      kind: 'cancel_hold',
      payload: { paymentIntentId: h.b3.paymentIntentId, bidId: h.b3.id, auctionId: h.auction.id },
    });
    onlyInvariant(await h.check(), 4);
  });

  it('5: a bid sent to authorize twice', async () => {
    const h = await validHistory();
    h.payments.callsByKey.set(h.b1.id, 2);
    onlyInvariant(await h.check(), 5);
  });

  it('5 is also enforced by the database: one PaymentIntent can never belong to two bids', async () => {
    const h = await validHistory();
    await expect(
      db.update(bids).set({ paymentIntentId: h.b2.paymentIntentId }).where(eq(bids.id, h.b1.id)),
    ).rejects.toThrow();
  });
});
