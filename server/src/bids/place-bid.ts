// The bid flow (ADR 0002): claim the idempotency key, authorize the hold outside any lock,
// then decide under the auction row lock. Commit order is bid order.
import { type AuctionState, type Cents, checkBid, isCents } from '@holdfast/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auctions, bids, outbox } from '../db/schema.ts';
import { type AuthorizeResult, type Payments, TransientPaymentsError } from '../payments/port.ts';

export type Bid = typeof bids.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface PlaceBidDeps {
  db: Db;
  payments: Payments;
  /**
   * Test-only fault injection. Nothing in production sets it. `afterAuthorize` may throw
   * a SimulatedCrash to stand in for the process dying between hold and commit (spec §7).
   */
  faults?: { afterAuthorize?: (bid: Bid) => void };
  /** Errors from work still running after the deadline returned the bid as pending. */
  onBackgroundError?: (e: unknown) => void;
}

export interface PlaceBidOptions {
  /**
   * How long to wait for the hold and the decision before returning the bid as `pending`
   * (spec §6). The work carries on; if this process dies, the reconciler finishes it.
   */
  deadlineMs?: number;
}

/** Thrown by a test's fault hook to simulate the process dying mid-bid. */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash between hold and commit');
    this.name = 'SimulatedCrash';
  }
}

export interface PlaceBidInput {
  auctionId: string;
  userId: string;
  amount: number;
  idempotencyKey: string;
}

export class AuctionNotFoundError extends Error {
  constructor(auctionId: string) {
    super(`auction ${auctionId} not found`);
    this.name = 'AuctionNotFoundError';
  }
}

/** The key was already used by this user for a different bid (a 422 at the HTTP layer). */
export class IdempotencyConflictError extends Error {
  readonly existing: Bid;

  constructor(existing: Bid) {
    super(`idempotency key already used for bid ${existing.id}`);
    this.name = 'IdempotencyConflictError';
    this.existing = existing;
  }
}

// A type alias, not an interface: db.execute<T> needs an index-signature-compatible type.
type AuctionRow = {
  status: AuctionState['status'];
  startsAtMs: number;
  endsAtMs: number;
  startingPrice: number;
  minIncrement: number;
  version: number;
  currentHighBidId: string | null;
  currentHigh: number | null;
};

function toState(row: AuctionRow): AuctionState {
  return {
    status: row.status,
    startsAt: new Date(row.startsAtMs),
    endsAt: new Date(row.endsAtMs),
    startingPrice: row.startingPrice as Cents,
    minIncrement: row.minIncrement as Cents,
    currentHigh: row.currentHigh as Cents | null,
  };
}

// Raw execute() returns timestamps as strings, so times come back as epoch milliseconds.
// Rounding down never moves a time at or after ends_at (whole ms) to before it.
const AUCTION_COLUMNS = sql`
  a.status,
  floor(extract(epoch from a.starts_at) * 1000)::float8 as "startsAtMs",
  floor(extract(epoch from a.ends_at) * 1000)::float8 as "endsAtMs",
  a.starting_price as "startingPrice", a.min_increment as "minIncrement",
  a.version::float8 as "version", a.current_high_bid_id as "currentHighBidId"`;

async function currentHighAmount(db: Db | Tx, bidId: string | null): Promise<number | null> {
  if (bidId === null) return null;
  const [row] = await db.select({ amount: bids.amount }).from(bids).where(eq(bids.id, bidId));
  return row?.amount ?? null;
}

