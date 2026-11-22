// Stripe webhook events (spec §5): recorded once by event id, and used to speed up
// reconciliation, never as the only source of truth. The signature is checked in the
// route, on the raw body, before anything here runs.
import { and, eq, lt, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { type PlaceBidDeps, SimulatedCrash, resumeBid } from '../bids/place-bid.ts';
import { bids, stripeEvents } from '../db/schema.ts';
import { TransientPaymentsError } from './port.ts';

export interface WebhookResult {
  duplicate: boolean;
  /** Set when the event let a stranded pending bid finish now instead of at the next pass. */
  resumed?: Promise<void>;
}

/**
 * A pending bid younger than this is left to its own handler, which is almost certainly
 * still running: Stripe sends the event while the handler is between hold and commit.
 */
export const WEBHOOK_STALE_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordStripeEvent(
  deps: PlaceBidDeps,
  event: Stripe.Event,
  options: { staleAfterMs?: number } = {},
): Promise<WebhookResult> {
  const staleAfterMs = options.staleAfterMs ?? WEBHOOK_STALE_MS;
  const inserted = await deps.db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, payload: event })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  if (inserted.length === 0) return { duplicate: true };

  if (event.type !== 'payment_intent.amount_capturable_updated') return { duplicate: false };
  const bidId = event.data.object.metadata['bidId'];
  // Other intents on the account may carry any metadata; only our bid ids are uuids.
  if (!bidId || !UUID.test(bidId)) return { duplicate: false };
  const [bid] = await deps.db
    .select()
    .from(bids)
    .where(
      and(
        eq(bids.id, bidId),
        eq(bids.status, 'pending'),
        lt(bids.createdAt, sql`clock_timestamp() - make_interval(secs => ${staleAfterMs / 1000})`),
      ),
    );
  if (!bid) return { duplicate: false };
  // The hold exists and the bid is still pending: its handler likely died. Finish it the
  // way the reconciler would; both resolve only from pending, under the auction lock.
  const resumed = resumeBid(deps, bid).then(
    () => undefined,
    (e: unknown) => {
      if (e instanceof TransientPaymentsError || e instanceof SimulatedCrash) return;
      deps.onBackgroundError?.(e);
    },
  );
  return { duplicate: false, resumed };
}
