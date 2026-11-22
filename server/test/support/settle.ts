import { and, isNull, sql } from 'drizzle-orm';
import type { PlaceBidDeps } from '../../src/bids/place-bid.ts';
import { bids, outbox } from '../../src/db/schema.ts';
import { MemoryPublisher, type Publisher } from '../../src/outbox/publisher.ts';
import { runOutboxOnce } from '../../src/outbox/worker.ts';
import { reconcileOnce } from '../../src/reconciler.ts';

/** Fast settings for tests: tiny backoff and lease. */
export const FAST_OUTBOX = { baseBackoffMs: 5, maxBackoffMs: 20, leaseMs: 2_000 };

/**
 * Runs the reconciler and drains the outbox until nothing is pending and every outbox row
 * is done or failed: the state invariant 4's full form is defined on.
 */
export async function settle(
  deps: PlaceBidDeps & { publisher?: Publisher },
  options: { maxRounds?: number } = {},
): Promise<void> {
  const publisher = deps.publisher ?? new MemoryPublisher();
  for (let round = 0; round < (options.maxRounds ?? 200); round++) {
    await reconcileOnce(deps, { staleAfterMs: 0 });
    await runOutboxOnce({ db: deps.db, payments: deps.payments, publisher }, FAST_OUTBOX);
    const [pending] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bids)
      .where(sql`${bids.status} = 'pending'`);
    const [open] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(outbox)
      .where(and(isNull(outbox.doneAt), isNull(outbox.failedAt)));
    if (pending?.n === 0 && open?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('did not settle: pending bids or outbox rows remain');
}
