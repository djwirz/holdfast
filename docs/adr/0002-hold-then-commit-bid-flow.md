# 2. Hold first, then commit under a row lock

Date: 2026-11-22
Status: Accepted

## Context
A bid must count only if (a) a Stripe authorization covers its full amount and (b) it beats the current high bid at the moment it's recorded. The authorization is a network call that can take from a fraction of a second to a few seconds. Holding a database lock across it would make every bidder on the auction wait for the slowest card. Near-simultaneous bids are the normal case at the end of an auction.

## Options considered
1. **Hold, then commit.** Pre-check without a lock, insert the bid as `pending`, authorize, then take the auction row lock (`SELECT … FOR UPDATE`), recheck and accept or mark `lost_race`. No lock is held across the network. Losers' holds must be canceled afterwards, and some authorizations are wasted on bids that lose the race.
2. **Reserve, then hold.** Lock, record the bid as the tentative high, release the lock, authorize, then confirm or roll back. No wasted authorizations, but other bidders see a high bid that might evaporate. Every bid after it has to wait for it or be checked against it, and rollback logic spreads everywhere.
3. **Lock across the authorization.** The simplest code and strictly ordered by arrival, but throughput on a hot auction collapses to one Stripe round trip at a time, and one slow card stalls everyone.
4. **Charge after close.** No holds at all. That brings back the unpaid-winner problem the project exists to solve.

## Decision
Option 1: hold first, then commit under a row lock in one transaction. **Commit order is the bid order.**

## Why
It keeps the critical section to a few milliseconds of database work. The money guarantee is that no accepted bid is ever uncovered, and that's absolute. The cost is wasted authorizations on races that are lost, which is cheap in test mode and bounded by the pre-check in practice. Because the `pending` row is written before Stripe is called, a crash at any point leaves something the reconciler can find (ADR 0003).

## Consequences
- A bidder who clicked first can lose a tie to one whose authorization returned faster. This is stated in the UI and the case study. Ordering by arrival would need option 2's tentative state.
- Every lost or outbid bid creates a cancellation the outbox must carry out. Invariant 4 (no orphaned holds) depends on ADR 0003.
- The concurrency test and load-test checker must inject Stripe latency, or this design is never really exercised.
- Revisit if proxy bidding is added: a hold on a bidder's maximum changes the flow.
