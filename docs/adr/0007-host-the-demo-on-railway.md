# 7. Host the demo on Railway

Date: 2026-11-22
Status: Accepted

## Context
Slice 5 deploys the `demo` environment (spec §12). The host has to:
- keep long-lived SSE connections open;
- run at least two instances (ADR 0004);
- provide or reach Postgres and Redis;
- cost "a few dollars a month at most" (spec §3);
- above all, have a budget alarm before anything is deployed (CLAUDE.md; spec §3 lists it under "never cut").

One property of Holdfast narrows the field: every instance runs background loops (outbox worker, close job, reconciler) that query Postgres several times a second. A database that scales to zero when idle never gets to.

Facts checked in November 2026:
- **Fly.io:**
  - No free allowance for new accounts. The smallest machine is about $2.19 a month ([Fly pricing](https://fly.io/docs/about/pricing/)).
  - Fly's own docs say it doesn't support billing alerts, and its staff say spending can't be capped ([cost management](https://fly.io/docs/about/cost-management/)).
- **Neon:**
  - The free plan gives 100 compute-hours a month and scales to zero after five idle minutes ([Neon free plan](https://neon.com/faqs/free-plan-limits-and-quotas)).
  - Our loops keep it awake, so a month needs roughly 180 hours at the smallest size, which is a paid plan.
- **Upstash Redis:** the free tier gives 500K commands a month ([Upstash pricing](https://upstash.com/pricing/redis)), which is enough here.
- **Railway:**
  - Hobby is $5 a month, including $5 of usage. Usage is billed per second at $10 per GB of RAM and $20 per vCPU a month ([Railway plans](https://docs.railway.com/pricing/plans)).
  - A workspace can set an email alert and a hard usage limit ($10 minimum) that stops its services when reached.
  - Postgres and Redis run on its private network, and a service can run several replicas.
  - Its edge caps an HTTP request at about 15 minutes and closes one idle for long ([SSE on Railway](https://docs.railway.com/guides/sse-vs-websockets)).
- **Render:**
  - About $7 a month per Starter instance, so two instances cost about $14 before any database.
  - Its spend limit stops builds rather than capping running costs.

## Options considered
1. **Railway, all in one:**
   - One account and one bill, with a native hard limit and alerts as the budget alarm.
   - Two replicas of one service, Postgres and Redis alongside.
   - Estimated $5–8 a month at demo volume.
2. **Fly.io for the app, Neon for Postgres, Upstash for Redis:**
   - The most control over machines and regions, and no request-duration cap.
   - But three accounts, Neon on a paid plan, and no native budget alarm. The alarm would have to come from outside, such as a capped virtual card.
3. **Render:** simple, but the most expensive for two instances, with a weaker spending control.

## Decision
Host the demo on Railway: one service with two replicas running the Docker image, plus Railway Postgres and Redis on the private network. The workspace hard usage limit is $10, with an email alert below it, set before the first deploy. Deploys come from `main` through Railway's GitHub integration, which waits for CI. A smoke test runs against every successful deploy.

## Why
- **Budget alarm:** it's the only option whose budget alarm is part of the platform, and it stops spending rather than only reporting it.
- **Cost:** keeping the database awake costs a few dollars of RAM, not a plan upgrade.
- **Two instances** are a setting (`numReplicas`), so the fan-out claim is tested where it's deployed.
- **Reviewable config:** the project's deploy settings live in `.railway/railway.ts`, so they're reviewed like code. That file is Railway's infrastructure-as-code format: `railway config plan` previews changes, and `railway config apply` makes them. Railway retired the older `railway.json` ("Config as Code"): services created after the change can't use it, and existing files stop being read on 2026-12-01 ([Railway IaC](https://docs.railway.com/infrastructure-as-code)).

## Consequences
- **SSE cap:** Railway's edge ends an SSE request after about 15 minutes. That's handled by design:
  - The stream sends a heartbeat every 15 seconds.
  - `EventSource` reconnects with `Last-Event-ID`.
  - The server replays the missed versions from Postgres (ADR 0004).

  A cap costs a reconnect, never an event.
- **Hitting the hard limit takes the demo offline** until it's raised. That's the intended failure for a test-mode demo.
- **Less control than Fly** over machines and regions. Nothing in Holdfast needs it yet.
- **The exit stays cheap.** The image is a plain Dockerfile with no Railway-specific code, and configuration is environment variables. Moving means another host, a `DATABASE_URL` and a `REDIS_URL`.
- **The IaC file describes the whole project.** Leaving out a resource means deleting it, so it was started from `railway config pull` (the real project, Postgres and Redis included). Destructive changes need explicit confirmation. Variables are unmanaged: secrets stay in Railway and never appear in the file.
- **Revisit** if Railway's pricing or limits change, or if the demo outgrows a hobby budget.
