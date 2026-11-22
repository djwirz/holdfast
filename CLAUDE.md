# holdfast: instructions for Claude

Real-time auctions where a bid counts only once a Stripe test-mode authorization hold covers it. Bids are ordered in a Postgres transaction, every bidder sees updates live, and a load test proves the ordering holds under near-simultaneous bids. Use they/them for Dan.

## Status
Planning: `docs/spec.md` and ADRs 0001–0006 are proposed in PR #1 (the ADRs say `Accepted`; merging accepts them). Open questions are in spec §13; settle each one by the slice it names, and the rest before slice 1. The judgment behind the project is in `docs/artifact-spec.md`.

## How we work
- Pull requests only; never push to `main`. Merged PRs are the project's record.
- Spec first, then one thin end-to-end slice per PR (spec §12). Start each slice in plan mode.
- Every decision that would be expensive to reverse gets an ADR in `docs/adr/` (format: ADR 0001). Don't decide silently in code.
- ADRs are written as `Accepted` in the PR that adds them; merging is the acceptance. Never rewrite a merged ADR's decision: add a new ADR that supersedes it.
- When the spec and the code disagree, stop and ask; update the spec in the same PR if the decision changes.
- Built with Claude Code in the open: the case study gets a section on how AI was used and where it was wrong, so note real mistakes in PR descriptions.

## Constraints
- Never employer code, data or names beyond what's public. Stripe **test mode** only (`sk_test_` keys); synthetic data only.
- TypeScript on Node.js here. That's the point of this project, which is why it isn't Python.
- Free tiers first; a budget alarm on any paid hosting account before anything is deployed.
- Secrets never in the repo, logs or PR text.
- Target depth: deployed, tests and CI, ADRs, observability.
- Numbers in docs: honest estimates in words, never false precision.

## Invariants (spec §7): never break these
1. **Covered:** no bid is `accepted` unless its PaymentIntent was in `requires_capture` for at least the bid amount before the accepting transaction committed.
2. **Ordered:** accepted bids start at or above `starting_price`, strictly increase by at least `min_increment` in commit order, and exactly one is the current high.
3. **Closed is closed:** no bid is accepted at or after `ends_at` by database time.
4. **No orphaned holds:** once the outbox and reconciler are idle, the only live holds are the current high's (open) and the winner's (closed or settled).
5. **Idempotent:** a retry with the same user and key never creates a second hold or bid.
