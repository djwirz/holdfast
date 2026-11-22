# Deploying the demo

The demo runs on Railway (ADR 0007): one service with two replicas built from the `Dockerfile`, plus Railway Postgres and Redis. Deploy settings are in `railway.json`. This page covers what only a person with the accounts can do, and how to operate it.

Secrets go in Railway's variables, never in the repo, chat, logs or PR text.

## First-time setup, in this order

### 1. Budget alarm, before anything else
1. Create a Railway account and choose the Hobby plan.
2. In the workspace's **Usage** settings, set:
   - a **hard limit** of $10 (the minimum). Reaching it stops every service until it's raised.
   - an **email alert** below it, at $7 or Railway's lowest threshold.
3. Nothing is deployed until this exists (CLAUDE.md, spec §3).

### 2. Project and services
1. New project → **Deploy from GitHub repo** → this repository. Railway reads `railway.json`: Dockerfile build, two replicas, health check at `/api/healthz`, migrate and seed before each deploy.
2. Add **Postgres** and **Redis** to the project (Railway's templates).
3. On the app service, under **Networking**, generate a public domain. It's `APP_ORIGIN` below.

### 3. GitHub sign-in
Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps):
- **Homepage URL:** the public domain.
- **Authorization callback URL:** `https://<domain>/api/auth/github/callback`.

### 4. Stripe webhook (test mode)
**The easy way:** run this, using the test key in `.env.local`:

```bash
pnpm stripe:webhook --domain <domain>
```

It creates the endpoint with the four events below and writes its signing secret into `.env.railway` as `STRIPE_WEBHOOK_SECRET` without showing it. Stripe reveals that secret only once, when the endpoint is created. If an endpoint for the URL already exists, the script leaves it alone and says where its secret is.

**By hand:** in the Stripe dashboard (test mode) → Developers → Webhooks, add an endpoint:
- **URL:** `https://<domain>/api/stripe/webhook`.
- **Events:** `payment_intent.amount_capturable_updated`, `payment_intent.canceled`, `payment_intent.succeeded`, `payment_intent.payment_failed`.

Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

### 5. Variables on the app service
**The easy way: from your local env files, with nothing pasted.** Put the production-only values in `.env.railway` at the repo root. It's gitignored and kept out of the image, like `.env.local`.

```text
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
STRIPE_WEBHOOK_SECRET=whsec_…   # the dashboard endpoint's secret, not `stripe listen`'s
```

The Stripe test keys come from `.env.local` unless `.env.railway` overrides them. Then:

```bash
brew install railway
railway login
railway link              # pick the project and environment
pnpm railway:env --service <app service name> --domain <domain> --dry-run
pnpm railway:env --service <app service name> --domain <domain>
```

What the script does:
- **Checks first:** test-mode Stripe keys only, and every required value present.
- **One change:** sets everything in one call, so one redeploy.
- **Prints variable names only.**
- **Session secret:** it creates `SESSION_SECRET` once and never replaces it, since a new one would rename every bidder mid-auction.
- **Doesn't print values:** it never runs a bare `railway variables`, which would.

The table below is what it sets, for setting them by hand instead.

| Variable | What it is | Where it comes from |
|---|---|---|
| `NODE_ENV` | `production` | type it |
| `APP_ORIGIN` | the public origin, `https://…` (no trailing slash) | step 2 |
| `DATABASE_URL` | Postgres on the private network | a reference to the Postgres service's `DATABASE_URL` |
| `REDIS_URL` | Redis on the private network | a reference to the Redis service's `REDIS_URL` |
| `SESSION_SECRET` | keys bidder aliases; 32+ random characters | e.g. `openssl rand -base64 48`, pasted straight into Railway |
| `STRIPE_SECRET_KEY` | `sk_test_…`; the server refuses anything else | Stripe dashboard, test mode |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…`, sent to the page for the card form | Stripe dashboard, test mode |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | step 4 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the OAuth app | step 3 |
| `OUTBOX_INTERVAL_MS`, `LIFECYCLE_INTERVAL_MS` | `250` and `1000`: polling with two replicas | type them |

`PORT` is set by Railway. `WEB_DIST` is set in the image. `DEV_SIGN_IN` must not be set: the server refuses to start with it in production.

### 6. Deploy on merge
- In the app service's settings, set the deploy branch to `main` and turn on **Wait for CI**. Railway then deploys only commits whose GitHub checks passed.
- In the GitHub repository, add the variable `SMOKE_URL` (Settings → Secrets and variables → Actions → Variables) with the public origin. The smoke workflow runs after each successful deploy.

## Operating it
- **Logs:** Railway → the app service → Deployments → a deploy → Logs. Each replica logs its own lines.
- **Smoke test by hand:** run this with the public origin:

  ```bash
  SMOKE_URL=https://<domain> pnpm test:smoke
  ```
- **Migrations** run before every deploy (`preDeployCommand`). If one fails, the deploy stops and the previous one keeps serving.
- **A fresh demo auction:** the seed runs before every deploy and creates the demo auctions if none is live. To run it without a deploy, from a machine with the Railway CLI linked to the project:

  ```bash
  railway run node server/src/seed.ts
  ```
- **Roll back:** Railway → Deployments → an earlier successful deploy → **Redeploy**. A migration isn't undone by a rollback. Migrations are written to be additive, so the previous code still runs against the newer schema.
- **Over budget:** the email alert arrives first. At the hard limit Railway stops the services. Raise or remove the limit to bring them back, and they redeploy on their own.
