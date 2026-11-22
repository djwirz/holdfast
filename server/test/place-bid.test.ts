import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyConflictError, placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { auctions, bids, outbox } from '../src/db/schema.ts';
import { checkInvariants } from '../src/invariants.ts';
import { FakePayments, type FakePaymentsOptions } from '../src/payments/fake.ts';
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

let keyCounter = 0;
const key = () => `key-${String(++keyCounter)}`;

function setup(options: FakePaymentsOptions = {}) {
  const payments = new FakePayments(options);
  return { payments, deps: { db, payments } };
}

async function expectNoViolations(payments: FakePayments, auctionId: string) {
  expect(await checkInvariants(db, payments, { auctionId, audit: payments })).toEqual([]);
}

async function cancelHoldsFor(bidId: string) {
  const rows = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));
  return rows.filter((r) => (r.payload as { bidId: string }).bidId === bidId);
}

describe('placeBid', () => {
  it('accepts a first bid at the starting price, with a hold and a publish', async () => {
    const { payments, deps } = setup();
    const auction = await openAuction(db);
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });

    expect(bid).toMatchObject({ status: 'accepted', auctionVersion: 1, amount: 2_000 });
    expect(bid.paymentIntentId).toMatch(/^pi_fake_/);
    const [after] = await db.select().from(auctions).where(eq(auctions.id, auction.id));
    expect(after).toMatchObject({ version: 1, currentHighBidId: bid.id });
    await expectNoViolations(payments, auction.id);
  });

  it('rejects a bid below the minimum without ever authorizing', async () => {
    const { payments, deps } = setup();
    const auction = await openAuction(db);
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 1_999,
      idempotencyKey: key(),
    });

    expect(bid).toMatchObject({
      status: 'rejected',
      reason: 'below_minimum',
      paymentIntentId: null,
    });
    expect(payments.callsByKey.size).toBe(0);
  });

  it('rejects a bid on an ended auction without ever authorizing', async () => {
    const { payments, deps } = setup();
    const auction = await openAuction(db, { startsIn: -2 * 60_000, endsIn: -60_000 });
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 5_000,
      idempotencyKey: key(),
    });

    expect(bid).toMatchObject({ status: 'rejected', reason: 'ended' });
    expect(payments.callsByKey.size).toBe(0);
  });

  it('rejects a declined card with the provider reason', async () => {
    const { payments, deps } = setup({
      decide: () => ({ approve: false, reason: 'card_declined' }),
    });
    const auction = await openAuction(db);
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });

    expect(bid).toMatchObject({
      status: 'rejected',
      reason: 'card_declined',
      paymentIntentId: null,
    });
    await expectNoViolations(payments, auction.id);
  });

  it('marks the previous high outbid and queues its hold for cancellation', async () => {
    const { payments, deps } = setup();
    const auction = await openAuction(db);
    const first = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });
    const second = await placeBid(deps, {
      auctionId: auction.id,
      userId: bob,
      amount: 2_100,
      idempotencyKey: key(),
    });

    expect(second).toMatchObject({ status: 'accepted', auctionVersion: 2 });
    const [firstAfter] = await db.select().from(bids).where(eq(bids.id, first.id));
    expect(firstAfter?.status).toBe('outbid');
    const cancels = await cancelHoldsFor(first.id);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.payload).toMatchObject({ paymentIntentId: first.paymentIntentId });
    expect(await cancelHoldsFor(second.id)).toHaveLength(0);
    await expectNoViolations(payments, auction.id);
  });

  it('lets commit order decide a tie: the slower authorization loses (ADR 0002)', async () => {
    // Alice clicks first, but her card is slower, so Bob commits first at the same price.
    const { payments, deps } = setup({ latency: (r) => (r.userId === alice ? 80 : 0) });
    const auction = await openAuction(db);
    const aliceBid = placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });
    const bobBid = placeBid(deps, {
      auctionId: auction.id,
      userId: bob,
      amount: 2_000,
      idempotencyKey: key(),
    });
    const [a, b] = await Promise.all([aliceBid, bobBid]);

    expect(b).toMatchObject({ status: 'accepted', auctionVersion: 1 });
    expect(a).toMatchObject({ status: 'lost_race', reason: 'below_minimum' });
    expect(a.paymentIntentId).not.toBeNull();
    expect(await cancelHoldsFor(a.id)).toHaveLength(1);
    await expectNoViolations(payments, auction.id);
  });

  it('loses a bid whose authorization returns after ends_at, using database time', async () => {
    const { payments, deps } = setup({ latency: () => 600 });
    const auction = await openAuction(db, { endsIn: 300 });
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });

    expect(bid).toMatchObject({ status: 'lost_race', reason: 'ended' });
    expect(await cancelHoldsFor(bid.id)).toHaveLength(1);
    await expectNoViolations(payments, auction.id);
  });

  it('returns the same bid for a retried key and authorizes once', async () => {
    const { payments, deps } = setup();
    const auction = await openAuction(db);
    const input = { auctionId: auction.id, userId: alice, amount: 2_000, idempotencyKey: key() };
    const first = await placeBid(deps, input);
    const retry = await placeBid(deps, input);

    expect(retry).toEqual(first);
    expect(payments.callsByKey.get(first.id)).toBe(1);
    expect(payments.intents.size).toBe(1);
  });

  it('refuses a reused key with a different amount', async () => {
    const { deps } = setup();
    const auction = await openAuction(db);
    const k = key();
    await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: k,
    });

    await expect(
      placeBid(deps, { auctionId: auction.id, userId: alice, amount: 2_500, idempotencyKey: k }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('makes one bid and one hold from two concurrent requests with the same key', async () => {
    const { payments, deps } = setup({ latency: () => 30 });
    const auction = await openAuction(db);
    const input = { auctionId: auction.id, userId: alice, amount: 2_000, idempotencyKey: key() };
    const [a, b] = await Promise.all([placeBid(deps, input), placeBid(deps, input)]);

    expect(a.id).toBe(b.id);
    const rows = await db.select().from(bids).where(eq(bids.auctionId, auction.id));
    expect(rows).toHaveLength(1);
    expect(payments.intents.size).toBe(1);
    await expectNoViolations(payments, auction.id);
  });
});

describe('placeBid deadline and transient errors', () => {
  it('returns pending at the deadline and resolves in the background', async () => {
    const { payments, deps } = setup({ latency: () => 150 });
    const auction = await openAuction(db);
    const bid = await placeBid(
      deps,
      { auctionId: auction.id, userId: alice, amount: 2_000, idempotencyKey: key() },
      { deadlineMs: 20 },
    );
    expect(bid.status).toBe('pending');
    await new Promise((r) => setTimeout(r, 250));
    const [after] = await db.select().from(bids).where(eq(bids.id, bid.id));
    expect(after?.status).toBe('accepted');
    await expectNoViolations(payments, auction.id);
  });

  it('leaves the bid pending when the authorization response is lost', async () => {
    const { payments, deps } = setup({ decide: () => ({ error: 'after_authorize' }) });
    const auction = await openAuction(db);
    const bid = await placeBid(deps, {
      auctionId: auction.id,
      userId: alice,
      amount: 2_000,
      idempotencyKey: key(),
    });
    expect(bid).toMatchObject({ status: 'pending', paymentIntentId: null });
    expect(payments.intents.size).toBe(1); // a live hold the reconciler must find
  });
});
