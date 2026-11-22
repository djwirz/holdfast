// The k6 storm (spec §10, §11.2): many bidders, each on its own session, fire bids at one
// auction near-simultaneously through the round-robin proxy, so bids, holds, cancellations
// and streams land on both instances. Bidders act on a stale view of the price, some retry
// a key (the same amount must dedupe, a changed one must 422), and the auction ends partway
// through. Afterwards the invariant checker must find zero violations (load/run.sh).
//
// Local stack only: it signs in through the dev route, which production refuses.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV['BASE'] ?? 'http://host.docker.internal:3000';
const ORIGIN = __ENV['ORIGIN'] ?? 'http://localhost:3000';
const AUCTION = __ENV['AUCTION_ID'] ?? '';
const VUS = Number(__ENV['VUS'] ?? 30);
const BIDS_PER_VU = Number(__ENV['BIDS_PER_VU'] ?? 10);
const ENDS_IN = Number(__ENV['ENDS_IN'] ?? 20);
const RETRY_RATE = Number(__ENV['RETRY_RATE'] ?? 0.1);
// Spread each bidder's bids over about 1.4x the auction, so a share lands after it ends.
const GAP = (ENDS_IN * 1.4) / BIDS_PER_VU;

export const options = {
  scenarios: {
    storm: { executor: 'per-vu-iterations', vus: VUS, iterations: BIDS_PER_VU, maxDuration: '5m' },
  },
  thresholds: {
    // Any 5xx, or an answer the API never gives, fails the run.
    unexpected_responses: ['count==0'],
    checks: ['rate==1'],
    // A run where bids never happened proves nothing: nearly every planned bid must get an
    // outcome (a few may still be retrying when the run ends).
    bid_outcome: [`count>=${String(Math.floor(VUS * BIDS_PER_VU * 0.9))}`],
  },
  setupTimeout: '2m',
};

const outcomes = new Counter('bid_outcome');
const unexpected = new Counter('unexpected_responses');
const latency = new Trend('bid_latency', true);
const pendingRate = new Rate('bid_pending');

export function setup(): { cookies: string[] } {
  if (!AUCTION) throw new Error('set AUCTION_ID');
  const cookies: string[] = [];
  for (let i = 0; i < VUS; i++) {
    const res = http.post(`${BASE}/api/auth/dev`, JSON.stringify({ login: `load${String(i)}` }), {
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    });
    const session = res.cookies['holdfast_session']?.[0]?.value;
    if (res.status !== 204 || !session)
      throw new Error(`sign-in ${String(i)} failed: ${String(res.status)}`);
    cookies.push(`holdfast_session=${session}`);
  }
  return { cookies };
}

interface Sent {
  key: string;
  amount: number;
}
// Per VU (k6 runs each VU in its own JS runtime), so retries reuse this bidder's own keys.
const sent: Sent[] = [];

export default function storm(data: { cookies: string[] }): void {
  sleep(Math.random() * GAP);
  const cookie = data.cookies[(__VU - 1) % data.cookies.length] ?? '';
  const headers = { 'content-type': 'application/json', origin: ORIGIN, cookie };

  // The price as this bidder last saw it: often already stale by the time the bid lands.
  const snap = http.get(`${BASE}/api/auctions/${AUCTION}`, {
    headers: { cookie },
    tags: { name: 'snapshot' },
  });
  const auction = (snap.json('auction') ?? {}) as { minimumNextBid?: number | null };
  const minimum = auction.minimumNextBid ?? 1_000;

  // Scoped to this auction: the load bidders keep their logins across runs, and a key
  // reused for another auction is (rightly) a 422.
  let key = `${AUCTION.slice(0, 8)}-vu${String(__VU)}-it${String(__ITER)}`;
  let amount = minimum + [0, 0, 0, 100, 200][Math.floor(Math.random() * 5)]!;
  let expectConflict = false;
  let isRetry = false;
  const previous = sent[Math.floor(Math.random() * sent.length)];
  if (previous && Math.random() < RETRY_RATE) {
    key = previous.key;
    isRetry = true;
    expectConflict = Math.random() < 0.3;
    amount = expectConflict ? previous.amount + 100 : previous.amount;
  } else {
    sent.push({ key, amount });
  }

  const started = Date.now();
  const res = http.post(`${BASE}/api/auctions/${AUCTION}/bids`, JSON.stringify({ amount }), {
    headers: { ...headers, 'idempotency-key': key },
    tags: { name: 'bid' },
  });
  latency.add(Date.now() - started);

  if (res.status === 422) {
    check(res, { 'a changed amount on a reused key is refused': () => expectConflict });
    outcomes.add(1, { outcome: 'conflict' });
    return;
  }
  if (res.status === 429) {
    outcomes.add(1, { outcome: 'rate_limited' });
    return;
  }
  if (res.status !== 201 && res.status !== 202) {
    unexpected.add(1, { status: String(res.status) });
    return;
  }
  check(res, { 'the same amount on a reused key replays the bid': () => !expectConflict });

  let bid = res.json('bid') as { id: string; status: string; reason: string | null };
  pendingRate.add(bid.status === 'pending');
  // 202: the hold is still being placed. Follow the bid as the page does.
  for (let i = 0; bid.status === 'pending' && i < 120; i++) {
    sleep(0.5);
    const poll = http.get(`${BASE}/api/bids/${bid.id}`, {
      headers: { cookie },
      tags: { name: 'poll' },
    });
    if (poll.status === 200) bid = poll.json('bid') as typeof bid;
  }
  // A retry gets the original bid back; counting it again would count one bid twice.
  const outcome = isRetry
    ? 'deduped'
    : bid.status === 'rejected' || bid.status === 'lost_race'
      ? `${bid.status}:${bid.reason ?? 'unknown'}`
      : bid.status;
  outcomes.add(1, { outcome });
}

export function handleSummary(data: {
  metrics: Record<string, { values: Record<string, number> }>;
}) {
  const v = (name: string, field: string) => data.metrics[name]?.values[field] ?? 0;
  const line =
    `bids: ${String(v('bid_outcome', 'count'))}, unexpected: ${String(v('unexpected_responses', 'count'))}, ` +
    `latency p50 ${v('bid_latency', 'med').toFixed(0)}ms p95 ${v('bid_latency', 'p(95)').toFixed(0)}ms, ` +
    `answered pending ${(v('bid_pending', 'rate') * 100).toFixed(1)}%`;
  return {
    stdout: `${line}\n`,
    [`/load/results/${__ENV['RUN'] ?? 'run'}.summary.json`]: JSON.stringify(data, null, 2),
  };
}
