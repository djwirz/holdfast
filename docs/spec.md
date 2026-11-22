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
It shows TypeScript and Node.js on a real server, PostgreSQL transactions and locking done deliberately, Stripe's authorization-and-capture model (holds, idempotency, webhooks, reconciliation), real-time fan-out across instances with Redis, E2E tests with Playwright, a load test that checks correctness and not just throughput, and distributed tracing. It mirrors, using public patterns only, the hold-backed real-time bidding of Dan's HYP work.

## 2. Non-goals (v1)

- **Real money.** Stripe test mode only, forever. There's no live-mode code path.
- **Proxy or maximum bidding.** Each bid is one fixed amount. (A later ADR could put one hold on a bidder's maximum.)
- **Seller payouts.** No Stripe Connect. The site is the seller.
- **3-D Secure challenges.** Bids are confirmed off-session. A card that needs authentication gets the bid rejected with a clear reason. The card-setup step does handle 3DS, because Stripe Elements does that for free.
- **Auctions longer than a hold lasts.** Online card authorizations are short-lived (Stripe documents about seven days). Demo auctions last minutes to hours, and creation refuses anything over a day.
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
- **Outbox worker.** Reads outbox rows written in the same transaction as the state change (ADR 0003) and does the side effects: cancel a hold, capture the winner, publish to Redis. It claims rows with `FOR UPDATE SKIP LOCKED` and is safe on every instance.
- **Reconciler.** On an interval, settles bids stuck in `pending`: it reads their PaymentIntent and either finishes the commit or cancels the hold. It also cancels any `requires_capture` PaymentIntent whose bid is not the current high. It's the backstop for crashes between steps.
- **Close job.** Marks auctions `closed` at `ends_at`, using database time, and enqueues the winner's capture.
- **SSE endpoint.** Sends a snapshot on connect, then events in auction-version order. It resumes from `Last-Event-ID` (ADR 0004).
- **Webhook endpoint.** Verifies Stripe's signature and records payment-intent events. It uses them to speed up reconciliation, never as the only source of truth.

### Data model (PostgreSQL)
| Table | Key fields |
|---|---|
| `users` | id, github_id, login, stripe_customer_id, default_payment_method_id |
| `auctions` | id, title, starts_at, ends_at, status (`scheduled`/`open`/`closed`/`settled`), min_increment, current_high_bid_id, version |
| `bids` | id (uuid; also the Stripe idempotency key), auction_id, user_id, amount, status (`pending`/`accepted`/`outbid`/`lost_race`/`rejected`/`won`/`void`), reason, payment_intent_id, auction_version (set on accept), created_at, resolved_at |
| `outbox` | id, kind (`cancel_hold`/`capture`/`publish`), payload, available_at, attempts, done_at |
| `stripe_events` | id (Stripe event id, for dedupe), type, payload, received_at |
| `sessions` | id, user_id, expires_at |

Money is stored as integer cents. `auctions.version` increments on every accepted bid and close, and it's the SSE event id.

## 5. Payments: Stripe test mode
- **Card setup.** On first bid, a SetupIntent with Stripe Elements saves a test card to the user's Customer (`usage: off_session`).
- **The hold.** Each bid creates and confirms a PaymentIntent with `capture_method: manual`, `off_session: true`, the saved payment method, and the bid id as the `Idempotency-Key`. Metadata carries the bid and auction ids. Success means status `requires_capture`, with `amount_capturable` at least the bid amount.
- **One PaymentIntent per bid** (ADR 0006). The previous high bid's hold is canceled after the new one commits. Incremental authorization is an open question (§13).
- **Release:** `cancel` with reason `abandoned`. **Capture:** the winner's PaymentIntent, for the bid amount, at close.
- **Declines.** Stripe's test cards for declines, insufficient funds and authentication-required all map to `rejected`, with the reason shown to the bidder.
- **Webhooks:** `payment_intent.amount_capturable_updated`, `.canceled`, `.succeeded` and `.payment_failed`, deduped by event id.

## 6. Interfaces
- `POST /auctions/:id/bids` `{ amount }` → `201 { bid }`. The bid's status is `accepted`, `lost_race` or `rejected` with a reason. Bids are idempotent on a client-supplied `Idempotency-Key` header, which maps to the bid id.
- `GET /auctions/:id` → a snapshot: auction, current high and recent bids, with the `version`.
- `GET /auctions/:id/events` → SSE. Event types `bid.accepted`, `auction.extended` (if soft close) and `auction.closed`. Every event carries the auction `version` as its id.
- `POST /stripe/webhook`: Stripe only, signature verified.
- `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/logout`: GitHub OAuth sign-in.
- Schemas live in a shared zod package, used by both server and client.

## 7. Invariants and failure modes

The invariants (checked by the concurrency test and the load-test checker):
1. **Covered:** every bid that was ever `accepted` has a PaymentIntent that was `requires_capture` for at least its amount before the accepting transaction committed.
2. **Ordered:** accepted bids on an auction, sorted by `auction_version`, strictly increase by at least `min_increment`. Exactly one is `current_high_bid_id`.
3. **Closed is closed:** no bid is accepted with database time at or after `ends_at`.
4. **No orphaned holds:** once the outbox and reconciler are idle, the only uncanceled holds are the current high bid's (open auctions) or the captured winner's (settled auctions).
5. **Idempotent:** retrying a bid request with the same key never creates a second hold or a second bid.

| Failure | What happens |
|---|---|
| Stripe declines or needs auth | Bid → `rejected` with reason; no hold exists. |
| Stripe is slow or errors after authorizing | Bid stays `pending`. The client gets a "still confirming" result and then the SSE event. The reconciler finishes it. |
| Process dies between hold and commit | Bid stays `pending` with a live hold. The reconciler commits it if it still qualifies, otherwise marks it `lost_race` and cancels. |
| Two bids race at the same amount | The first to commit wins. The second rechecks under the lock, becomes `lost_race`, and its hold is canceled through the outbox. |
| Outbox side effect fails | Retried with backoff. After repeated failures it stays visible in metrics and alerts (§8). |
| Redis is down | Bids still commit (Postgres is the truth). Live updates pause. Clients reconnect and resume from `Last-Event-ID` using the snapshot. |
| Capture fails at close | Auction stays `closed`, not `settled`, with an alert. The runbook covers it. |

Ordering note: commit order, not click order, decides ties. A bidder who clicked first can lose to one whose authorization came back faster. That trade-off is in ADR 0002 and gets one honest line in the UI.

## 8. Observability
- **Logs:** structured logs (pino) with request id, bid id, auction id and PaymentIntent id. Card data never reaches the server; Elements handles it.
- **Traces:** OpenTelemetry auto-instrumentation for HTTP, `pg`, `ioredis` and the Stripe client, plus manual spans for the bid steps. The trace context is carried through outbox rows and Redis messages, so one bid's trace runs from the HTTP request to the SSE write on every instance. The trace screenshot is an acceptance criterion.
- **Metrics:**
  - Bids by outcome.
  - Hold latency.
  - Lock wait time.
  - Outbox lag and failures.
  - Pending bids by age.
  - Outstanding holds without a live bid. This last one is the alarm.
- **Alerts:** orphaned holds above zero for more than a few minutes; outbox failures; a capture failure.

## 9. Security
- Secrets (Stripe secret and webhook keys, GitHub OAuth secret, session secret) live in the host's secret store and never reach the client or logs.
- Webhook signatures are verified on the raw body.
- Sessions use `HttpOnly`, `Secure`, `SameSite=Lax` cookies, plus an origin check on state-changing requests.
- Every request body is validated with zod. Amounts are integers within a sane range.
- Bids are rate-limited per user (Redis, if built) and the auth endpoints per IP.
- gitleaks runs in CI, and `.env.example` holds placeholders only.

## 10. Testing and CI
- **Unit:** the auction rules (increment, open window, soft close) as pure functions.
- **Integration:** real Postgres and Redis through Testcontainers locally and service containers in CI.
  - The **concurrency test** fires a few hundred bids at one auction in parallel through the real handler, with the Stripe fake set for random latency and some declines, then runs the invariant checker.
  - The **fan-out test** runs two server instances, bids against one and listens on the other.
- **Stripe fake:** an in-process implementation of the PaymentIntent subset used, with injected latency, declines and errors after authorizing (ADR 0006). An opt-in suite (`STRIPE_LIVE_TEST=1`) runs the same flows against real test mode, and is run by hand before each payment-touching merge.
- **E2E:** Playwright with two browser contexts, sign-in stubbed in test mode, the Stripe test card, a bid war and the close. It runs against the local stack in CI and as a smoke test after deploy.
- **Load:** k6 scenarios against the local stack. A short run with the checker on every PR; the bigger runs by hand, with the chart in the README.
- **CI on every PR:** lint, typecheck, unit, integration, short load and checker, Playwright, gitleaks. Merges to `main` deploy after the same checks.

### Local development
`docker compose up` brings up Postgres and Redis, and `pnpm dev` runs two server instances behind a tiny proxy plus the client. The Stripe fake is the default. Set Stripe test keys in `.env.local` to use real test mode, and run `stripe listen` to forward webhooks.

## 11. Acceptance criteria (v1 "done", depth 3)
1. **Live demo:** deployed in `demo`. Two people in two browsers can bid against each other and see updates live. Holds appear and are released in the Stripe test dashboard, and the winner is captured at close. A GIF of this is in the README.
2. **Correct under load:** the k6 storm with the invariant checker shows zero violations, and the README has the chart and an honest throughput figure in words.
3. **Tests and CI:** every category in §10 runs on each PR. Deploys come only from `main`.
4. **Traced:** a trace screenshot of one bid end to end, across two instances, is in the README.
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
2. **Bids under concurrency, no money:** the bid handler and transaction behind a `Payments` port with a fake that always authorizes; the invariant checker; and the concurrency test. This is where the ordering claim is proven.
3. **Stripe holds:**
   - SetupIntent card setup and the real hold-then-commit.
   - The outbox worker (cancel and capture).
   - The reconciler and the close job.
   - The webhook endpoint.
   - The Stripe fake with failure injection, plus the opt-in real-test-mode suite.
4. **Live and visible:** SSE with Redis fan-out, a two-instance local setup, the React auction page, GitHub sign-in, and Playwright with two bidders.
5. **First deploy:** budget alarm first, then the host, managed Postgres and Redis, secrets, deploy on merge, and a post-deploy smoke test. Fix what real networking and TLS turn up.
6. **Load and trace:** k6 scenarios and the checker in CI, OpenTelemetry traces across instances, the trace screenshot, metrics and alerts (each fired once), and the runbook.
7. **Demo polish:** README GIF and chart, soft close if there's time, and case-study notes.

## 13. Open questions (settle before slice 1 unless noted)
1. **Hosting.** Recommendation: one container app on a host that keeps long-lived connections and can run two instances, such as Fly.io. Pair it with Neon (Postgres) and Upstash (Redis). Vercel doesn't fit, because SSE and the background workers need a long-running process. Check current prices and free limits at slice 5 and write the ADR then.
2. **Incremental authorization.** Stripe's docs limit it to some card networks and accounts. Try it in test mode during slice 3. If it works, a new ADR could supersede ADR 0006 with one PaymentIntent per bidder that grows.
3. **Demo access.** Open GitHub sign-in for anyone (it's test mode, so the only cost is abuse) or a passcode gate like Token Keeper's? Recommendation: open, with rate limits, and the ability to switch to a passcode if it's abused. Decide by slice 4.
4. **Pace of auctions in the demo.** One always-running auction that restarts every few minutes, or a seed script for each demo? Decide by slice 7.
5. **Skills check.** Confirm the "proves" list against `resume-score.json` once kit step 1 has run (build-plan backlog).
6. **Case-study angle.** How much of the HYP comparison is safe to say? Public patterns only. Decide in slice 7.
