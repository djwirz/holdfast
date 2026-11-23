// Opens and closes auctions on database time (spec §4, close job). Closing takes the same
// auction row lock as a bid's commit, so a close and an accept can't interleave
// (invariant 3), and SKIP LOCKED lets every instance run it safely.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { auctions, bids, outbox } from './db/schema.ts';
import { currentTraceparent, inSpan } from './observability.ts';
import { seed } from './seed.ts';

export interface LifecycleResult {
  opened: number;
  closed: number;
}

export async function tickLifecycleOnce(deps: { db: Db }): Promise<LifecycleResult> {
  const { db } = deps;
  const opened = await db
    .update(auctions)
    .set({ status: 'open' })
    .where(and(eq(auctions.status, 'scheduled'), sql`${auctions.startsAt} <= clock_timestamp()`))
    .returning({ id: auctions.id });

  let closed = 0;
  for (;;) {
    const didClose = await db.transaction(async (tx) => {
      const due = await tx.execute<{
        id: string;
        current_high_bid_id: string | null;
        version: number;
      }>(sql`
        select id, current_high_bid_id, version::float8 as version
          from auctions
         where status = 'open' and ends_at <= clock_timestamp()
         order by ends_at
         limit 1
         for update skip locked`);
      const auction = due.rows[0];
      if (!auction) return false;
      // A span only when there's a close to do: the tick itself runs twice a second.
      return inSpan('auction.close', { 'auction.id': auction.id }, async (span) => {
        const version = auction.version + 1;

        let winner: { id: string; amount: number; paymentIntentId: string | null } | undefined;
        if (auction.current_high_bid_id !== null) {
          [winner] = await tx
            .update(bids)
            .set({ status: 'won' })
            .where(and(eq(bids.id, auction.current_high_bid_id), eq(bids.status, 'accepted')))
            .returning({ id: bids.id, amount: bids.amount, paymentIntentId: bids.paymentIntentId });
        }
        // With no winner there's nothing to capture, so the auction is settled at once.
        await tx
          .update(auctions)
          .set({ status: winner ? 'closed' : 'settled', version })
          .where(eq(auctions.id, auction.id));
        if (winner?.paymentIntentId) {
          await tx.insert(outbox).values({
            kind: 'capture',
            payload: {
              paymentIntentId: winner.paymentIntentId,
              bidId: winner.id,
              auctionId: auction.id,
              amount: winner.amount,
              traceparent: currentTraceparent(),
            },
          });
        }
        await tx.insert(outbox).values({
          kind: 'publish',
          payload: {
            event: 'auction.closed',
            auctionId: auction.id,
            version,
            winningBidId: winner?.id ?? null,
            amount: winner?.amount ?? null,
            traceparent: currentTraceparent(),
          },
        });
        span.setAttribute('auction.winner_bid_id', winner?.id ?? '');
        return true;
      });
    });
    if (!didClose) break;
    closed++;
  }
  return { opened: opened.length, closed };
}

/**
 * Runs the lifecycle tick on an interval until stopped. With `demoRounds`, it also opens the
 * next round of each demo auction once the last one has ended (spec §13 Q4), checking at
 * most every `demoRoundsEveryMs`, so the live demo always has something to bid on.
 */
export function startLifecycle(
  deps: { db: Db },
  options: {
    intervalMs?: number;
    onError?: (e: unknown) => void;
    demoRounds?: boolean;
    demoRoundsEveryMs?: number;
  } = {},
): { stop: () => Promise<void> } {
  const {
    intervalMs = 500,
    onError = () => undefined,
    demoRounds = false,
    demoRoundsEveryMs = 30_000,
  } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastRounds = Number.NEGATIVE_INFINITY;
  const tick = async () => {
    await tickLifecycleOnce(deps);
    if (demoRounds && Date.now() - lastRounds >= demoRoundsEveryMs) {
      lastRounds = Date.now();
      await seed(deps.db);
    }
  };
  const loop = () => {
    running = tick().then(
      () => undefined,
      (e: unknown) => {
        onError(e);
      },
    );
    void running.then(() => {
      if (!stopped) timer = setTimeout(loop, intervalMs);
    });
  };
  loop();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
