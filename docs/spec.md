# Holdfast: spec

Status: Draft for PR #1 · Date: 2026-11-22 · Owner: Dan

## 1. Problem

Timed auctions with real money need two things to be true at once: the highest bid wins, and the winner can pay. Most systems make only the first true at bid time and hope for the second at close. The usual failures:
- **Unpaid winners:** the card declines at checkout.
- **Lost bids:** two near-simultaneous bids at the same price both read "current high is X" and both insert. The UI shows one winner and the database holds two.
- **Orphaned holds:** money is authorized for a bid that later lost and is never released. That's the worst kind of bug, because it's on the customer's card.

Holdfast is a small auction site that makes both true at bid time. A bid counts only after Stripe has placed an authorization hold for its full amount on the bidder's card. Bids are then ordered under a row lock in a single Postgres transaction. Every viewer sees the result live, holds that stop mattering are released, and the winner's hold is captured at close.

**What a viewer sees.**
1. Two browser windows sit side by side on one auction.
2. Each bidder signs in with GitHub and adds Stripe's test card once.
3. They bid against each other, and the price ticks up in both windows within about a second.
4. The Stripe dashboard (test mode) shows one hold per bid. Each is canceled when it's outbid, and the last one is captured when the timer ends.
5. Then the load-test chart: a storm of near-simultaneous bids, and the invariant checker's "zero violations".
6. Finally, one bid's trace, from click to every screen.

That sequence is the README GIF and the case study.

### Why this is worth building (portfolio framing)
It shows TypeScript and Node.js on a real server, PostgreSQL transactions and locking done deliberately, Stripe's authorization-and-capture model (holds, idempotency, webhooks, reconciliation), real-time fan-out across instances with Redis, E2E tests with Playwright, a load test that checks correctness and not just throughput, and distributed tracing. The design draws only on public patterns for hold-backed real-time bidding.

## 2. Non-goals (v1)

