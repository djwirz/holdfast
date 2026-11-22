// The reconciler (ADR 0003): the backstop for the one gap the outbox can't cover, a crash
// between placing a hold and committing the decision.
import { and, eq, lt, sql } from 'drizzle-orm';
import { type PlaceBidDeps, SimulatedCrash, resumeBid } from './bids/place-bid.ts';
import { bids } from './db/schema.ts';
import { TransientPaymentsError } from './payments/port.ts';

export interface ReconcileOptions {
  /**
   * How old a pending bid must be before the reconciler takes it over. It must stay far
   * below the payment provider's idempotency-key lifetime (24 hours at Stripe), or the
   * replayed authorize would create a second hold instead of finding the first.
   */
  staleAfterMs: number;
  batch: number;
}

export const RECONCILE_DEFAULTS: ReconcileOptions = { staleAfterMs: 30_000, batch: 50 };

export interface ReconcileResult {
  resumed: number;
  stillPending: number;
  backfilledCancels: number;
}

export async function reconcileOnce(
  deps: PlaceBidDeps,
  overrides: Partial<ReconcileOptions> = {},
): Promise<ReconcileResult> {
  const options = { ...RECONCILE_DEFAULTS, ...overrides };
  const { db } = deps;
  const result: ReconcileResult = { resumed: 0, stillPending: 0, backfilledCancels: 0 };

  // 1. Stale pending bids: replay the authorization by its key, then decide as the handler
  //    would have. Both resolve only from pending, under the auction lock (spec §4).
  const stale = await db
    .select()
    .from(bids)
    .where(
      and(
        eq(bids.status, 'pending'),
        lt(
          bids.createdAt,
          sql`clock_timestamp() - make_interval(secs => ${options.staleAfterMs / 1000})`,
        ),
      ),
    )
    .orderBy(bids.createdAt)
    .limit(options.batch);
  for (const bid of stale) {
    try {
      const after = await resumeBid(deps, bid);
      if (after.status === 'pending') result.stillPending++;
      else result.resumed++;
    } catch (e) {
      if (!(e instanceof TransientPaymentsError || e instanceof SimulatedCrash)) throw e;
      result.stillPending++; // try again next pass
    }
  }

  // 2. Invariant 4 backstop: a resolved bid that holds money but isn't the current high or
  //    the winner, with no cancellation ever queued, gets one. Database-only, so it costs
  //    nothing against the payment provider's rate limits.
  const backfilled = await db.execute(sql`
    insert into outbox (kind, payload)
    select 'cancel_hold', jsonb_build_object(
             'paymentIntentId', b.payment_intent_id, 'bidId', b.id::text,
             'auctionId', b.auction_id::text, 'traceparent', null)
      from bids b
     where b.payment_intent_id is not null
       and b.status in ('outbid', 'lost_race', 'rejected')
       and not exists (
         select 1 from outbox o
          where o.kind = 'cancel_hold' and o.payload->>'bidId' = b.id::text)`);
  result.backfilledCancels = backfilled.rowCount ?? 0;
  return result;
}
