# 5. TypeScript stack: Fastify, Drizzle, React with Vite, pnpm workspace

Date: 2026-11-22
Status: Accepted

## Context
Holdfast is the roadmap's TypeScript and Node.js project; the other projects lean on Python. It needs:
- an HTTP server that can hold SSE connections and run background loops (outbox, reconciler, close job);
- precise control over transactions and row locks;
- a small client for the bidding page;
- types shared between server and client.

Dan has used Next.js and Drizzle before (`djwirz/vending`).

## Options considered
1. **Next.js full stack.** Familiar, and one framework. But its server runtime targets request/response and serverless deploys, so long-lived SSE and background workers fight it, and they're the core of this project.
2. **Fastify server and React with Vite, in a pnpm workspace** (`server`, `web`, `shared`). It's a plain long-running Node process, with first-class schema validation and plugins, and the client is a static build the server can serve.
3. **NestJS.** Batteries included, but a lot of ceremony for a small service, and it hides the parts worth showing.

For data access:
- **Drizzle:** typed schema and migrations, and `FOR UPDATE` is supported. Raw SQL is available where it's clearer.
- **Kysely:** a query builder with great types, but no migrations story of its own.
- **Prisma:** its row-lock and transaction control is more awkward.

## Decision
Option 2 with Drizzle (raw SQL for the locking transaction where clearer), zod in `shared` for request and event schemas, Vitest, Testcontainers, Playwright and k6. Node.js current LTS.

## Why
The interesting parts of the project are long-lived connections, background workers and explicit transactions, and a plain Fastify process makes them visible instead of fighting a framework for them. Drizzle builds on what Dan already knows.

## Consequences
- More wiring by hand than Next.js (routing on the client, serving static assets), which is acceptable for one page plus sign-in.
- One deployable container serves the API, SSE and the built client, which keeps hosting simple.
- If the project ever wants server rendering or SEO, revisit the client side only.
