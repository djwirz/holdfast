# Artifact spec: Holdfast

Filled from the kit's `templates/artifact-spec.md` before any agent builds code. Draft for PR #1, 2026-11-22.

## One line
A live auction site where your bid only counts once your card's hold covers it, so the winner can always pay and nobody's bid is lost to a race.

## Market skills it proves
From the build-plan roadmap: **TypeScript, Node.js, PostgreSQL, Stripe (payments), real-time, Redis, Playwright, observability**, plus testing and CI.
Provisional: kit step 1 (`resume-score.json` from saved postings) hasn't run yet. When it has, check this list against its "need proof" skills and adjust before slice 1 if they disagree.

## Problem and users
- **Who has the problem:** anyone running timed auctions with real money: marketplaces, charity auctions, livestream sales. The engineers who build them have to make "highest bid wins" and "the winner can pay" true at the same moment, under concurrency.
- **What they do today:** take bids first and charge afterwards. That means unpaid winners, re-running the auction, or manual follow-up. Others put a flat deposit on file, which doesn't cover a bid that's bigger than the deposit. Under load, naive check-then-insert code lets two bids at the same price both "win".
- **Why it matters:** every unpaid win is lost revenue and lost seller trust. Every race bug is a support ticket nobody can answer, because the database "says both won".

## Scope
- **Must have:**
  - Signing in with GitHub, and adding a Stripe test card once (SetupIntent).
  - Placing a bid that's accepted only after an off-session manual-capture PaymentIntent authorizes the full amount.
  - Ordering bids under a row lock in one Postgres transaction.
  - Releasing the hold of a bid that gets outbid or loses a race.
  - Capturing the winner's hold at close.
  - Live updates to every viewer (SSE, fanned out through Redis across two or more server instances).
  - A load test of near-simultaneous bids with an invariant checker.
  - An end-to-end trace of one bid.
  - Playwright E2E with two bidders.
  - Deployed with CI.
- **Nice to have:**
  - Soft close (a late bid extends the auction).
  - A per-user bid rate limit in Redis.
  - An admin "create auction" page (otherwise auctions come from a seed script).
  - The optional Go bid-storm CLI (roadmap).
- **Non-goals (on purpose):**
  - Real money or live mode.
  - Proxy or maximum bidding.
  - Seller payouts (Stripe Connect).
  - Multi-currency.
  - Auctions longer than a card hold can last.
  - A mobile app.
  - Full 3-D Secure challenge flows: a card that needs authentication is rejected with a clear message.

## Success metric
- **Correctness under load:** after a storm of near-simultaneous bids on one auction, the invariant checker finds zero violations (spec §7). That's every run in CI and the large runs done by hand.
- **Latency, in words:** a bid feels instant apart from Stripe's own authorization time. Other viewers see an accepted bid within about a second. Measured from traces, not promised beforehand.
- **Cost:** hosting stays within a few dollars a month.

## Constraints
- **Time:** two to three focused weeks.
- **Budget:** free tiers first; a budget alarm on the host before deploying.
- **Data:** synthetic auctions and Stripe test cards only.
- **Privacy:** no employer details. The HYP story stays at the level of public patterns.
- **Rate limits:** Stripe test mode has lower rate limits than live, so large load runs use a Stripe fake with real-world latency and failures injected (ADR 0006).

## Quality plan
- **Tests:**
  - Unit tests for the auction rules as pure functions.
  - Integration tests against real Postgres and Redis (Docker), including the concurrency test.
  - Payment-flow tests against the Stripe fake, plus a small, opt-in suite against real Stripe test mode.
  - Playwright E2E with two bidders in separate browser contexts.
- **Evals:** none; there's no AI feature.
- **Observability:**
  - Structured logs with a bid id on every line.
  - OpenTelemetry traces from the HTTP request through Stripe, the transaction, the outbox and Redis to the SSE push.
  - Metrics for bid outcomes, hold latency, outbox lag and outstanding holds.
  - An alert on holds older than their bid's resolution.
- **Accessibility and performance:**
  - The bid form and live price work with a keyboard and a screen reader (`aria-live` on the price).
  - Lighthouse accessibility and performance in the green on the auction page.
- **Security basics:**
  - Secrets in the host's secret store.
  - Stripe webhook signatures verified.
  - Every input validated with zod.
  - Session cookies `HttpOnly` and `SameSite`.
  - Idempotency keys on every Stripe write.
  - gitleaks in CI.
- **CI/CD:** every PR runs lint, typecheck, unit and integration tests (Postgres and Redis service containers), a short load test with the invariant checker, Playwright and gitleaks. Merges to `main` deploy.

## Depth target
Current rung: 0 · Target rung: 3 (engineered)

## Build stack (in order)
1. TypeScript on Node.js LTS, a pnpm workspace with Fastify on the server, React with Vite on the client, and zod shared between them (ADR 0005).
2. PostgreSQL through Drizzle (schema and migrations), with raw SQL where row locks need it; Redis for pub/sub fan-out.
3. Stripe test mode: SetupIntent, manual-capture PaymentIntents, webhooks.
4. Vitest, Testcontainers, Playwright, k6.
5. OpenTelemetry, with traces exported to a free hosted backend.
6. Hosting: a container host that keeps connections open, with Postgres and Redis on hobby tiers (spec §13).
