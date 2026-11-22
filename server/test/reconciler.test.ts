import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PlaceBidDeps, SimulatedCrash, placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { bids, outbox } from '../src/db/schema.ts';
import { checkInvariants } from '../src/invariants.ts';
import { FakePayments } from '../src/payments/fake.ts';
import { reconcileOnce } from '../src/reconciler.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';
import { settle } from './support/settle.ts';

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
const input = (auctionId: string, user: number, amount: number) => ({
  auctionId,
  userId: users[user] ?? '',
  amount,
  idempotencyKey: `rc-${String(++keys)}`,
});

const crashAfterAuthorize: PlaceBidDeps['faults'] = {
  afterAuthorize: () => {
    throw new SimulatedCrash();
  },
};

async function clean(payments: FakePayments, auctionId: string) {
  await settle({ db, payments });
  expect(
    await checkInvariants(db, payments, { auctionId, audit: payments, outboxIdle: true }),
  ).toEqual([]);
}

describe('reconcileOnce', () => {
  it('finishes a bid whose process died between hold and commit', async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const crashed = await placeBid(
      { db, payments, faults: crashAfterAuthorize },
      input(auction.id, 0, 2_000),
    );
    expect(crashed.status).toBe('pending');
    expect(crashed.paymentIntentId).not.toBeNull();

    const result = await reconcileOnce({ db, payments }, { staleAfterMs: 0 });
    expect(result).toMatchObject({ resumed: 1, stillPending: 0 });
    const [after] = await db.select().from(bids).where(eq(bids.id, crashed.id));
    expect(after).toMatchObject({ status: 'accepted', paymentIntentId: crashed.paymentIntentId });
    expect(payments.intents.size).toBe(1);
    await clean(payments, auction.id);
  });

  it('finds the hold by replaying the key when the intent id was never saved', async () => {
    let first = true;
    const payments = new FakePayments({
      decide: () => {
        if (first) {
          first = false;
          return { error: 'after_authorize' };
        }
        return { approve: true };
      },
    });
    const auction = await openAuction(db);
    const lost = await placeBid({ db, payments }, input(auction.id, 0, 2_000));
    expect(lost).toMatchObject({ status: 'pending', paymentIntentId: null });
    expect(payments.intents.size).toBe(1);

    await reconcileOnce({ db, payments }, { staleAfterMs: 0 });
    const [after] = await db.select().from(bids).where(eq(bids.id, lost.id));
    expect(after?.status).toBe('accepted');
    expect(after?.paymentIntentId).toBe([...payments.intents.keys()][0]);
    expect(payments.intents.size).toBe(1); // found, not duplicated
    expect(payments.callsByKey.get(lost.id)).toBe(2);
    await clean(payments, auction.id);
  });

  it('leaves a young pending bid alone', async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const crashed = await placeBid(
      { db, payments, faults: crashAfterAuthorize },
      input(auction.id, 0, 2_000),
    );
    const result = await reconcileOnce({ db, payments }, { staleAfterMs: 60_000 });
    expect(result).toMatchObject({ resumed: 0, stillPending: 0 });
    const [after] = await db.select().from(bids).where(eq(bids.id, crashed.id));
    expect(after?.status).toBe('pending');
    await clean(payments, auction.id);
  });

  it('queues a cancellation that was somehow never queued', async () => {
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const outbid = await placeBid({ db, payments }, input(auction.id, 0, 2_000));
    await placeBid({ db, payments }, input(auction.id, 1, 2_100));
    await db
      .delete(outbox)
      .where(sql`${outbox.kind} = 'cancel_hold' and ${outbox.payload}->>'bidId' = ${outbid.id}`);

    const result = await reconcileOnce({ db, payments }, { staleAfterMs: 60_000 });
    expect(result.backfilledCancels).toBe(1);
    expect(
      (await reconcileOnce({ db, payments }, { staleAfterMs: 60_000 })).backfilledCancels,
    ).toBe(0);
    await clean(payments, auction.id);
  });

  it('queues one cancellation when the handler and the reconciler both lose a bid', async () => {
    // Regression: both deciders used to queue a cancel_hold for the same lost bid.
    const payments = new FakePayments({ latency: () => 120 });
    const auction = await openAuction(db, { endsIn: 60 });
    const deps = { db, payments };
    const pending = await placeBid(deps, input(auction.id, 0, 2_000), { deadlineMs: 10 });
    await reconcileOnce(deps, { staleAfterMs: 0 });
    await new Promise((r) => setTimeout(r, 200));

    const [after] = await db.select().from(bids).where(eq(bids.id, pending.id));
    expect(after).toMatchObject({ status: 'lost_race', reason: 'ended' });
    const cancels = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.kind} = 'cancel_hold' and ${outbox.payload}->>'bidId' = ${pending.id}`);
    expect(cancels).toHaveLength(1);
  });

  it('decides a bid once when the handler and the reconciler race for it', async () => {
    const payments = new FakePayments({ latency: () => 100 });
    const auction = await openAuction(db);
    const deps = { db, payments };
    const pending = await placeBid(deps, input(auction.id, 0, 2_000), { deadlineMs: 10 });
    expect(pending.status).toBe('pending');
    // The handler is still waiting on its authorization; the reconciler takes the bid too.
    await reconcileOnce(deps, { staleAfterMs: 0 });
    await new Promise((r) => setTimeout(r, 150));

    const [after] = await db.select().from(bids).where(eq(bids.id, pending.id));
    expect(after).toMatchObject({ status: 'accepted', auctionVersion: 1 });
    expect(payments.intents.size).toBe(1);
    const publishes = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.kind} = 'publish' and ${outbox.payload}->>'bidId' = ${pending.id}`);
    expect(publishes).toHaveLength(1);
    await clean(payments, auction.id);
  });
});
