# Case study: Holdfast

Holdfast is a live auction site where a bid counts only once a card hold covers it. This is what it set out to prove, how it's built, the evidence that it works, and how it was made, including what went wrong.

## The problem and the claim

Timed auctions with real money have to make two things true at the same moment: the highest bid wins, and the winner can pay. The common shortcuts each break one of them. Taking bids first and charging afterwards leaves unpaid winners and auctions to re-run. A flat deposit on file doesn't cover a bid bigger than the deposit. And naive check-then-insert code, under load, lets two bids at the same price both "win".

Holdfast's claim is narrow and testable: **a bid is accepted only after a Stripe authorization hold for its full amount exists, bids are ordered by one Postgres transaction under a row lock, and every hold that stops mattering is released.** The five invariants in [spec §7](spec.md#7-invariants-and-failure-modes) say it precisely, and everything else in the project exists to keep them true or to prove that they are.

## The design in brief

- **Hold, then commit** ([ADR 0002](adr/0002-hold-then-commit-bid-flow.md)). A bid is claimed with its idempotency key, the hold is placed at Stripe outside any transaction, and only then does one short transaction lock the auction row, check the rules and accept or refuse it. A bid that loses the race keeps nothing: its hold is released.
- **Side effects through an outbox** ([ADR 0003](adr/0003-transactional-outbox-and-reconciler.md)). Releasing holds, capturing the winner and announcing changes are rows written in the same transaction as the decision, then carried out by a worker with retries. A reconciler finishes anything a crash left half done.
- **Live updates over SSE, fanned out through Redis** ([ADR 0004](adr/0004-sse-with-redis-fanout.md)). Redis is only a doorbell; Postgres holds the content, so a missed message costs a refetch, never a wrong price.
- **TypeScript throughout** ([ADR 0005](adr/0005-typescript-stack.md)): Fastify, React, Drizzle and zod shared between server and page.
- **One PaymentIntent per bid, and a Stripe fake for load** ([ADR 0006](adr/0006-one-paymentintent-per-bid-and-stripe-fake.md)). Stripe's incremental authorization would have been neater, and was tried in test mode: a standard account isn't eligible.
- **Railway, all in one** ([ADR 0007](adr/0007-host-the-demo-on-railway.md)): two replicas, Postgres and Redis on one bill with a hard spending limit.

## The evidence

