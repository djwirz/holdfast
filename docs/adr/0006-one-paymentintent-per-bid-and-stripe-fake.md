# 6. One PaymentIntent per bid, and a Stripe fake for load

Date: 2026-11-22
Status: Accepted

## Context
Each accepted bid needs a hold for its full amount (ADR 0002). A bidder often raises their own bid several times. Stripe offers incremental authorization (raising an existing hold), but its docs limit it to certain card networks and account types, and it's unconfirmed whether test mode supports it here. Separately, the concurrency and load tests need hundreds or thousands of authorizations quickly. Stripe test mode has lower rate limits than live mode, and hammering it is both slow and rude.

## Options considered
For the hold:
1. **One PaymentIntent per bid.** A new manual-capture PaymentIntent for each bid. The hold of the bid it outbids, whoever placed it, is canceled once the new bid commits. It works with every card, and each bid's coverage is independent and easy to audit. The cost is more Stripe calls, and a bidder who raises their own high bid has two holds on their card for a moment.
2. **One PaymentIntent per bidder per auction, incrementally authorized.** Fewer objects, and it's what a real marketplace would want, but its availability is uncertain and it adds a failure mode (an increment that's declined while the old amount is still held).

For tests:
1. **Mock the Stripe SDK in each test.** Fast, but it tests the mocks.
2. **`stripe-mock`.** Stripe's official API mock, but stateless: it doesn't model a PaymentIntent moving from `requires_capture` to `canceled`, which the invariants depend on.
3. **An in-process stateful fake** of the PaymentIntent subset Holdfast uses, behind the same `Payments` port as the real client, with injectable latency, declines and errors after authorizing. A small opt-in suite runs the same scenarios against real test mode.

## Decision
One PaymentIntent per bid. Tests and load runs use a stateful in-process Stripe fake behind the `Payments` port, with an opt-in real-test-mode suite run before payment-touching merges.

## Why
Per-bid holds work everywhere and make invariant 1 trivially auditable (one bid, one PaymentIntent). The fake makes the concurrency claims testable at volume and makes failure injection possible, which real test mode can't do on demand. The real-mode suite keeps the fake honest.

## Consequences
- The fake can drift from Stripe's behavior. The opt-in suite is the guard, and any difference it finds becomes a test against the fake.
- Load-test throughput figures are for Holdfast with simulated Stripe latency, and the README says so.
- If incremental authorization works in test mode (spec §13), a new ADR may supersede the hold half of this one.
