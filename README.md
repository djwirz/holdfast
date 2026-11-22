# Holdfast

Real-time auctions where a bid counts only once a Stripe authorization hold covers it. Bids are ordered in a Postgres transaction and every bidder sees updates live. A load test of near-simultaneous bids proves the ordering holds, and one bid can be traced end to end.

**Status:** planning. Design: [docs/spec.md](docs/spec.md) and [docs/adr/](docs/adr/). Stripe test mode only; no real money moves.