async function dbNow(db: Db | Tx): Promise<Date> {
  // clock_timestamp(), not now(): now() is fixed at the start of the transaction, and the
  // decision must use the time after the lock was granted (invariant 3).
  const result = await db.execute<{ ms: number }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as ms`,
  );
  const ms = result.rows[0]?.ms;
  if (ms === undefined) throw new Error('no database time');
  return new Date(ms);
}

export async function placeBid(
  deps: PlaceBidDeps,
  input: PlaceBidInput,
  options: PlaceBidOptions = {},
): Promise<Bid> {
  const { db } = deps;
  if (!isCents(input.amount)) {
    // The column is an integer: a malformed amount can't be stored, so it can't be claimed.
    throw new RangeError(`not a valid amount in cents: ${String(input.amount)}`);
  }
  const amount = input.amount;

  // 1. Pre-check without a lock, against database time, then claim the idempotency key.
  const pre = await db.execute<AuctionRow>(
    sql`select ${AUCTION_COLUMNS} from auctions a where a.id = ${input.auctionId}`,
  );
  const auctionRow = pre.rows[0];
  if (!auctionRow) throw new AuctionNotFoundError(input.auctionId);
  auctionRow.currentHigh = await currentHighAmount(db, auctionRow.currentHighBidId);
  const preCheck = checkBid(toState(auctionRow), amount, await dbNow(db));

  const [claimed] = await db
    .insert(bids)
    .values({
      auctionId: input.auctionId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      amount,
      ...(preCheck.ok
        ? {}
        : {
            status: 'rejected' as const,
            reason: preCheck.reason,
            resolvedAt: sql`clock_timestamp()`,
          }),
    })
    .onConflictDoNothing({ target: [bids.userId, bids.idempotencyKey] })
    .returning();

  if (!claimed) {
    // A retry (or a concurrent duplicate). Only the request that inserted the row goes on,
    // so the same key never authorizes twice (invariant 5).
    const [existing] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.userId, input.userId), eq(bids.idempotencyKey, input.idempotencyKey)));
    if (!existing) throw new Error('idempotency key conflict but no existing bid');
    if (existing.auctionId !== input.auctionId || existing.amount !== amount) {
      throw new IdempotencyConflictError(existing);
    }
    return existing;
  }
  if (claimed.status === 'rejected') return claimed;

  // Steps 2 and 3 may outlast the deadline. A transient payment error or a crash leaves the
  // bid pending, which is the reconciler's job, not an error for the bidder.
  const work = resumeBid(deps, claimed).catch(async (e: unknown) => {
    if (e instanceof TransientPaymentsError || e instanceof SimulatedCrash) {
      return current(db, claimed.id);
    }
    throw e;
  });
  if (options.deadlineMs === undefined) return work;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => {
      resolve('deadline');
    }, options.deadlineMs);
  });
  const first = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (first !== 'deadline') return first;
  work.catch(deps.onBackgroundError ?? (() => undefined));
  return current(db, claimed.id);
}

/**
 * Steps 2 and 3 for a pending bid: authorize with the bid id as the idempotency key, then
 * decide under the lock. The reconciler calls this for stale pending bids: the payment
 * provider replays the original authorization for the same key, so a hold placed before a
 * crash is found, never duplicated.
 */
export async function resumeBid(deps: PlaceBidDeps, bid: Bid): Promise<Bid> {
  const { db, payments } = deps;
  // 2. Authorize outside any transaction or lock: a slow card never blocks other bidders.
  const auth = await payments.authorize({
    idempotencyKey: bid.id,
    userId: bid.userId,
    amount: bid.amount as Cents,
    metadata: { bidId: bid.id, auctionId: bid.auctionId },
  });

  if (!auth.ok) {
    return resolvePending(db, bid, {
      status: 'rejected',
      reason: auth.reason,
      resolvedAt: await dbNow(db),
    });
  }
  // Saved before the decision, so a crash from here on leaves a hold the reconciler can find.
  await db
    .update(bids)
    .set({ paymentIntentId: auth.paymentIntentId })
    .where(and(eq(bids.id, bid.id), eq(bids.status, 'pending')));
  const withIntent = { ...bid, paymentIntentId: auth.paymentIntentId };
  deps.faults?.afterAuthorize?.(withIntent);

  // 3. Decide under the auction row lock.
  return db.transaction((tx) => decide(tx, withIntent, auth));
}

async function decide(
  tx: Tx,
  bid: Bid,
  auth: Extract<AuthorizeResult, { ok: true }>,
): Promise<Bid> {
  const locked = await tx.execute<AuctionRow>(
    sql`select ${AUCTION_COLUMNS} from auctions a where a.id = ${bid.auctionId} for update`,
  );
  const auction = locked.rows[0];
  if (!auction) throw new AuctionNotFoundError(bid.auctionId);
  auction.currentHigh = await currentHighAmount(tx, auction.currentHighBidId);
  const now = await dbNow(tx);

  const rules = checkBid(toState(auction), bid.amount, now);
  // Invariant 1 in code, not only in tests: never accept without a hold covering the amount.
  // (The port's type already guarantees status requires_capture on success.)
  const covered = auth.amountCapturable >= bid.amount;

  if (!rules.ok || !covered) {
    const [lost] = await tx
      .update(bids)
      .set({
        status: 'lost_race',
        reason: rules.ok ? 'not_covered' : rules.reason,
        resolvedAt: now,
      })
      .where(and(eq(bids.id, bid.id), eq(bids.status, 'pending')))
      .returning();
    // Only the call that resolved the bid queues its cancellation. If the handler and the
    // reconciler both decide it, the second sees no pending row and must add nothing.
    if (!lost) return current(tx, bid.id);
    await tx.insert(outbox).values(cancelHold(bid, auth.paymentIntentId));
    return lost;
  }

  const version = auction.version + 1;
  const [accepted] = await tx
    .update(bids)
    .set({ status: 'accepted', auctionVersion: version, resolvedAt: now })
    .where(and(eq(bids.id, bid.id), eq(bids.status, 'pending')))
    .returning();
  // Zero rows: something else (the reconciler, from slice 3) already resolved this bid.
  if (!accepted) return current(tx, bid.id);

  const previousHighId = auction.currentHighBidId;
  if (previousHighId !== null) {
    const [previous] = await tx
      .update(bids)
      .set({ status: 'outbid' })
      .where(and(eq(bids.id, previousHighId), eq(bids.status, 'accepted')))
      .returning();
    if (previous?.paymentIntentId) {
      await tx.insert(outbox).values(cancelHold(previous, previous.paymentIntentId));
    }
  }
  await tx
    .update(auctions)
    .set({ version, currentHighBidId: bid.id })
    .where(eq(auctions.id, bid.auctionId));
  await tx.insert(outbox).values({
    kind: 'publish',
    payload: {
      event: 'bid.accepted',
      auctionId: bid.auctionId,
      version,
      bidId: bid.id,
      amount: bid.amount,
      traceparent: null,
    },
  });
  return accepted;
}

function cancelHold(bid: Bid, paymentIntentId: string): typeof outbox.$inferInsert {
  return {
    kind: 'cancel_hold',
    payload: { paymentIntentId, bidId: bid.id, auctionId: bid.auctionId, traceparent: null },
  };
}

/** Resolve a bid only from pending (spec §4); if something else got there first, keep theirs. */
async function resolvePending(
  db: Db | Tx,
  bid: Bid,
  set: Partial<typeof bids.$inferInsert>,
): Promise<Bid> {
  const [row] = await db
    .update(bids)
    .set(set)
    .where(and(eq(bids.id, bid.id), eq(bids.status, 'pending')))
    .returning();
  return row ?? current(db, bid.id);
}

async function current(db: Db | Tx, bidId: string): Promise<Bid> {
  const [row] = await db.select().from(bids).where(eq(bids.id, bidId));
  if (!row) throw new Error(`bid ${bidId} vanished`);
  return row;
}
