#!/usr/bin/env bash
# One load run (spec §10): seed a short auction, storm it with k6 through the running stack,
# then run the invariant checker. Exits non-zero on a k6 threshold failure or any violation.
# Needs the stack up: Postgres and Redis, plus `pnpm load:stack` (or the CI job's equivalent).
#   VUS=30 BIDS_PER_VU=10 ENDS_IN=20 pnpm load
set -euo pipefail
cd "$(dirname "$0")/.."

K6_IMAGE="grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8"
VUS="${VUS:-30}"
BIDS_PER_VU="${BIDS_PER_VU:-10}"
ENDS_IN="${ENDS_IN:-20}"
RUN="${RUN:-$(date +%Y%m%d-%H%M%S)}"
ORIGIN="${ORIGIN:-http://localhost:3000}"
mkdir -p load/results

auction=$(cd server && node --env-file-if-exists=../.env.local src/seed-e2e.ts "$ENDS_IN" "Load storm $RUN" | tail -1 |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).id)')
echo "auction $auction: $VUS bidders x $BIDS_PER_VU bids, ends in ${ENDS_IN}s"

status=0
# As this user, so k6 can write its results into the mounted folder on Linux too (CI);
# the image's own user can't. Docker Desktop on a Mac hides the difference.
docker run --rm --add-host=host.docker.internal:host-gateway --user "$(id -u):$(id -g)" \
  -v "$PWD/load:/load" \
  -e BASE="${BASE:-http://host.docker.internal:3000}" -e ORIGIN="$ORIGIN" -e AUCTION_ID="$auction" \
  -e VUS="$VUS" -e BIDS_PER_VU="$BIDS_PER_VU" -e ENDS_IN="$ENDS_IN" -e RUN="$RUN" \
  "$K6_IMAGE" run --quiet --out "json=/load/results/$RUN.k6.json" /load/storm.ts || status=$?

(cd server && node --env-file-if-exists=../.env.local src/check-invariants.ts \
  --auction "$auction" --wait 150 --out "../load/results/$RUN.check.json") || status=$?

echo "results: load/results/$RUN.*"
exit "$status"
