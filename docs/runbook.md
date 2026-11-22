# Runbook

What to do when Holdfast pages you. Each alert below is defined in `ops/grafana/alerts.json`, applied with `pnpm grafana:alerts`, and has been fired on purpose at least once (the drill log at the end). Alerts email the Grafana account's address.

Commands marked "production" run against the deployed database through the Railway CLI, from a checkout linked to the project (`pnpm exec railway link`). Railway's Postgres is on its private network, so these use `railway ssh` into the app service or `railway run` with the database's public URL when one is enabled. Never paste a secret into a ticket or chat.

The numbers the alerts read come from `server/src/sampler.ts`, every 30 seconds on each replica. Grafana Explore → the Prometheus data source shows them: `holdfast_holds_orphaned`, `holdfast_outbox_failed{kind}`, `holdfast_auctions_unsettled`, `holdfast_outbox_lag_seconds`, `holdfast_bids_pending_stale`. A drill's numbers carry `job="holdfast-drill"`; production's carry `job="holdfast"`.

## Orphaned holds

**What it means.** A card hold at the payment provider has no live bid behind it, for more than five minutes: not the current high of an open auction, not a closed auction's winner waiting for capture, not a bid still being decided, and no cancellation queued in the last two minutes. Invariant 4 is broken, and money is held on a bidder's card for nothing. This is the alarm the spec calls the worst kind of bug.

**First checks.**
1. Is the outbox alert firing too? If cancellations are failing, fix that first (next section); the orphans usually clear with it.
2. Find the holds. In the Stripe dashboard (test mode) → Payments, filter "Uncaptured", and match metadata `bidId` against the bids table:
   ```sql
   select b.id, b.status, b.auction_id, a.status as auction, a.current_high_bid_id = b.id as is_high
     from bids b join auctions a on a.id = b.auction_id
    where b.id = '<bidId from the metadata>';
   ```
3. No row for that bid id: a hold placed for a bid that was never recorded (a handler that died between the hold and the insert, which the design rules out, or a bug). A row that's `outbid`, `lost_race` or `rejected`: look for its `cancel_hold` outbox row (`payload->>'bidId'`). None means the reconciler's backfill missed it; one that's not done means it's stuck.

**Fix.**
- Stuck or missing cancellation: the reconciler queues a missing one on its next pass (every 5 seconds); a stuck one is the outbox alert's runbook.
- A hold with no bid at all: release it in the Stripe dashboard (Cancel payment), and open an issue with the bid id and timestamps; it's a bug.

**Resolved when** `holdfast_holds_orphaned` reads 0 on both replicas and the alert returns to normal.

## Outbox failures

**What it means.** A side effect gave up: a hold cancellation, a capture or a live-update publish failed permanently (a non-retryable error from the payment provider) or ran out of retries. It won't be retried on its own. Failed cancels leave holds open; a failed capture leaves a winner uncharged (next section); a failed publish only delays live updates, since clients catch up from Postgres.

**First checks.**
```sql
select id, kind, attempts, last_error, payload->>'bidId' as bid, payload->>'auctionId' as auction, failed_at
  from outbox where failed_at is not null order by failed_at desc limit 20;
```
`last_error` says why: `not_found` (an intent the provider doesn't know), `already_captured`, a rate limit that outlasted the retries, an authentication error (a rotated key).

**Fix.** Fix the cause first (rotate the key in Railway, wait out a provider incident). Then put the rows back in the queue:
```bash
pnpm ops:requeue <outbox id>...          # locally
pnpm exec railway ssh -- node server/src/ops/requeue.ts <outbox id>...   # production
```
`--auction <id>` requeues every failed row for one auction. Requeuing is safe: cancels and captures are idempotent and judged by the intent's state, so a second attempt that lands on an already-canceled hold counts as success.

**Resolved when** `holdfast_outbox_failed` reads 0 for every kind.

## Capture failure

**What it means.** An auction closed but its winner's hold wasn't captured: the capture row failed, or the auction has been `closed` for over ten minutes without becoming `settled`. The auction stays `closed` (spec §7) and the winner hasn't paid.

**First checks.**
```sql
select a.id, a.status, a.ends_at, b.id as winner, b.payment_intent_id, o.attempts, o.last_error, o.failed_at
  from auctions a join bids b on b.id = a.current_high_bid_id
  left join outbox o on o.kind = 'capture' and o.payload->>'bidId' = b.id::text
 where a.status = 'closed' order by a.ends_at;
```
Check the hold in the Stripe dashboard: is it still `requires_capture`, and when does `capture_before` expire? A hold lasts about 7 days.

**Fix.**
- The hold is still valid: fix the cause, then `requeue` the capture row as above. The auction becomes `settled` when the capture lands.
- The hold expired or was released: it can't be captured. The winner has to pay another way (out of scope for the demo; note it on the auction and contact them).

**Resolved when** `holdfast_outbox_failed{kind="capture"}` and `holdfast_auctions_unsettled` both read 0.

## Fire drills

`pnpm drill <orphan|outbox|capture>` fires one alert on purpose against a local stack (Postgres and Redis from `docker compose up`), with telemetry sent to Grafana as `job="holdfast-drill"`, so the live demo is never touched. It breaks one thing the way it would really break (a hold with no bid; every cancel failing; every capture failing), waits for the alert to fire, fixes it the way this runbook says, waits for it to resolve, and logs the drill here.

| Date | Alert | Drill | Fired | Resolved |
|---|---|---|---|---|
