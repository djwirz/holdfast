// The health numbers the alerts watch (spec §8), sampled every 30 seconds on every replica.
// Each replica samples for itself: if only one did, a replica that stopped would keep
// exporting its last value, and a stale "1 orphaned hold" could hold an alert open after
// the other replica saw 0. The alert rules take the max across replicas.
import { sql } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { gauges } from './observability.ts';
import type { Payments } from './payments/port.ts';

export interface SamplerOptions {
  /** A pending bid older than this is the reconciler's (RECONCILE_DEFAULTS). */
  staleAfterMs: number;
  /** How long a queued cancellation may take before its hold counts as orphaned. */
  cancelGraceMs: number;
  /** How long a closed auction may wait for its capture before it counts as unsettled. */
  unsettledAfterMs: number;
}

export const SAMPLER_DEFAULTS: SamplerOptions = {
  staleAfterMs: 30_000,
  cancelGraceMs: 2 * 60_000,
  unsettledAfterMs: 10 * 60_000,
};

export interface Sample {
  outboxLagSeconds: number;
  outboxFailed: Record<string, number>;
  pendingStale: number;
  unsettled: number;
  /** Ids of holds with no live bid behind them; their count is the alarm. */
  orphanedHolds: string[];
}

type BidRow = {
  id: string;
  auctionId: string;
  status: string;
  isCurrentHigh: boolean;
  auctionStatus: string;
  cancelQueuedRecently: boolean;
};

export async function sampleOnce(
  deps: { db: Db; payments: Payments },
  overrides: Partial<SamplerOptions> = {},
): Promise<Sample> {
  const o = { ...SAMPLER_DEFAULTS, ...overrides };
  const { db } = deps;
  const secs = (ms: number) => ms / 1000;

  const [lag] = (
    await db.execute<{ seconds: number }>(sql`
      select coalesce(extract(epoch from clock_timestamp() - min(available_at)), 0)::float8 as seconds
        from outbox
       where done_at is null and failed_at is null and available_at <= clock_timestamp()`)
  ).rows;
  const failed = (
    await db.execute<{ kind: string; n: number }>(sql`
      select kind::text, count(*)::int as n from outbox where failed_at is not null group by kind`)
  ).rows;
  const [pending] = (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from bids
       where status = 'pending'
         and created_at < clock_timestamp() - make_interval(secs => ${secs(o.staleAfterMs)})`)
  ).rows;
  const [unsettled] = (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from auctions
       where status = 'closed'
         and ends_at < clock_timestamp() - make_interval(secs => ${secs(o.unsettledAfterMs)})`)
  ).rows;

  // The provider's live holds, judged against the bids that may hold money: the current high
  // of an open auction, a closed auction's winner (capture pending), a bid still pending, or a
  // bid whose cancellation was queued moments ago. Holds for auctions this database doesn't
  // know aren't ours (another environment, or a test run on the same Stripe account).
  const holds = await deps.payments.listHolds();
  const orphanedHolds: string[] = [];
  if (holds.length > 0) {
    const bidIds = holds.map((h) => h.metadata.bidId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const auctionIds = holds
      .map((h) => h.metadata.auctionId)
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const known = new Set(
      auctionIds.length === 0
        ? []
        : (
            await db.execute<{ id: string }>(
              sql`select id::text from auctions where id::text in ${auctionIds}`,
            )
          ).rows.map((r) => r.id),
    );
    const rows =
      bidIds.length === 0
        ? []
        : (
            await db.execute<BidRow>(sql`
              select b.id::text, b.auction_id::text as "auctionId", b.status::text,
                     (a.current_high_bid_id = b.id) as "isCurrentHigh", a.status::text as "auctionStatus",
                     exists (
                       select 1 from outbox x
                        where x.kind = 'cancel_hold' and x.payload->>'bidId' = b.id::text
                          and x.failed_at is null
                          and x.created_at > clock_timestamp() - make_interval(secs => ${secs(o.cancelGraceMs)})
                     ) as "cancelQueuedRecently"
                from bids b join auctions a on a.id = b.auction_id
               where b.id::text in ${bidIds}`)
          ).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const hold of holds) {
      if (!known.has(hold.metadata.auctionId)) continue;
      const bid = byId.get(hold.metadata.bidId);
      const live =
        bid !== undefined &&
        (bid.status === 'pending' ||
          (bid.status === 'accepted' && bid.isCurrentHigh && bid.auctionStatus === 'open') ||
          (bid.status === 'won' && bid.auctionStatus === 'closed') ||
          bid.cancelQueuedRecently);
      if (!live) orphanedHolds.push(hold.id);
    }
  }

  return {
    outboxLagSeconds: lag?.seconds ?? 0,
    outboxFailed: Object.fromEntries(failed.map((r) => [r.kind, r.n])),
    pendingStale: pending?.n ?? 0,
    unsettled: unsettled?.n ?? 0,
    orphanedHolds,
  };
}

/** Records a sample on the gauges Grafana reads. */
export function recordSample(sample: Sample): void {
  gauges.outboxLag.record(sample.outboxLagSeconds);
  // Every kind, zeros included, so a fixed failure reads 0 instead of going silent.
  for (const kind of ['cancel_hold', 'capture', 'publish']) {
    gauges.outboxFailed.record(sample.outboxFailed[kind] ?? 0, { kind });
  }
  gauges.pendingStale.record(sample.pendingStale);
  gauges.unsettled.record(sample.unsettled);
  gauges.orphanedHolds.record(sample.orphanedHolds.length);
}

export function startSampler(
  deps: { db: Db; payments: Payments },
  options: Partial<SamplerOptions> & { intervalMs?: number; onError?: (e: unknown) => void } = {},
): { stop: () => void } {
  const { intervalMs = 30_000, onError = () => undefined, ...rest } = options;
  const tick = () => {
    sampleOnce(deps, rest).then(recordSample, onError);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
