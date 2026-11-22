# Holdfast

Real-time auctions where a bid counts only once a Stripe authorization hold covers it. Bids are ordered in a Postgres transaction and every bidder sees updates live. A load test of near-simultaneous bids proves the ordering holds, and one bid can be traced end to end.

**Status:** slice 4a of 7 (the server is live: HTTP API, sign-in, and bids streamed to every viewer over SSE, fanned out across two instances through Redis; real Stripe test mode behind the payments port; proven by a storm with injected crashes and failures). The browser page comes in 4b. Design: [docs/spec.md](docs/spec.md) and [docs/adr/](docs/adr/). Stripe test mode only; no real money moves.

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

Two server instances behind a round-robin proxy on :3000, with the Stripe fake unless `.env.local` has a test key:

```bash
pnpm dev:server
```

With `DEV_SIGN_IN=1`, `POST /auth/dev {"login":"ann"}` signs in without GitHub (development only), so `curl` can bid and watch `GET /auctions/:id/events`.

After changing `server/src/db/schema.ts`, run `pnpm db:generate` and commit the new migration in `server/drizzle/`.
