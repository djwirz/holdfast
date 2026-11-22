import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuction } from '../src/auctions.ts';
import { placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { auctions, bids, outbox } from '../src/db/schema.ts';
import { checkInvariants } from '../src/invariants.ts';
import { tickLifecycleOnce } from '../src/lifecycle.ts';
import { FakePayments, type FakePaymentsOptions } from '../src/payments/fake.ts';
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
const bidOn = (payments: FakePayments, auctionId: string, user: number, amount: number) =>
  placeBid(
    { db, payments },
    { auctionId, userId: users[user] ?? '', amount, idempotencyKey: `lc-${String(++keys)}` },
  );

async function auctionRow(id: string) {
  const [row] = await db.select().from(auctions).where(eq(auctions.id, id));
  if (!row) throw new Error('no auction');
  return row;
}

/** An auction that has two bids and then ends; ends_at is moved into the past directly. */
async function endedWithBids(options: FakePaymentsOptions = {}) {
  const payments = new FakePayments(options);
  const auction = await openAuction(db);
  await bidOn(payments, auction.id, 0, 2_000);
  const winner = await bidOn(payments, auction.id, 1, 2_100);
  // End it just after the last accept: in the past, but after every accepted bid.
  await db
    .update(auctions)
    .set({
      endsAt: sql`(select max(resolved_at) from bids where auction_id = ${auction.id}) + interval '1 millisecond'`,
    })
    .where(eq(auctions.id, auction.id));
  return { payments, auction, winner };
}

describe('tickLifecycleOnce', () => {
  it('opens a scheduled auction once it starts', async () => {
    const now = Date.now();
    const scheduled = await createAuction(db, {
      title: 'Scheduled',
      startsAt: new Date(now - 1_000),
      endsAt: new Date(now + 60_000),
      startingPrice: 1_000,
      minIncrement: 100,
    });
    const later = await createAuction(db, {
      title: 'Later',
      startsAt: new Date(now + 60_000),
      endsAt: new Date(now + 120_000),
      startingPrice: 1_000,
      minIncrement: 100,
    });
    await tickLifecycleOnce({ db });
    expect((await auctionRow(scheduled.id)).status).toBe('open');
    expect((await auctionRow(later.id)).status).toBe('scheduled');
  });

  it('closes with a winner, queues the capture, and settles once it is captured', async () => {
    const { payments, auction, winner } = await endedWithBids();
    await tickLifecycleOnce({ db });

    const closed = await auctionRow(auction.id);
    expect(closed).toMatchObject({ status: 'closed', version: 3, currentHighBidId: winner.id });
    const [won] = await db.select().from(bids).where(eq(bids.id, winner.id));
    expect(won?.status).toBe('won');
    expect(await checkInvariants(db, payments, { auctionId: auction.id, audit: payments })).toEqual(
      [],
    );

    await settle({ db, payments });
    expect((await auctionRow(auction.id)).status).toBe('settled');
    expect((await payments.retrieve(winner.paymentIntentId ?? ''))?.status).toBe('succeeded');
    expect(
      await checkInvariants(db, payments, {
        auctionId: auction.id,
        audit: payments,
        outboxIdle: true,
      }),
    ).toEqual([]);
  });

  it('settles an auction with no bids at once', async () => {
    const auction = await openAuction(db, { startsIn: -2_000, endsIn: -1_000 });
    await tickLifecycleOnce({ db });
    expect(await auctionRow(auction.id)).toMatchObject({ status: 'settled', version: 1 });
  });

  it('leaves the auction closed, with a failed outbox row, when capture fails (spec §7)', async () => {
    const { payments, auction } = await endedWithBids({
      effectFault: (op) => (op === 'capture' ? { retryable: false, reason: 'expired' } : undefined),
    });
    await tickLifecycleOnce({ db });
    await settle({ db, payments });

    expect((await auctionRow(auction.id)).status).toBe('closed');
    const failed = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.kind} = 'capture' and ${outbox.payload}->>'auctionId' = ${auction.id}`);
    expect(failed[0]?.failedAt).not.toBeNull();
    expect(failed[0]?.lastError).toBe('expired');
    // Still consistent: closed, the winner's hold still held, everyone else's released.
    expect(
      await checkInvariants(db, payments, {
        auctionId: auction.id,
        audit: payments,
        outboxIdle: true,
      }),
    ).toEqual([]);
  });

  it('makes a bid that commits after the close lose', async () => {
    const payments = new FakePayments({ latency: () => 400 });
    const auction = await openAuction(db, { endsIn: 200 });
    const late = bidOn(payments, auction.id, 0, 2_000);
    await new Promise((r) => setTimeout(r, 250));
    await tickLifecycleOnce({ db });
    const bid = await late;

    expect(bid.status).toBe('lost_race');
    expect(['ended', 'not_open']).toContain(bid.reason);
    expect(await auctionRow(auction.id)).toMatchObject({ status: 'settled' });
    await settle({ db, payments });
    expect(
      await checkInvariants(db, payments, {
        auctionId: auction.id,
        audit: payments,
        outboxIdle: true,
      }),
    ).toEqual([]);
  });
});
