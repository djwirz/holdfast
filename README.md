# Holdfast

Real-time auctions where a bid counts only once a Stripe authorization hold covers it. Bids are ordered in a Postgres transaction and every bidder sees updates live. A load test of near-simultaneous bids proves the ordering holds, and one bid can be traced end to end.

**Status:** slice 5 of 7 (deploying to Railway: two replicas, Postgres and Redis, deploys from `main` after CI, a smoke test after each deploy; see [docs/deploy.md](docs/deploy.md)). Two people in two browsers can bid against each other and see every change live; each bid places a real test-mode card hold; proven by a storm with injected crashes and failures, and Playwright end to end. Design: [docs/spec.md](docs/spec.md) and [docs/adr/](docs/adr/). Stripe test mode only; no real money moves.

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
```

After changing `server/src/db/schema.ts`, run `pnpm db:generate` and commit the new migration in `server/drizzle/`.
