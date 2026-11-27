# Holdfast

Real-time auctions where a bid counts only once a Stripe authorization hold covers it. Bids are ordered in a Postgres transaction and every bidder sees updates live. A load test of near-simultaneous bids proves the ordering holds, and one bid can be traced end to end.

![Two bidders in two browsers bid on the same auction; each bid appears live on the other page, until the auction ends and one wins](docs/demo.gif)

Two bidders, two browsers, two server instances, real Stripe test-mode card holds. Each bid shows up live on the other page, and at the close Stripe's own record is checked: every losing hold released, the winner's captured. Recorded locally by `pnpm demo:gif`, which fails if that check fails.

**Live demo:** https://holdfast-production-ba968615.up.railway.app (Stripe test mode: use card 4242 4242 4242 4242; no real money moves). The demo auctions run in rounds, so one is always open.

**Status:** v1 is complete: every acceptance criterion in [spec §11](docs/spec.md#11-acceptance-criteria-v1-done-depth-3) is met. Deployed on Railway with two replicas ([docs/deploy.md](docs/deploy.md)), traced and alerted ([docs/runbook.md](docs/runbook.md)). Design: [docs/spec.md](docs/spec.md) and [docs/adr/](docs/adr/). How it was built: [docs/case-study.md](docs/case-study.md).

## Correct under load

![Bid outcomes over time for 3,000 near-simultaneous bids at one auction; the invariant checker found 0 violations](docs/load/storm.svg)

Two hundred bidders sent 3,000 bids at one auction in about 74 seconds, through two server instances and Redis on a laptop. Most of them chased a price that had already moved and lost the race under the row lock, as they should. Afterwards the invariant checker found **zero violations**: every accepted bid was covered by a hold and strictly higher than the last, nothing was accepted after the auction ended, no retry made a second bid or hold, and all 2,079 losing holds were released with the winner's captured.

Throughput, honestly: the run peaked at about 110 bids a second (55 in the busiest half second), with a median response of about 320ms and a 95th percentile of about 530ms. Most of that time is the simulated card hold, which takes 150–500ms (ADR 0006: load runs use a Stripe fake, since Stripe's test mode allows about 25 requests a second). The bids are paced to straddle the auction's end, so this is a correctness test under heavy contention, not a measurement of the ceiling. CI runs a smaller storm with the same checker on every PR.

## One bid, traced

![One production bid's trace as a waterfall: the request, the card hold, the locked decision, the outbid hold's release and the live update, across both replicas](docs/trace.svg)

A real bid on the deployed demo, drawn from its trace in Grafana Cloud. One replica takes the request: it claims the bid, places the card hold at Stripe (about half a second, most of the request), and decides it under the auction's row lock in about 20ms. Then its outbox releases the outbid bidder's hold and publishes the change. The trace context travels inside the outbox row and the Redis message, so the fan-out on the other replica lands in the same trace, as does the write down the open live connection. `node scripts/trace-chart.ts <trace id>` redraws it from any trace.

Alerts watch for the failures a trace alone wouldn't catch: card holds with no live bid behind them (read from Stripe, not our own records), outbox work that gave up, and winners never charged. Each has a [runbook](docs/runbook.md) and has been fired once on purpose.

## Local development

Needs Node.js 26 (see `.nvmrc`), corepack, and Docker.

```bash
fnm use                      # or nvm use: Node 26 from .nvmrc
corepack enable              # pnpm at the version in package.json
pnpm install
cp .env.example .env.local   # placeholders for local Postgres and Redis
docker compose up -d --wait  # Postgres and Redis
pnpm db:migrate
pnpm seed                    # two demo auctions; safe to run again
```

Checks, as CI runs them:

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test:unit               # auction rules, no Docker needed
pnpm test:integration        # starts its own Postgres with Testcontainers
```

The real Stripe suite is by hand, never in CI. Put a test-mode key (`sk_test_…`) in `.env.local` as `STRIPE_SECRET_KEY`, then:

```bash
pnpm test:live               # real holds in your Stripe sandbox; skips without a key
```

The page on http://localhost:5173, with two server instances behind a round-robin proxy on :3000. It uses the Stripe fake unless `.env.local` has test keys; with `DEV_SIGN_IN=1` the page offers a dev sign-in, no GitHub app needed:

```bash
pnpm dev
```

End to end, as CI runs it (the fake), and the real-card flow by hand:

```bash
pnpm exec playwright install chromium   # once
pnpm test:e2e
pnpm test:e2e:stripe                    # needs sk_test_ and pk_test_ keys in .env.local
pnpm demo:gif                           # re-records docs/demo.gif the same way (Docker for ffmpeg)
```

After changing `server/src/db/schema.ts`, run `pnpm db:generate` and commit the new migration in `server/drizzle/`.
