// The storm (spec §10): a few hundred near-simultaneous bids on one auction through the
// real placeBid, with random authorization latency, declines, retried keys and bids that
// straddle ends_at. The invariant checker must report zero violations.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Bid, IdempotencyConflictError, placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { bids } from '../src/db/schema.ts';
import { checkInvariants } from '../src/invariants.ts';
import { FakePayments, seededRandom } from '../src/payments/fake.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';

const BIDDERS = 20;
const REQUESTS = 300;
const ENDS_IN_MS = 1_500;
const FIRE_WINDOW_MS = 2_000; // a quarter of the storm lands after ends_at
const MAX_LATENCY_MS = 80;
const DECLINE_RATE = 0.03;
const RETRY_RATE = 0.1;

const seed = Number(process.env['STORM_SEED'] ?? Math.floor(Math.random() * 2 ** 31));

let testDb: TestDb;
let db: Db;
let bidders: string[];

beforeAll(async () => {
  // The pool caps concurrency at the database, as a real server's would.
  testDb = await freshDb({ max: 20 });
  db = testDb.db;
  bidders = await createUsers(db, BIDDERS);
});

afterAll(async () => {
  await testDb.close();
});

interface Request {
  userId: string;
  amount: number;
  idempotencyKey: string;
  retryOf?: { amount: number };
}

type Outcome = { request: Request; bid: Bid } | { request: Request; conflict: true };

describe(`bid storm (STORM_SEED=${String(seed)})`, () => {
  it('leaves zero invariant violations', async () => {
    const random = seededRandom(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
    const payments = new FakePayments({
      latency: () => Math.floor(random() * MAX_LATENCY_MS),
      decide: () =>
        random() < DECLINE_RATE ? { approve: false, reason: 'card_declined' } : { approve: true },
    });
    const auction = await openAuction(db, {
      startsIn: -1_000,
      endsIn: ENDS_IN_MS,
      startingPrice: 1_000,
      minIncrement: 100,
    });

    // Bidders act on a stale view of the price, as real clients do, so many bids tie or
    // fall short by the time they reach the lock.
    let observedHigh: number | null = null;
    const issued: Request[] = [];
    const outcomes: Outcome[] = [];

    const send = async (request: Request): Promise<void> => {
      try {
        const bid = await placeBid(
          { db, payments },
          {
            auctionId: auction.id,
            userId: request.userId,
            amount: request.amount,
            idempotencyKey: request.idempotencyKey,
          },
        );
        if (bid.status === 'accepted') observedHigh = Math.max(observedHigh ?? 0, bid.amount);
        outcomes.push({ request, bid });
      } catch (e) {
        if (!(e instanceof IdempotencyConflictError)) throw e;
        outcomes.push({ request, conflict: true });
      }
    };

    const tasks = Array.from({ length: REQUESTS }, (_, i) => {
      const fireAt = random() * FIRE_WINDOW_MS;
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          // Decided at fire time: only requests already sent can be retried.
          const original = issued.length > 0 && random() < RETRY_RATE ? pick(issued) : undefined;
          let request: Request;
          if (original) {
            // A retry: usually identical (must dedupe), sometimes a changed amount (must conflict).
            const changed = random() < 0.3;
            request = {
              ...original,
              amount: changed ? original.amount + 100 : original.amount,
              retryOf: { amount: original.amount },
            };
          } else {
            const minimum = observedHigh === null ? 1_000 : observedHigh + 100;
            request = {
              userId: pick(bidders),
              amount: minimum + pick([0, 0, 0, 100, 200]),
              idempotencyKey: `storm-${String(i)}`,
            };
            issued.push(request);
          }
          send(request).then(resolve, reject);
        }, fireAt);
      });
    });
    await Promise.all(tasks);

    const violations = await checkInvariants(db, payments, {
      auctionId: auction.id,
      audit: payments,
    });
    expect(violations, `STORM_SEED=${String(seed)}`).toEqual([]);

    // Every request reached an expected outcome. Requests sharing a key are judged as a
    // group: whichever claims the key first proceeds, even if it was fired second (both
    // wait on the pool). The others see that bid, possibly still pending, or a conflict if
    // their amount differs from the claimer's.
    const byKey = new Map<string, Outcome[]>();
    for (const o of outcomes) {
      byKey.set(o.request.idempotencyKey, [...(byKey.get(o.request.idempotencyKey) ?? []), o]);
    }
    for (const group of byKey.values()) {
      const amounts = new Set(group.map((o) => o.request.amount));
      for (const o of group) {
        if ('conflict' in o) {
          expect(
            amounts.size,
            'a conflict needs a differing amount on the same key',
          ).toBeGreaterThan(1);
        } else if (group.length > 1) {
          expect(['pending', 'accepted', 'outbid', 'lost_race', 'rejected']).toContain(
            o.bid.status,
          );
        } else {
          expect(['accepted', 'outbid', 'lost_race', 'rejected']).toContain(o.bid.status);
        }
      }
    }

    // Non-triviality: a storm that never raced, never ended and never retried proves nothing.
    const rows = await db.select().from(bids).where(eq(bids.auctionId, auction.id));
    const count = (pred: (b: Bid) => boolean) => rows.filter(pred).length;
    // With every request finished, nothing may be left pending.
    expect(count((b) => b.status === 'pending')).toBe(0);
    const everAccepted = count((b) => ['accepted', 'outbid'].includes(b.status));
    const lostRaces = count((b) => b.status === 'lost_race');
    const endedRefusals = count((b) => b.reason === 'ended');
    const dedupedRetries = outcomes.filter(
      (o) => 'bid' in o && o.request.retryOf && o.request.amount === o.request.retryOf.amount,
    ).length;
    const summary = {
      seed,
      everAccepted,
      lostRaces,
      endedRefusals,
      dedupedRetries,
      bids: rows.length,
    };
    expect(everAccepted, JSON.stringify(summary)).toBeGreaterThanOrEqual(5);
    expect(lostRaces, JSON.stringify(summary)).toBeGreaterThanOrEqual(1);
    expect(endedRefusals, JSON.stringify(summary)).toBeGreaterThanOrEqual(1);
    expect(dedupedRetries, JSON.stringify(summary)).toBeGreaterThanOrEqual(1);
    console.log('storm', summary);
  });
});
