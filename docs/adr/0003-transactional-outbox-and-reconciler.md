# 3. Transactional outbox for side effects, plus a reconciler

Date: 2026-11-22
Status: Accepted

## Context
Accepting a bid causes effects outside Postgres: cancel the previous high bid's hold, publish to Redis, and at close, capture the winner. If those happen inline after commit, a crash or a Stripe error between commit and effect leaves a hold on someone's card forever, or a viewer who never hears about a bid. Separately, a crash between authorizing and committing (ADR 0002) leaves a `pending` bid with a live hold.

## Options considered
1. **Inline after commit, with retries.** Simple, but a process death loses the effect for good.
2. **Transactional outbox.** The state change and the "effects to do" rows commit together. A worker on every instance claims rows (`FOR UPDATE SKIP LOCKED`), does the effect with an idempotency key and marks it done. Effects are at-least-once and must be idempotent.
3. **A message queue (Redis streams, SQS).** Durable, but the write to the queue and the database commit can't be atomic without the outbox anyway.
4. **Rely on Stripe webhooks to drive cleanup.** Webhooks can arrive late, twice or never, and they don't cover the Redis publish.

## Decision
Option 2, plus a **reconciler** on an interval. It settles `pending` bids older than a short threshold by reading their PaymentIntent, and it cancels any `requires_capture` hold whose bid isn't the current high or the winner. Webhooks only speed reconciliation up; they're never the only path.

## Why
"No orphaned holds" is the invariant that would hurt a real customer, so it can't depend on a process staying alive. The outbox makes every effect durable with the same transaction that justifies it, and the reconciler covers the one gap the outbox can't (before the commit).

## Consequences
- Every effect must be idempotent: Stripe idempotency keys derived from bid id and effect kind, and Redis events carrying the auction version so clients drop duplicates.
- Live updates go through the outbox, adding a small delay (the polling or notify interval). It's measured in traces; if it's too slow, the outbox worker can be woken with `LISTEN/NOTIFY` on a direct, unpooled connection.
- An outbox-lag metric and an orphaned-holds alert become part of the definition of done.
