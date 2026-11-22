// The outbox worker (ADR 0003). Rows are written in the same transaction as the state
// change that justifies them; this does the side effect, at least once, idempotently.
// Claims are short leases, so no transaction stays open across a Stripe call, and a
// worker that dies mid-effect leaves its rows to reappear when the lease runs out.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auctions, outbox } from '../db/schema.ts';
import type { EffectResult, Payments } from '../payments/port.ts';
import type { LiveEvent, Publisher } from './publisher.ts';

export interface OutboxDeps {
  db: Db;
  payments: Payments;
  publisher: Publisher;
}

export interface OutboxOptions {
  batch: number;
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const OUTBOX_DEFAULTS: OutboxOptions = {
  batch: 20,
  leaseMs: 30_000,
  maxAttempts: 10,
  baseBackoffMs: 500,
  maxBackoffMs: 60_000,
};

type Row = {
  id: number;
  kind: 'cancel_hold' | 'capture' | 'publish';
  payload: unknown;
  attempts: number;
};

interface HoldPayload {
  paymentIntentId: string;
  bidId: string;
  auctionId: string;
  amount?: number;
}

export interface OutboxRunResult {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}

export async function runOutboxOnce(
  deps: OutboxDeps,
  overrides: Partial<OutboxOptions> = {},
): Promise<OutboxRunResult> {
  const options = { ...OUTBOX_DEFAULTS, ...overrides };
  const claimed = await deps.db.execute<Row>(sql`
    update outbox
       set available_at = clock_timestamp() + make_interval(secs => ${options.leaseMs / 1000}),
           attempts = attempts + 1
     where id in (
       select id from outbox
        where done_at is null and failed_at is null and available_at <= clock_timestamp()
        order by available_at, id
        for update skip locked
        limit ${options.batch})
    returning id::float8 as id, kind, payload, attempts`);

  const result: OutboxRunResult = { claimed: claimed.rows.length, done: 0, retried: 0, failed: 0 };
  for (const row of claimed.rows) {
    let outcome: EffectResult;
    try {
      outcome = await perform(deps, row);
    } catch (e) {
      // A thrown error says nothing about the outcome; retry (effects are idempotent).
      outcome = { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) };
    }
    if (outcome.ok) {
      result.done++;
      continue; // perform() marked it done, in the same transaction as any state change
    }
    if (outcome.retryable && row.attempts < options.maxAttempts) {
      const backoffMs = Math.min(
        options.maxBackoffMs,
        options.baseBackoffMs * 2 ** (row.attempts - 1),
      );
      await deps.db
        .update(outbox)
        .set({
          availableAt: sql`clock_timestamp() + make_interval(secs => ${backoffMs / 1000})`,
          lastError: outcome.reason,
        })
        .where(eq(outbox.id, row.id));
      result.retried++;
    } else {
      await deps.db
        .update(outbox)
        .set({ failedAt: sql`clock_timestamp()`, lastError: outcome.reason })
        .where(eq(outbox.id, row.id));
      result.failed++;
    }
  }
  return result;
}

async function perform(deps: OutboxDeps, row: Row): Promise<EffectResult> {
  const markDone = (db: Db | Parameters<Parameters<Db['transaction']>[0]>[0]) =>
    db
      .update(outbox)
      .set({ doneAt: sql`clock_timestamp()`, lastError: null })
      .where(eq(outbox.id, row.id));

  // One idempotency key per attempt, not per row. Stripe replays a 500 for its key for a
  // day, so a fixed key would turn one server error into a failed row. Two attempts that
  // both land are harmless: the port judges a cancel or capture of an intent already in
  // that state a success, by the intent's state rather than by the key.
  const attemptKey = (p: HoldPayload) => `${row.kind}:${p.bidId}:${String(row.attempts)}`;
  switch (row.kind) {
    case 'cancel_hold': {
      const p = row.payload as HoldPayload;
      const res = await deps.payments.cancel(p.paymentIntentId, {
        idempotencyKey: attemptKey(p),
      });
      if (res.ok) await markDone(deps.db);
      return res;
    }
    case 'capture': {
      const p = row.payload as HoldPayload;
      if (p.amount === undefined)
        return { ok: false, retryable: false, reason: 'capture without amount' };
      const res = await deps.payments.capture(p.paymentIntentId, {
        amount: p.amount,
        idempotencyKey: attemptKey(p),
      });
      if (res.ok) {
        await deps.db.transaction(async (tx) => {
          await tx
            .update(auctions)
            .set({ status: 'settled' })
            .where(and(eq(auctions.id, p.auctionId), eq(auctions.status, 'closed')));
          await markDone(tx);
        });
      }
      return res;
    }
    case 'publish': {
      await deps.publisher.publish(row.payload as LiveEvent);
      await markDone(deps.db);
      return { ok: true };
    }
  }
}

/** Runs the worker on an interval until stopped; drains back-to-back while batches are full. */
export function startOutboxWorker(
  deps: OutboxDeps,
  options: Partial<OutboxOptions> & { intervalMs?: number; onError?: (e: unknown) => void } = {},
): { stop: () => Promise<void> } {
  const { intervalMs = 250, onError = () => undefined, ...rest } = options;
  const batch = rest.batch ?? OUTBOX_DEFAULTS.batch;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const loop = () => {
    running = (async () => {
      try {
        let r: OutboxRunResult;
        do {
          r = await runOutboxOnce(deps, rest);
        } while (!stopped && r.claimed === batch);
      } catch (e) {
        onError(e);
      }
      if (!stopped) timer = setTimeout(loop, intervalMs);
    })();
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