- **Real money.** Stripe test mode only, forever. There's no live-mode code path.
- **Proxy or maximum bidding.** Each bid is one fixed amount. (A later ADR could put one hold on a bidder's maximum.)
- **Seller payouts.** No Stripe Connect. The site is the seller.
- **3-D Secure challenges.** Bids are confirmed off-session. A card that needs authentication gets the bid rejected with a clear reason. The card-setup step does handle 3DS, because Stripe Elements does that for free.
- **Auctions longer than a hold lasts.** Online card authorizations are short-lived: Stripe documents 7 days, and each charge's `capture_before` gives the actual expiry ([Stripe: place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)). Demo auctions last minutes to hours, and creation refuses anything over a day.
- **Multi-currency, taxes, shipping.**
- **Open-ended scale.** The load test proves correctness and gives an honest throughput figure for one auction. Sharding and multi-region are out.
- **Multiple environments.** One deployed environment, `demo`.

## 3. Appetite

- **Time:** two to three focused weeks. Three is the honest estimate.
- **Money:** a few dollars a month for hosting at most, with a budget alarm before the first deploy. Postgres, Redis and the trace backend should fit hobby or free tiers at demo volume. Stripe test mode is free.
- **Shape:** seven thin PRs after this one, local-first. The first four never deploy (§12).
- **If time runs short, cut in this order.** The project exists to prove three things: holds back every accepted bid, ordering survives concurrency, and it's live and traceable. Cut what proves none of those first:
  1. Soft close.
  2. The admin page (seed script instead).
  3. Redis rate limiting.
  4. UI styling beyond clean and accessible.

  **Never cut:**
  - The invariant checker and the concurrency test.
  - The outbox and reconciler (they're what make "no orphaned holds" true).
  - Webhook signature checks.
  - The two-instance fan-out.
  - The Playwright two-bidder test.
  - The trace.
  - The budget alarm.

## 4. Architecture

```
 browser (React)                      server instances (Fastify, ×2+)               external
 ───────────────                      ───────────────────────────────               ────────
 POST /auctions/:id/bids ──────────▶  bid handler
                                        1 pre-check (no lock)
                                        2 insert bid  status=pending
                                        3 PaymentIntent create+confirm  ──────────▶ Stripe
                                          (off_session, capture_method=manual,      (test mode)
                                           idempotency key = bid id)
                                        4 txn: SELECT auction FOR UPDATE
                                               recheck → accept | lost_race
                                               write outbox rows
                                        5 respond with outcome
                                      outbox worker ──── cancel / capture ────────▶ Stripe
                                                    └─── publish ───────────────▶ Redis pub/sub
 GET /auctions/:id/events (SSE) ◀──── every instance subscribes ◀──────────────── Redis
                                      reconciler (interval): stale pending bids,
                                        holds without a live bid
                                      close job: ends_at → closed, enqueue capture
 Stripe webhooks ─────────────────▶  POST /stripe/webhook (signature verified)
                                      PostgreSQL (single source of truth)
```

### Components
- **Bid handler.** Runs the flow in ADR 0002. The Stripe call happens outside any transaction or lock, so a slow authorization never blocks other bidders.
- **Outbox worker.** Reads outbox rows written in the same transaction as the state change (ADR 0003) and does the side effects: cancel a hold, capture the winner, publish to Redis. It claims rows with `FOR UPDATE SKIP LOCKED` as a short lease, so no transaction stays open across a Stripe call and a worker that dies leaves its rows to reappear when the lease runs out. It's safe on every instance. Retryable failures back off exponentially; a permanent failure, or running out of attempts, marks the row `failed_at` for the alerts (§8) instead of retrying forever.
- **Reconciler.** On an interval, takes over bids stuck in `pending` longer than a short threshold. It sends the authorization again with the bid id as the idempotency key: Stripe replays the original result, so a hold placed before a crash is found, never duplicated. Then it decides the bid exactly as the handler would. The threshold must stay far under Stripe's 24-hour idempotency-key lifetime. Two Stripe behaviors limit what the key can do, and the adapter covers both (§5): a `500` is saved and replayed for its key, and a second request while the first with that key is still running gets a `409`. As a backstop, it queues a cancellation for any resolved bid that holds money, isn't the current high or the winner, and never had one queued. It never touches a `pending` bid younger than the threshold, because that bid may be about to commit. It's the backstop for crashes between steps.
- **Resolving a pending bid.** The bid handler and the reconciler both resolve a bid under the auction row lock, and only with `UPDATE … WHERE status = 'pending'`. Whichever gets there first decides; the other sees no row to update and does nothing.
- **Close job.** Marks auctions `closed` at `ends_at`, using database time, and enqueues the winner's capture.
- **SSE endpoint.** Sends a snapshot on connect, then events in auction-version order. It resumes from `Last-Event-ID` (ADR 0004).
  - **Redis is the doorbell, Postgres is the content.** A message on `auction:<id>` only says that auction changed. Each instance then reads "every event after the last version I sent" from Postgres, once per auction however many clients watch it. Every event is derivable from the tables: an accepted bid keeps its `auction_version`, and a closed auction's version is the close.
  - So a lost, late or duplicated Redis message can only delay an update, never drop, reorder or invent one. A slow poll covers lost doorbells and Redis being down.
  - Versions go up by exactly one per accept and per close. A connection that sees a jump reads the gap from Postgres before sending past it, so each client gets every version exactly once, in order.
- **Webhook endpoint.** Verifies Stripe's signature and records payment-intent events. It uses them to speed up reconciliation, never as the only source of truth.

### Data model (PostgreSQL)
| Table | Key fields |
|---|---|
| `users` | id, github_id, login, stripe_customer_id, default_payment_method_id |
| `auctions` | id, title, starts_at, ends_at, status (`scheduled`/`open`/`closed`/`settled`), starting_price, min_increment, current_high_bid_id, version |
| `bids` | id (uuid; also the Stripe idempotency key), auction_id, user_id, idempotency_key (unique per user), amount, status (`pending`/`accepted`/`outbid`/`lost_race`/`rejected`/`won`), reason, payment_intent_id, auction_version (set on accept), created_at, resolved_at |
| `outbox` | id, kind (`cancel_hold`/`capture`/`publish`), payload (includes the W3C `traceparent`), available_at, attempts, done_at, failed_at, last_error |
| `stripe_events` | id (Stripe event id, for dedupe), type, payload, received_at |
| `sessions` | id, user_id, expires_at |

Money is stored as integer cents. `auctions.version` increments on every accepted bid and close, and it's the SSE event id.

**Bid statuses.** A bid starts `pending`. It becomes `rejected` (it failed the bid rules before any hold was placed, so it never gets one, or Stripe declined or needs authentication), `lost_race` (it no longer qualified under the lock) or `accepted`. An accepted bid becomes `outbid` when a higher bid is accepted, or `won` when the auction closes with it as the current high. A `won` bid stays `won` whether or not capture succeeds; the auction's status says whether it was settled.

**Bid rules.** The first accepted bid must be at least `starting_price`. Every later one must be at least the current high plus `min_increment`. The auction must be `open` and database time before `ends_at`.

## 5. Payments: Stripe test mode
- **Card setup.** On first bid, a SetupIntent with Stripe Elements saves a test card to the user's Customer (`usage: off_session`).
  - The page uses Stripe's card-only `CardElement`, not the Payment Element: the Payment Element offers every method the account enables (bank debits, wallets), and only a card can carry an off-session hold. `confirmCardSetup` runs 3-D Secure if the card asks for it.
  - `POST /api/me/card/setup` creates the Customer once (keyed by user) and a SetupIntent, and returns its client secret. `POST /api/me/card` `{ setupIntentId }` saves the card only after the server retrieves the SetupIntent from Stripe and finds it `succeeded` and on this user's Customer; the client's word is never enough.
  - Card numbers go from the browser to Stripe; they never reach our server.
- **The hold.** Each bid creates and confirms a PaymentIntent with `capture_method: manual`, `off_session: true`, the saved payment method, and the bid id as the `Idempotency-Key`. Metadata carries the bid and auction ids. Success means status `requires_capture`, with `amount_capturable` at least the bid amount.
- **One PaymentIntent per bid** (ADR 0006). When a bid is accepted, the hold of the bid it outbid is canceled through the outbox, whoever placed it. A bidder raising their own high bid therefore has two holds for a moment. Incremental authorization was tried in slice 3b and isn't available on a standard account (§13).
- **Release:** `cancel` with reason `abandoned`. **Capture:** the winner's PaymentIntent, for the bid amount, at close. Each outbox attempt sends its own idempotency key, because a fixed key would replay one `500` for a day. A second attempt that lands on an intent already in the target state counts as success, judged by the intent's status, not the key.
- **Declines.** Stripe's test cards for declines, insufficient funds and authentication-required all map to `rejected`, with the reason shown to the bidder (the card error's `decline_code`, else its `code`). Some decline cards are refused when they're saved, so card setup never stores them; `pm_card_chargeCustomerFail` saves and then declines, which is the case a bid meets.
- **How the adapter reads Stripe's answers** (`server/src/payments/stripe.ts`):
  - A card error → `rejected` with its reason. An intent left in `requires_action` → `rejected` (`authentication_required`), and the stray intent is canceled.
  - A lost connection, a `429`, or a `409` for a key still in flight → the bid stays `pending` and the reconciler retries the same key. Stripe saves none of these, so the retry is real. (The SDK retries a `409` itself and usually gets the replay.)
  - A `500` → the request ran to the end and Stripe will replay this error for the key, so retrying is useless. The adapter lists the customer's recent PaymentIntents (List, not Search, which can lag) and returns the hold whose metadata has this bid id. If there is none, the bid is `rejected` with `processing_error`, since no hold exists. Without this, one `500` would leave a bid `pending` for a day.
  - Bad keys, permission errors, a key reused with different parameters and invalid requests are bugs: they're thrown, not retried.
  - The client refuses any key that isn't `sk_test_`.
- **Webhooks:** `payment_intent.amount_capturable_updated`, `.canceled`, `.succeeded` and `.payment_failed`, deduped by event id.

## 6. Interfaces
Every API path is under `/api` (slice 4b), so page routes such as `/auctions/:id` and the API share one origin without colliding. The paths below are written without the prefix.

- `GET /auctions` → live and upcoming auctions, and ones that ended in the last day, with the current high.
- `GET /config` → which sign-in and card steps the page should show, and the publishable key in real-Stripe mode.
- `POST /auctions/:id/bids` `{ amount }` → `201 { bid }` with status `accepted`, `lost_race` or `rejected` (with a reason: a rule such as `below_minimum` or `ended`, or the card's decline). If the bid isn't resolved within a short deadline (Stripe slow or erroring), → `202 { bid }` with status `pending`, and the client polls the bid until it resolves.
- `GET /bids/:id` → the bid, for its own bidder only. This is how the bidder learns a `pending` bid's outcome; the SSE stream is public and carries only accepted bids, so it never shows another bidder's rejection reason.
- **Idempotency.** Bids take a client-supplied `Idempotency-Key` header, unique per user. A retry with the same key returns the existing bid and never authorizes again. The same key with a different auction or amount → `422`.
- `GET /auctions/:id` → a snapshot: auction, current high and recent bids, with the `version` and the minimum next bid. Signed in, it also says which alias is yours.
- **Public identity.** Snapshots and events show a per-auction alias ("Bidder 3f9a", an HMAC of user and auction), never user ids or logins. It's stable within an auction and unlinkable across auctions.
- `GET /me` → the signed-in login, whether a card is saved, and whether bids need one (real Stripe) or not (the fake). `401` signed out.
- **Status codes.** `400` bad body or missing `Idempotency-Key`; `401` not signed in; `403` wrong origin; `404` unknown auction, or someone else's bid; `422` key reused for another bid; `429` rate limited. Errors are always `{ error, message }`, with nothing internal in them.
- `GET /auctions/:id/events` → SSE. Event types `bid.accepted`, `auction.extended` (only if soft close is built) and `auction.closed`. Every event carries the auction `version` as its id.
- **Creating auctions.** No public endpoint in v1. A seed script creates them through the same validated function the admin page would use (if it's built), so the one-day limit and the rules above hold either way.
- `POST /stripe/webhook`: Stripe only, signature verified.
- `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/logout`: GitHub OAuth sign-in.
- Schemas live in a shared zod package, used by both server and client.

## 7. Invariants and failure modes

The invariants (checked by the concurrency test and the load-test checker):
1. **Covered:** every bid that was ever `accepted` has a PaymentIntent that was `requires_capture` for at least its amount before the accepting transaction committed.
2. **Ordered:** bids that were ever accepted on an auction, sorted by `auction_version`, start at or above `starting_price` and strictly increase by at least `min_increment`. Exactly one is `current_high_bid_id`.
3. **Closed is closed:** no bid is accepted with database time at or after `ends_at` as it stood in the accepting transaction. (Soft close, if built, moves `ends_at` only inside that same transaction.)
4. **No orphaned holds:** once the outbox and reconciler are idle, the only uncanceled holds are the current high bid's on an open auction and the winning bid's on a closed or settled auction (captured once settled). Checkable from slice 3, when the outbox and reconciler exist.
5. **Idempotent:** retrying a bid request with the same user and key never creates a second hold or a second bid.

| Failure | What happens |
|---|---|
| Stripe declines or needs auth | Bid → `rejected` with reason; no hold exists. |
| Stripe is slow or errors after authorizing | Bid stays `pending`. The bidder gets `202` and polls `GET /bids/:id`. The reconciler finishes it; if it's accepted, every viewer also gets `bid.accepted`. |
| Process dies between hold and commit | Bid stays `pending` with a live hold. The reconciler commits it if it still qualifies, otherwise marks it `lost_race` and cancels. |
| Two bids race at the same amount | The first to commit wins. The second rechecks under the lock, becomes `lost_race`, and its hold is canceled through the outbox. |
| Outbox side effect fails | Retried with backoff. After repeated failures it stays visible in metrics and alerts (§8). |
| Redis is down | Bids still commit (Postgres is the truth). Live updates pause. Clients reconnect and resume from `Last-Event-ID` using the snapshot. |
| Capture fails at close | Auction stays `closed`, not `settled`, with an alert. The runbook covers it. |

Ordering note: commit order, not click order, decides ties. A bidder who clicked first can lose to one whose authorization came back faster. That trade-off is in ADR 0002 and gets one honest line in the UI.

## 8. Observability
- **Logs:** structured logs (pino) with request id, bid id, auction id and PaymentIntent id. Card data never reaches the server; Elements handles it.
- **Traces:** OpenTelemetry auto-instrumentation for HTTP, `pg`, `ioredis` and the Stripe client, plus manual spans for the bid steps. The trace context is carried through outbox rows and Redis messages, so one bid's trace runs from the HTTP request to the SSE write on every instance. A picture of one bid's trace is an acceptance criterion.
- **Metrics:**
  - Bids by outcome.
  - Hold latency.
  - Lock wait time.
  - Outbox lag and failures.
  - Pending bids by age.
  - Outstanding holds without a live bid. This last one is the alarm.
- **Alerts:** orphaned holds above zero for more than a few minutes; outbox failures; a capture failure.
- **As built (slice 6b):**
  - OpenTelemetry to Grafana Cloud's free tier over OTLP. `server/src/telemetry.ts` loads first with `node --import` and does nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so tests and local runs need no collector.
  - Postgres, Redis and outgoing HTTP calls are traced only inside a traced operation. The background loops poll several times a second on every replica, and the sampler lists Stripe's holds every 30 seconds; tracing each of those would be gigabytes a day of nothing.
  - `http` and `https` are instrumented through `require` only, since everything here that uses them (Fastify, the Stripe SDK) is CommonJS. Hooking them through the ESM loader too wrapped `https` twice, and every Stripe call showed as two spans.
  - A bid's trace: `bid.claim` → `payments.authorize` → `bid.decide` (with the lock wait) → `outbox.<kind>` on whichever instance claims the row (its `traceparent` travels in the row) → the Redis doorbell (now `{version, traceparent}`) → `live.fanout` and `sse.write` on every instance.
  - Metrics: `holdfast_bids_total{outcome,reason}`, hold and lock-wait histograms, and a sampler on every replica every 30 seconds. It reports outbox lag, failed outbox rows by kind, stale pending bids, unsettled auctions, and `holdfast_holds_orphaned`.
  - **The orphaned-hold count reads the payment provider** (`Payments.listHolds()`), not our own records. A live hold counts unless it's the current high of an open auction, a closed auction's winner awaiting capture, a pending bid, or one whose cancellation was queued in the last two minutes. Holds for auctions this database doesn't know are another environment's and are ignored.
  - Every replica samples, and the alerts take the max. A replica that stopped sampling would keep exporting its last value and could hold an alert open.
  - The alerts live in `ops/grafana/alerts.json` and are applied by `pnpm grafana:alerts`. `docs/runbook.md` covers each. `pnpm drill <orphan|outbox|capture>` fires one on purpose against a local stack labelled `job="holdfast-drill"`, never the live demo. Each drill gets a fresh database and waits for its alert to read normal before it breaks anything, so a firing can only be its own.

## 9. Security
- Secrets (Stripe secret and webhook keys, GitHub OAuth secret, session secret) live in the host's secret store and never reach the client or logs.
- **Production config** is checked at startup: `APP_ORIGIN` must be `https://` (session cookies are `Secure` there), `DEV_SIGN_IN` is refused, Stripe keys must be test mode, and the server won't start without the built page when `WEB_DIST` is set, so a bad deploy fails its health check instead of going live.
- Webhook signatures are verified on the raw body.
- Sessions use `HttpOnly`, `Secure`, `SameSite=Lax` cookies, plus an origin check on state-changing requests (`Origin` must equal `APP_ORIGIN`). The cookie carries 32 random bytes and the `sessions` table stores only their SHA-256, so a database copy can't be replayed as a sign-in.
- GitHub OAuth asks for no scopes (public profile only) and checks a `state` cookie on the callback.
- **Dev sign-in.** `POST /auth/dev` signs in by name, for local development and tests before the GitHub app exists. The route exists only with `DEV_SIGN_IN=1`, and config refuses that flag in production. Dev users get negative GitHub ids, which real accounts never have.
- Every request body is validated with zod. Amounts are integers within a sane range.
- Bids are rate-limited per user and the auth endpoints per IP, in Redis. If Redis is down the limits are skipped rather than blocking bids (§7).
- gitleaks runs in CI, and `.env.example` holds placeholders only.

## 10. Testing and CI
- **Unit:** the auction rules (starting price, increment, open window, and soft close if built) as pure functions.
- **Integration:** real Postgres and Redis through Testcontainers locally and service containers in CI.
  - The **concurrency test** fires a few hundred bids at one auction in parallel through the real handler, with the Stripe fake set for random latency and some declines, then runs the invariant checker. The storm also includes:
    - bids that straddle `ends_at` while the close job runs (invariant 3);
    - repeated requests with the same idempotency key (invariant 5);
    - handlers killed after authorizing and before committing, so the reconciler has to finish them (invariant 4, from slice 3).
  - **Failure tests:** Redis stopped mid-auction (bids still commit, and a client resumes from `Last-Event-ID`), and a capture that fails at close (the auction stays `closed` and the alert fires).
  - The **fan-out test** runs two server instances, bids against one and listens on the other.
- **Stripe fake:** an in-process implementation of the PaymentIntent subset used, with injected latency, declines, errors after authorizing, `409`s for a key in flight and replayed `500`s (ADR 0006). An opt-in suite, `pnpm test:live` (`server/test/live/`), runs the same contract against real test mode with the key from `.env.local`, plus a bid war and a burst of ten bids checked by the invariant checker against Stripe's own list of intents. It skips without a `sk_test_` key, is never in CI, and is run by hand before each payment-touching merge.
- **E2E:** Playwright with two browser contexts, sign-in stubbed in test mode, the Stripe test card, a bid war and the close. It runs against the local stack in CI and as a smoke test after deploy. It also runs an axe accessibility check on the auction page and checks that price changes are announced through `aria-live` (artifact spec).
  - `pnpm test:e2e` (CI and local): two instances behind the round-robin proxy, the built page, the fake. A bid war through to the close, axe on the home and auction pages, the live region, and a keyboard-only bid.
  - `pnpm test:e2e:stripe` (by hand, like `pnpm test:live`): card setup in Stripe's iframe against real test mode, a bid with a real hold, and a card that saves but declines when charged.
- **Load:** k6 scenarios against the local stack. A short run with the checker on every PR; the bigger runs by hand, with the chart in the README.
  - `load/storm.ts` (k6 2.3.0, in Docker): bidders on their own sessions fire bids near-simultaneously through the round-robin proxy, on a stale view of the price, resending some keys, while the auction ends partway through. `pnpm load:stack` runs the target: two instances plus the shared Stripe fake, with latency, declines, lost responses, replayed `500`s and failing cancels injected. `pnpm load` seeds an auction, runs the storm, then the checker.
  - The checker CLI (`server/src/check-invariants.ts`) waits until the auction has closed and everything has settled, then checks all five invariants against the database and the fake's own record. It fails on any violation, any outbox row that gave up, or a run where no bid was accepted. k6 fails if fewer than 90% of planned bids got an outcome. A run where nothing happened proves nothing.
  - CI runs 30 bidders × 10 bids on a 20-second auction. The README chart comes from a by-hand run of 200 × 15.
  - **Shared fake.** The instances share one Stripe fake over HTTP (`server/src/payments/fake-server.ts`). With a fake per process, a hold placed through one instance was unknown to the other, so its cancellation failed and the hold stayed open. That broke invariant 4 in our own two-instance setup, and the end-to-end test now runs the checker too.
- **CI on every PR:** lint, typecheck, unit, integration, short load and checker, Playwright, gitleaks. Merges to `main` deploy after the same checks.

### Local development
`docker compose up` brings up Postgres and Redis, and `pnpm dev` runs two server instances behind a tiny proxy plus the client. (`pnpm dev:server` runs only the two instances and the round-robin proxy on :3000; `pnpm dev` adds Vite on :5173, which proxies `/api` to it.) The Stripe fake is the default. Set Stripe test keys in `.env.local` to use real test mode, and run `stripe listen` to forward webhooks.

**Deployed** (slice 5, ADR 0007): Railway runs the `Dockerfile` image as two replicas with Postgres and Redis on its private network. The server serves the built page itself, so page and API share one origin. `.railway/railway.ts` (Railway's infrastructure-as-code file) holds the deploy settings: two replicas, the health check, and migrate and seed before each deploy. Railway deploys `main` once CI passes, and `.github/workflows/smoke.yml` runs `pnpm test:smoke` against every successful deploy. The account steps, variables and rollback are in `docs/deploy.md`.

## 11. Acceptance criteria (v1 "done", depth 3)
1. **Live demo:** deployed in `demo`. Two people in two browsers can bid against each other and see updates live. Holds appear and are released in the Stripe test dashboard, and the winner is captured at close. A GIF of this is in the README.
2. **Correct under load:** the k6 storm with the invariant checker shows zero violations, and the README has the chart and an honest throughput figure in words.
3. **Tests and CI:** every automated category in §10 runs on each PR. The real-test-mode Stripe suite and the bigger k6 runs are by hand, as §10 says. Deploys come only from `main`.
4. **Traced:** a picture of one bid's trace end to end, across two instances, is in the README. It's drawn from the trace data (`scripts/trace-chart.ts`) rather than screenshotted, so anyone can redraw it from a trace id (Dan, slice 6b).
5. **Ops:** the alerts in §8 exist and each has been fired once on purpose. `docs/runbook.md` covers each one, and the budget alarm existed before the first deploy.
6. **Record:** ADRs for every expensive decision, and each PR says how AI was used and what it got wrong.

Stretch: soft close, proxy bidding (a superseding ADR), and the Go bid-storm CLI.

## 12. Proposed slice plan (one PR each, after this spec)
1. **Local foundation:**
   - The pnpm workspace (`server`, `web`, `shared`).
   - CI: lint, typecheck, test and gitleaks.
   - Docker Compose for Postgres and Redis.
   - Drizzle schema and migrations.
   - The auction rules as pure functions with unit tests.
   - A seed script that creates auctions through the validated create function.
2. **Bids under concurrency, no money:** the bid handler and transaction behind a `Payments` port with a fake that always authorizes after a random delay (ADR 0002: without latency the design is never exercised); the invariant checker; and the concurrency test. This is where the ordering claim (invariants 1, 2, 3 and 5) is proven; invariant 4 waits for slice 3.
3. **Holds released and captured**, split in two PRs (Dan, after slice 2):
   - **3a, against the fake:** the outbox worker (cancel and capture), the close job, the reconciler, the pending deadline, and failure injection in the fake. The storm now runs all of it at once and checks invariant 4 in full.
   - **3b, real Stripe:** the Stripe adapter behind the same `Payments` port, the opt-in real-test-mode suite, and the incremental-authorization experiment (§13).
4. **Live and visible:** SSE with Redis fan-out, a two-instance local setup, the React auction page, GitHub sign-in, SetupIntent card setup with Elements, the Stripe webhook endpoint, and Playwright with two bidders. (Card setup and the webhook moved here from slice 3 because both need the HTTP server.) Split in two PRs (Dan, after slice 3b):
   - **4a, the server:** the Fastify API, sessions with GitHub and dev sign-in, SSE with Redis fan-out across two instances, the webhook, and the fan-out and Redis-down tests.
   - **4b, the browser:** the React auction page, Elements card setup with its SetupIntent endpoints, and Playwright with two bidders.
5. **First deploy:** budget alarm first, then the host, managed Postgres and Redis, secrets, deploy on merge, and a post-deploy smoke test. Fix what real networking and TLS turn up.
6. **Load and trace,** split in two PRs (Dan, after slice 5):
   - **6a, load:** k6 scenarios and the checker in CI, the shared Stripe fake, the README chart and throughput figure, and releasing the holds the real-Stripe suites leave open.
   - **6b, observability** (Grafana Cloud free): OpenTelemetry traces across instances, the trace picture, metrics and alerts (each fired once), and the runbook. Alerts as code and drills on a local stack (Dan).
7. **Demo polish:** README GIF and chart, soft close if there's time, and case-study notes.

## 13. Open questions (settle before slice 1 unless noted)
1. **Hosting.** Recommendation: one container app on a host that keeps long-lived connections and can run two instances, such as Fly.io. Pair it with Neon (Postgres) and Upstash (Redis). Vercel doesn't fit, because SSE and the background workers need a long-running process. Check current prices and free limits at slice 5 and write the ADR then.
   **Settled in slice 5: Railway, all in one** (Dan; ADR 0007). Fly.io no longer has a free allowance and has no native billing alert or cap. Neon's free tier can't stay asleep under our background loops. Railway has a native hard spending limit with email alerts, and runs the app's two replicas, Postgres and Redis on one bill, at an estimated $5–8 a month.
2. **Incremental authorization.** Stripe's docs list it for Visa, Mastercard and American Express on online payments, with a test card for it (`pm_card_debit_incrementalAuthAuthorized`) ([Stripe: increment an authorization](https://docs.stripe.com/payments/incremental-authorization)). Try it in test mode during slice 3b. If it works, a new ADR could supersede ADR 0006 with one PaymentIntent per bidder that grows.
   **Settled in slice 3b: keep ADR 0006.** On a new standard-pricing test account, Stripe refuses the whole request, even with `request_incremental_authorization: if_available`: "not eligible for the requested card features" (`payment_intent_invalid_parameter`). It's offered on IC+ pricing. Asking for it would break every bid on a standard account, and anyone forking the project would hit the same wall, so one PaymentIntent per bid stays. The live suite reruns the experiment, so a change in eligibility shows up there.
3. **Demo access.** Open GitHub sign-in for anyone (it's test mode, so the only cost is abuse) or a passcode gate like Token Keeper's? Recommendation: open, with rate limits, and the ability to switch to a passcode if it's abused. Decide by slice 4.
   **Settled in slice 4a: open, with rate limits** (Dan). Anyone with a GitHub account can sign in and bid; bids are limited per user and sign-in per IP. A passcode gate stays the fallback if it's abused.
4. **Pace of auctions in the demo.** One always-running auction that restarts every few minutes, or a seed script for each demo? Decide by slice 7.
5. **Skills check.** Dropped (Dan, after slice 1). The project is justified by its own problem, not by matching a skills score. The guard is the problem-first rule in CLAUDE.md, applied in each slice's plan.
6. **Case-study angle.** How much comparison to past professional work is safe to make? Public patterns only, no employer names. Decide in slice 7.
