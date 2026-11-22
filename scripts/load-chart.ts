// The README's load chart (spec §11.2): bid outcomes over time from one k6 run, with the
// auction's end marked and the invariant checker's verdict on it. A hand-written SVG; one
// chart doesn't earn a charting library.
//
//   node scripts/load-chart.ts <run> [docs/load/storm.svg]
// reads load/results/<run>.k6.json (k6 --out json) and load/results/<run>.check.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run = process.argv[2];
const outPath = process.argv[3] ?? 'docs/load/storm.svg';
if (!run) {
  console.error('usage: node scripts/load-chart.ts <run> [out.svg]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const results = `${root}/load/results/${run}`;

type Check = {
  endsAt: string;
  bidsAccepted: number;
  lostRace: number;
  rejected: number;
  holds: number;
  holdsReleased: number;
  holdsCaptured: number;
  holdsLive: number;
  outboxFailed: number;
  violations: unknown[];
};
const check = JSON.parse(readFileSync(`${results}.check.json`, 'utf8')) as Check;

// k6 --out json: one JSON object per line. Bid outcomes are points of the bid_outcome counter.
type Point = {
  metric: string;
  type: string;
  data: { time: string; value: number; tags?: Record<string, string> };
};
const outcomes: { t: number; outcome: string }[] = [];
let firstRequest = Number.POSITIVE_INFINITY;
for (const line of readFileSync(`${results}.k6.json`, 'utf8').split('\n')) {
  if (!line.startsWith('{"metric"')) continue;
  const p = JSON.parse(line) as Point;
  const t = Date.parse(p.data.time);
  if (p.metric === 'http_reqs' && p.data.tags?.['name'] === 'bid')
    firstRequest = Math.min(firstRequest, t);
  if (p.metric === 'bid_outcome' && p.type === 'Point') {
    outcomes.push({ t, outcome: p.data.tags?.['outcome'] ?? 'unknown' });
  }
}
if (outcomes.length === 0) throw new Error('no bid outcomes in that run');

// Five readable groups.
const GROUPS = [
  {
    key: 'accepted',
    label: 'Accepted (later outbid or won)',
    color: '#2f7d4a',
    match: (o: string) => ['accepted', 'outbid', 'won'].includes(o),
  },
  {
    key: 'lost',
    label: 'Lost the race under the lock',
    color: '#d08a16',
    match: (o: string) => o.startsWith('lost_race'),
  },
  {
    key: 'rule',
    label: 'Refused by the rules (below minimum, ended)',
    color: '#8a8a8a',
    match: (o: string) =>
      o.startsWith('rejected:') && !/card|insufficient|processing|authentication|declin/.test(o),
  },
  {
    key: 'card',
    label: 'Card declined (injected)',
    color: '#b8433a',
    match: (o: string) =>
      o.startsWith('rejected:') && /card|insufficient|processing|authentication|declin/.test(o),
  },
  {
    key: 'retry',
    label: 'Retried key (deduped or 422)',
    color: '#3d6fb5',
    match: (o: string) => ['deduped', 'conflict', 'pending', 'rate_limited'].includes(o),
  },
] as const;
const groupOf = (o: string) => GROUPS.find((g) => g.match(o))?.key ?? 'retry';

const start = Math.min(firstRequest, ...outcomes.map((o) => o.t));
const end = Math.max(...outcomes.map((o) => o.t));
const BUCKET = 500;
const buckets = Math.max(1, Math.ceil((end - start + 1) / BUCKET));
const counts = Array.from({ length: buckets }, () => new Map<string, number>());
for (const o of outcomes) {
  const b = Math.min(buckets - 1, Math.floor((o.t - start) / BUCKET));
  const m = counts[b] ?? new Map<string, number>();
  m.set(groupOf(o.outcome), (m.get(groupOf(o.outcome)) ?? 0) + 1);
}
const peak = Math.max(...counts.map((m) => [...m.values()].reduce((a, b) => a + b, 0)));
const seconds = (end - start) / 1000;
const acceptedTotal = outcomes.filter((o) => groupOf(o.outcome) === 'accepted').length;

// Layout.
const W = 760;
const H = 380;
const left = 56;
const right = 16;
const top = 64;
const bottom = 112;
const plotW = W - left - right;
const plotH = H - top - bottom;
const x = (ms: number) => left + ((ms - start) / (buckets * BUCKET)) * plotW;
const yScale = (n: number) => (n / peak) * plotH;
const barW = plotW / buckets;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const parts: string[] = [];
parts.push(`<rect width="${String(W)}" height="${String(H)}" fill="#ffffff"/>`);
parts.push(
  `<text x="${String(left)}" y="26" font-size="16" font-weight="600" fill="#1c1b19">${esc(
    `${outcomes.length.toLocaleString('en-US')} near-simultaneous bids at one auction, through two instances`,
  )}</text>`,
);
const verdict =
  check.violations.length === 0 && check.outboxFailed === 0 && check.holdsLive === 0
    ? `Invariant checker: 0 violations · ${String(check.holdsReleased)} holds released, ${String(check.holdsCaptured)} captured, 0 left open`
    : `Invariant checker: ${String(check.violations.length)} violations, ${String(check.holdsLive)} holds open`;
parts.push(`<text x="${String(left)}" y="46" font-size="12" fill="#4a4843">${esc(verdict)}</text>`);

for (let b = 0; b < buckets; b++) {
  let y = top + plotH;
  for (const g of GROUPS) {
    const n = counts[b]?.get(g.key) ?? 0;
    if (n === 0) continue;
    const h = yScale(n);
    y -= h;
    parts.push(
      `<rect x="${(left + b * barW + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${g.color}"/>`,
    );
  }
}
// Axes and ticks.
parts.push(
  `<line x1="${String(left)}" y1="${String(top + plotH)}" x2="${String(W - right)}" y2="${String(top + plotH)}" stroke="#4a4843"/>`,
);
parts.push(
  `<line x1="${String(left)}" y1="${String(top)}" x2="${String(left)}" y2="${String(top + plotH)}" stroke="#4a4843"/>`,
);
const step = seconds > 40 ? 10 : 5;
for (let s = 0; s <= seconds; s += step) {
  const tx = x(start + s * 1000);
  parts.push(
    `<text x="${tx.toFixed(1)}" y="${String(top + plotH + 16)}" font-size="11" text-anchor="middle" fill="#4a4843">${String(s)}s</text>`,
  );
}
parts.push(
  `<text x="${String(left - 8)}" y="${String(top + 4)}" font-size="11" text-anchor="end" fill="#4a4843">${String(peak)}</text>`,
);
parts.push(
  `<text x="${String(left - 8)}" y="${String(top + plotH)}" font-size="11" text-anchor="end" fill="#4a4843">0</text>`,
);
parts.push(
  `<text x="14" y="${String(top + plotH / 2)}" font-size="11" fill="#4a4843" transform="rotate(-90 14 ${String(top + plotH / 2)})" text-anchor="middle">bids per 0.5s</text>`,
);
// The auction's end, on the server's clock.
const endsAt = Date.parse(check.endsAt);
if (endsAt > start && endsAt < start + buckets * BUCKET) {
  const ex = x(endsAt).toFixed(1);
  parts.push(
    `<line x1="${ex}" y1="${String(top - 4)}" x2="${ex}" y2="${String(top + plotH)}" stroke="#1c1b19" stroke-dasharray="4 3"/>`,
  );
  parts.push(
    `<text x="${ex}" y="${String(top - 8)}" font-size="11" text-anchor="middle" fill="#1c1b19">auction ends</text>`,
  );
}
// Legend.
GROUPS.forEach((g, i) => {
  const lx = left + (i % 2) * 340;
  const ly = top + plotH + 38 + Math.floor(i / 2) * 18;
  parts.push(
    `<rect x="${String(lx)}" y="${String(ly - 10)}" width="12" height="12" fill="${g.color}"/>`,
  );
  parts.push(
    `<text x="${String(lx + 18)}" y="${String(ly)}" font-size="12" fill="#1c1b19">${esc(g.label)}</text>`,
  );
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(W)} ${String(H)}" width="${String(W)}" height="${String(H)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${esc(
  `Bid outcomes over time for ${String(outcomes.length)} bids; the invariant checker found 0 violations`,
)}">\n${parts.join('\n')}\n</svg>\n`;
writeFileSync(resolve(root, outPath), svg);
console.log(
  `${outPath}: ${String(outcomes.length)} bids over ${seconds.toFixed(1)}s ` +
    `(${(outcomes.length / seconds).toFixed(0)} per second), ${String(acceptedTotal)} accepted, peak ${String(peak)} per 0.5s`,
);