- **Correct under load.** A storm of about three thousand near-simultaneous bids at one auction, through two instances, ends with the invariant checker finding no violations: every accepted bid covered, strictly increasing, nothing after the close, no duplicate holds, every losing hold released and the winner captured ([the chart](load/storm.svg), [README](../README.md#correct-under-load)). CI runs a smaller storm with the same checker on every pull request.
- **Traced end to end.** One production bid's trace runs from the request, through the card hold and the locked decision, to the outbox and the live update on the other replica ([the picture](trace.svg)).
- **Watched in production.** Alerts for card holds with no live bid (counted from Stripe's side, not our own records), outbox work that gave up, and winners never charged. Each was fired once on purpose and resolved by following its [runbook](runbook.md).
- **Two people, two browsers.** The [README's GIF](../README.md) is recorded by a script against two server instances and real Stripe test mode, and the run fails unless Stripe's own record shows every losing hold released and the winner's captured.
- **Deployed from `main` only,** with a smoke test after every deploy ([deploy notes](deploy.md)).

## How it was built

AI-assisted with Claude Code. Dan owned the design, decisions and review.

- **Spec first.** The spec, the artifact spec and the first six ADRs came before any code, and were reviewed by a fresh-context pass that found real holes in the first draft.
- **One thin slice per pull request:** ten slices, this last one included, plus the spec and one rule change. Each began in plan mode with a written plan that said which invariant, failure mode or acceptance criterion justified anything new. Dan approved the plan, answered the open choices, and merged the result.
- **Dan's decisions are on record** in the spec and ADRs: splitting slices in two where they grew, open sign-in with rate limits, Railway over the spec's first pick, alerts as code, drills on a local stack, a drawn trace picture instead of a screenshot, demo auctions in rounds.
- **Every pull request says what went wrong.** The next section gathers them.

## What went wrong

Grouped by kind, with how each was caught.

**Wrong about the outside world.** These are the mistakes tests written from the same assumptions can't catch.
- Assumed a Stripe idempotency key always replays the original result. Stripe's docs say a `500` is saved and replayed for a day, and a concurrent request gets `409`. The reconciler would have left bids pending for a day. *Caught by reading the docs in the real-Stripe slice;* the fake now models both, and a teeth check fails without the fix.
- Assumed Drizzle's raw queries return timestamps as dates; they return strings, and every bid failed at first. *Caught by tests.*
- Assumed Node 26 container images still ship corepack. *Caught by the first Docker build.*
- Used Stripe's Payment Element, which offered bank debits and wallets that can't carry an off-session hold. *Caught by the by-hand real-card run;* the fake-mode tests had no card step to catch it.
- Assumed Railway's config-as-code file applies to a new service. It didn't, so migrations never ran on the first deploys. *Caught in production;* deploy settings moved to Railway's infrastructure-as-code file.
- The spec's own hosting pick (Fly.io with Neon and Upstash) couldn't meet the budget-alarm rule. *Caught by checking current facts before deploying.*

**Tests that passed for the wrong reason.**
- Two load runs "passed" with no bids at all: a sign-in rate limit stopped the setup, and nothing required bids to have happened. *Caught by reading the numbers;* runs now require accepted bids.
- The first storm decided retries before anything was sent, so it never retried. *Caught by the storm's own non-triviality check,* which existed for exactly this.
- Random fault rates could produce no faults in a run. *Caught by the same check;* faults are now deterministic.
- The fire drills first ran against the shared dev database, full of failures from earlier load runs, so an alert was already firing before the drill broke anything. *Caught when a drill "fired" in fourteen seconds;* each drill now gets a fresh database and waits for a normal baseline.

**Real bugs the design's own checks found.**
- When the handler and the reconciler both decided the same losing bid, two cancellations were queued. No money was at risk, but the checker failed about one run in forty. *Caught by the storm.*
- Each server process had its own Stripe fake, so a hold placed through one instance couldn't be cancelled through the other. *Caught by the end-to-end invariant checker.*
- Shutdown hung while any live stream was open. *Caught by hand* when dev servers ignored a stop signal; a regression test now hangs on the old code.
- Every Stripe call was traced twice, and each replica started a stray trace every thirty seconds. *Caught by reading the first production trace.*

**Operational slips.**
- Pushed a commit before reading the secret scan, which had flagged a made-up key in a test. A force-push was rightly refused; follow-up commits and a reviewed ignore entry fixed it.
- Ran a formatter over the merged ADRs, which must never change. *Caught before pushing;* Markdown is now excluded.
- A placeholder in the setup instructions (an endpoint with a literal "…") was copied into the env files, and the check of those files only looked at the prefix and suffix. A whole drill ran with no telemetry and no error. *Caught by the drill timing out;* the scripts now refuse anything that isn't a real gateway address.
- Filled the disk once with a Homebrew build from source and once with Docker build cache, until Docker hung. *Caught by the failures they caused;* cleaned up with Dan's OK.

**Where Dan corrected the approach.**
- The first spec gated the project on a skills score. Dan dropped it: the project is justified by its problem, and "problem first" became the rule every plan has to meet.
- Early deploy instructions had Dan move secret values by hand. Dan asked why not use the command line; since then every secret goes through scripts that print variable names only.
- The trace screenshot was a manual step whose point wasn't clear. Dan asked for another way; the picture is now drawn from the trace data and can be redrawn from any trace id.

The pattern is consistent. The mistakes clustered where knowledge of an outside system was stale or assumed, and where a test could pass without exercising anything. The defences that worked were the ones built in on purpose: checking current docs before relying on them, non-triviality checks in every test that could pass vacuously, a teeth check for every guard (remove the fix, watch the test fail), and a by-hand run against the real service where fakes can't see.

## What's next

From the spec's stretch goals:
- **Soft close:** a bid in the final moments extends the auction. It touches the bid transaction and invariant 3, so it deserves its own slice and tests.
- **Proxy bidding:** a maximum the system bids up to on your behalf, which would need an ADR superseding one PaymentIntent per bid.
- **A Go bid-storm CLI,** for load runs from outside the Node toolchain.
