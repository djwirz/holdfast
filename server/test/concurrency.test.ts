// The storm (spec §10): a few hundred near-simultaneous bids on one auction through the
// real placeBid, while two outbox workers, the lifecycle ticker and the reconciler run
// alongside, as they would on two server instances. Authorizations are slow, some decline,
// some lose their response, some hit a replayed 500, some handlers "die" between hold and commit, some cancels
// fail transiently, keys are retried and the storm straddles ends_at. Once everything is
// quiet, the checker must report zero violations of every invariant, 4 included.
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Bid,
  IdempotencyConflictError,
  SimulatedCrash,
  placeBid,
} from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { auctions, bids, outbox } from '../src/db/schema.ts';
import { checkInvariants } from '../src/invariants.ts';
import { startLifecycle } from '../src/lifecycle.ts';
import { MemoryPublisher } from '../src/outbox/publisher.ts';
import { startOutboxWorker } from '../src/outbox/worker.ts';
import { FakePayments, seededRandom } from '../src/payments/fake.ts';
import { reconcileOnce } from '../src/reconciler.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';
import { FAST_OUTBOX, settle } from './support/settle.ts';

const BIDDERS = 20;
const REQUESTS = 300;
const ENDS_IN_MS = 1_500;
const FIRE_WINDOW_MS = 2_000; // a quarter of the storm lands after ends_at
const MAX_LATENCY_MS = 80;
const DEADLINE_MS = 60; // some bids come back pending (spec §6)
const DECLINE_RATE = 0.03;
const LOST_RESPONSE_RATE = 0.06;
// Every Nth authorization gets a 500 that Stripe saves and replays for its key; half of
// them placed a hold first. Every Nth, like the crashes, so every run has some.
const SERVER_ERROR_EVERY = 15;
// Only a few dozen bids per storm pass the pre-check and reach the crash point, so a random
// rate can come up empty. The first one and every Nth after "die" instead: some seeds get
// fewer than N bids that far, and every run must still recover at least one crash.
const CRASH_EVERY = 12;
const CANCEL_FAULT_EVERY = 4; // every 4th cancel call fails transiently
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
  it('leaves zero invariant violations once everything is quiet', async () => {
    const random = seededRandom(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
    const crashed = new Set<string>();
    let reachedCommit = 0;
    let cancelCalls = 0;
    let authorizations = 0;
    let serverErrors = 0;
    const payments = new FakePayments({
      latency: () => Math.floor(random() * MAX_LATENCY_MS),
      decide: () => {
        if (++authorizations % SERVER_ERROR_EVERY === 1) {
          serverErrors++;
          return { error: 'server_error', created: random() < 0.5 };
        }
        const r = random();
        if (r < DECLINE_RATE) return { approve: false, reason: 'card_declined' };
        if (r < DECLINE_RATE + LOST_RESPONSE_RATE) return { error: 'after_authorize' };
        return { approve: true };
      },
      effectFault: (op) =>
        op === 'cancel' && ++cancelCalls % CANCEL_FAULT_EVERY === 0
          ? { retryable: true, reason: 'rate_limited' }
          : undefined,
    });
    const handlerDeps = {
      db,
      payments,
      faults: {
        afterAuthorize: (bid: Bid) => {
          if (++reachedCommit % CRASH_EVERY === 1) {
            crashed.add(bid.id);
            throw new SimulatedCrash();
          }
        },
      },
    };
    const auction = await openAuction(db, {
      startsIn: -1_000,
      endsIn: ENDS_IN_MS,
      startingPrice: 1_000,
      minIncrement: 100,
    });

    // The background machinery of two instances: two outbox workers, the lifecycle ticker,
    // and a reconciler that takes over bids pending for longer than a short threshold.
    const publisher = new MemoryPublisher();
    const backgroundErrors: unknown[] = [];
    const onError = (e: unknown) => backgroundErrors.push(e);
    const workerDeps = { db, payments, publisher };
    const workers = [1, 2].map(() =>
      startOutboxWorker(workerDeps, { ...FAST_OUTBOX, intervalMs: 30, onError }),
    );
    const lifecycle = startLifecycle({ db }, { intervalMs: 50, onError });
    // An object, so the loop sees the later write (a plain let reads as always-true to lint).
    const control = { reconciling: true };
    const reconciler = (async () => {
      while (control.reconciling) {
        try {
          await reconcileOnce({ db, payments }, { staleAfterMs: 300 });
        } catch (e) {
          onError(e);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();

    // Bidders act on a stale view of the price, as real clients do, so many bids tie or
    // fall short by the time they reach the lock.
    let observedHigh: number | null = null;
    const issued: Request[] = [];
    const outcomes: Outcome[] = [];

    const send = async (request: Request): Promise<void> => {
      try {
        const bid = await placeBid(
          handlerDeps,
          {
            auctionId: auction.id,
            userId: request.userId,
            amount: request.amount,
            idempotencyKey: request.idempotencyKey,
          },
          { deadlineMs: DEADLINE_MS },
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

    // Let the ticker close the auction, then stop the background loops and settle what's
    // left, so invariant 4 can be checked in full.
    await waitFor(async () => {
      const [a] = await db.select().from(auctions).where(eq(auctions.id, auction.id));
      return a?.status !== 'open';
    });
    control.reconciling = false;
    await reconciler;
    await Promise.all([...workers.map((w) => w.stop()), lifecycle.stop()]);
    await settle({ db, payments, publisher });
    expect(backgroundErrors, `STORM_SEED=${String(seed)}`).toEqual([]);

    const violations = await checkInvariants(db, payments, {
      auctionId: auction.id,
      audit: payments,
      outboxIdle: true,
    });
    expect(violations, `STORM_SEED=${String(seed)}`).toEqual([]);

    // Every request reached an expected outcome. Requests sharing a key are judged as a
    // group: whichever claims the key first proceeds, even if it was fired second (both
    // wait on the pool). With the deadline, any bid may come back pending.
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
        } else {
          // Read at return time: a pending bid may already be the closed auction's winner.
          expect(['pending', 'accepted', 'outbid', 'lost_race', 'rejected', 'won']).toContain(
            o.bid.status,
          );
        }
      }
    }

    // The auction ended settled, its winner captured.
    const [final] = await db.select().from(auctions).where(eq(auctions.id, auction.id));
    expect(final?.status, `STORM_SEED=${String(seed)}`).toBe('settled');
    const [winner] = await db
      .select()
      .from(bids)
      .where(eq(bids.id, final?.currentHighBidId ?? ''));
    expect(winner?.status).toBe('won');
    expect((await payments.retrieve(winner?.paymentIntentId ?? ''))?.status).toBe('succeeded');

    // Non-triviality: a storm that never raced, crashed, retried or ended proves nothing.
    const rows = await db.select().from(bids).where(eq(bids.auctionId, auction.id));
    const count = (pred: (b: Bid) => boolean) => rows.filter(pred).length;
    const retriedCancels = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.kind, 'cancel_hold'), gt(outbox.attempts, 1), isNotNull(outbox.doneAt)));
    const summary = {
      seed,
      bids: rows.length,
      everAccepted: count((b) => ['accepted', 'outbid', 'won'].includes(b.status)),
      lostRaces: count((b) => b.status === 'lost_race'),
      endedRefusals: count((b) => b.reason === 'ended'),
      crashesRecovered: [...crashed].filter((id) =>
        rows.some((b) => b.id === id && b.status !== 'pending'),
      ).length,
      lostResponses: rows.filter(
        (b) => b.paymentIntentId !== null && payments.callsByKey.get(b.id) === 2,
      ).length,
      dedupedRetries: outcomes.filter(
        (o) => 'bid' in o && o.request.retryOf && o.request.amount === o.request.retryOf.amount,
      ).length,
      retriedCancels: retriedCancels.length,
      serverErrors,
      published: publisher.events.length,
    };
    const why = JSON.stringify(summary);
    expect(summary.everAccepted, why).toBeGreaterThanOrEqual(1);
    expect(summary.lostRaces, why).toBeGreaterThanOrEqual(1);
    expect(summary.endedRefusals, why).toBeGreaterThanOrEqual(1);
    expect(summary.crashesRecovered, why).toBeGreaterThanOrEqual(1);
    expect(summary.crashesRecovered, why).toBe(crashed.size);
    expect(summary.dedupedRetries, why).toBeGreaterThanOrEqual(1);
    expect(summary.retriedCancels, why).toBeGreaterThanOrEqual(1);
    expect(summary.serverErrors, why).toBeGreaterThanOrEqual(1);
    // Every accept and the close were published.
    expect(summary.published, why).toBe(summary.everAccepted + 1);
    console.log('storm', summary);
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
