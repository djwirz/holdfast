#!/usr/bin/env bash
# The stack a load run targets: the shared Stripe fake (with latency and failures injected)
# and two server instances behind the round-robin proxy on :3000, all with dev sign-in and
# no rate limit worth hitting. Postgres and Redis come from `docker compose up`.
set -euo pipefail
cd "$(dirname "$0")/../server"
export NODE_ENV=development DEV_SIGN_IN=1 STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY=
export APP_ORIGIN="${ORIGIN:-http://localhost:3000}"
export SESSION_SECRET="${SESSION_SECRET:-load-only-not-a-secret-00000000000000}"
export BID_RATE_LIMIT="${BID_RATE_LIMIT:-100000}"
export AUTH_RATE_LIMIT="${AUTH_RATE_LIMIT:-100000}"
# The storm's failure mix (server/test/concurrency.test.ts), at HTTP.
export FAKE_LATENCY_MS="${FAKE_LATENCY_MS:-150-500}"
export FAKE_DECLINE_RATE="${FAKE_DECLINE_RATE:-0.03}"
export FAKE_LOST_RESPONSE_RATE="${FAKE_LOST_RESPONSE_RATE:-0.03}"
export FAKE_SERVER_ERROR_EVERY="${FAKE_SERVER_ERROR_EVERY:-25}"
export FAKE_CANCEL_FAULT_RATE="${FAKE_CANCEL_FAULT_RATE:-0.1}"
exec node src/dev/two-instances.ts
