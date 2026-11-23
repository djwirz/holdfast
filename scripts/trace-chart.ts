// The README's trace picture (spec §11.4): one bid's trace as a waterfall, drawn from the
// trace itself as Grafana Cloud's Tempo stores it, one bar per step and coloured by replica.
// Database, Redis and framework spans are counted in the caption, not drawn: they'd bury the
// bid's own steps. A hand-written SVG, like the load chart.
//
//   node scripts/trace-chart.ts <trace id> [docs/trace.svg]
//
// Needs GRAFANA_URL and GRAFANA_SA_TOKEN in .env.local (read access to the traces). Prints
// no credentials.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const traceId = process.argv[2];
const outPath = process.argv[3] ?? 'docs/trace.svg';
if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) {
  console.error('usage: node scripts/trace-chart.ts <32-hex trace id> [out.svg]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const envFile = existsSync(`${root}/.env.local`) ? readFileSync(`${root}/.env.local`, 'utf8') : '';
const env = (name: string) =>
  process.env[name] ??
  new RegExp(`^${name}=(.*)$`, 'm')
    .exec(envFile)?.[1]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2');
const grafanaUrl = env('GRAFANA_URL')?.replace(/\/+$/, '');
const token = env('GRAFANA_SA_TOKEN');
if (!grafanaUrl || !token?.startsWith('glsa_')) {
  console.error('Needs GRAFANA_URL and GRAFANA_SA_TOKEN (glsa_…) in .env.local.');
  process.exit(1);
}

// Tempo's v2 trace API through Grafana's data source proxy: OTLP JSON.
type Attr = { key: string; value: { stringValue?: string; intValue?: string } };
type RawSpan = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Attr[];
};
type Batch = { resource: { attributes: Attr[] }; scopeSpans?: { spans: RawSpan[] }[] };
const res = await fetch(
  `${grafanaUrl}/api/datasources/proxy/uid/grafanacloud-traces/api/v2/traces/${traceId}`,
  { headers: { authorization: `Bearer ${token}` } },
);
if (!res.ok) {
  console.error(`trace fetch failed: HTTP ${String(res.status)}`);
  process.exit(1);
}
const body = (await res.json()) as { trace?: { resourceSpans?: Batch[]; batches?: Batch[] } };
const batches = body.trace?.resourceSpans ?? body.trace?.batches ?? [];

type Span = {
  id: string;
  parent: string | undefined;
  name: string;
  start: number;
  end: number;
  replica: string;
  attr: (key: string) => string | undefined;
};
const all: Span[] = batches.flatMap((b) => {
  const replica =
    b.resource.attributes.find((a) => a.key === 'service.instance.id')?.value.stringValue ?? '?';
  return (b.scopeSpans ?? []).flatMap((s) =>
    s.spans.map((sp) => ({
      id: sp.spanId,
      parent: sp.parentSpanId || undefined,
      name: sp.name,
      start: Number(BigInt(sp.startTimeUnixNano) / 1000n) / 1000,
      end: Number(BigInt(sp.endTimeUnixNano) / 1000n) / 1000,
      replica,
      attr: (key: string) => {
        const v = sp.attributes?.find((a) => a.key === key)?.value;
        return v?.stringValue ?? v?.intValue;
      },
    })),
  );
});
if (all.length === 0) throw new Error('no spans in that trace');

// The steps worth drawing, with what each one is in plain words.
function describe(s: Span): { label: string; note: string } | undefined {
  const url = s.attr('url.full');
  if (url?.includes('api.stripe.com')) {
    const path = new URL(url).pathname.replace(/pi_[A-Za-z0-9]+/, 'pi_…');
    return { label: 'POST api.stripe.com', note: path };
  }
  const notes: Record<string, string> = {
    'bid.claim': 'idempotency key, rate limit, pending row',
    'payments.authorize': 'card hold at Stripe',
    'bid.decide': `row lock, rules, commit: ${s.attr('bid.outcome') ?? '?'}`,
    'outbox.cancel_hold': "release the outbid bidder's hold",
    'outbox.capture': "charge the winner's hold",
    'outbox.publish': 'Redis doorbell to every replica',
    'live.fanout': 'read the change, notify open streams',
    'sse.write': 'push to an open browser',
  };
  if (s.name.startsWith('POST /api/')) return { label: s.name, note: 'the request' };
  const note = notes[s.name];
  return note === undefined ? undefined : { label: s.name, note };
}
const byId = new Map(all.map((s) => [s.id, s]));
const kept = all
  .map((s) => ({ s, d: describe(s) }))
  .filter((x): x is { s: Span; d: { label: string; note: string } } => x.d !== undefined)
  .sort((a, b) => a.s.start - b.s.start || b.s.end - a.s.end);
const keptIds = new Set(kept.map((k) => k.s.id));
// Depth among drawn steps: walk up through the spans that aren't drawn.
const depth = (s: Span): number => {
  let n = 0;
  for (let p = s.parent; p; p = byId.get(p)?.parent) if (keptIds.has(p)) n++;
  return n;
};

const t0 = Math.min(...all.map((s) => s.start));
const t1 = Math.max(...all.map((s) => s.end));
const total = t1 - t0;
// Replicas in order of first appearance: the one that took the request is A.
const replicas = [...new Set(all.sort((a, b) => a.start - b.start).map((s) => s.replica))];
const COLORS = ['#3d6fb5', '#d08a16', '#2f7d4a'];
const colorOf = (r: string) => COLORS[replicas.indexOf(r) % COLORS.length] ?? '#8a8a8a';

// Layout.
const W = 760;
const rowH = 34;
const top = 78;
const labelW = 330;
const right = 96;
const plotX = labelW + 10;
const plotW = W - plotX - right;
const H = top + kept.length * rowH + 64;
const x = (t: number) => plotX + ((t - t0) / total) * plotW;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const ms = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

const parts: string[] = [];
parts.push(`<rect width="${String(W)}" height="${String(H)}" fill="#ffffff"/>`);
parts.push(
  `<text x="16" y="26" font-size="16" font-weight="600" fill="#1c1b19">One production bid, traced across both replicas</text>`,
);
parts.push(
  `<text x="16" y="46" font-size="12" fill="#4a4843">${esc(
    `${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${ms(total)}ms from request to live update · ${String(all.length)} spans in one trace (database, Redis and framework spans not drawn)`,
  )}</text>`,
);
// Time grid.
const step = total > 2000 ? 500 : total > 800 ? 200 : 100;
for (let t = 0; t <= total; t += step) {
  const gx = x(t0 + t).toFixed(1);
  parts.push(
    `<line x1="${gx}" y1="${String(top - 6)}" x2="${gx}" y2="${String(top + kept.length * rowH)}" stroke="#e4e2dc"/>`,
  );
  parts.push(
    `<text x="${gx}" y="${String(top - 10)}" font-size="11" text-anchor="middle" fill="#4a4843">${String(t)}ms</text>`,
  );
}
kept.forEach(({ s, d }, i) => {
  const y = top + i * rowH;
  const indent = 16 + depth(s) * 12;
  parts.push(
    `<text x="${String(indent)}" y="${String(y + 13)}" font-size="12" fill="#1c1b19" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(d.label)}</text>`,
  );
  if (d.note)
    parts.push(
      `<text x="${String(indent)}" y="${String(y + 27)}" font-size="11" fill="#6b6862">${esc(d.note)}</text>`,
    );
  const bx = x(s.start);
  const bw = Math.max(2, x(s.end) - bx);
  parts.push(
    `<rect x="${bx.toFixed(1)}" y="${String(y + 10)}" width="${bw.toFixed(1)}" height="14" rx="2" fill="${colorOf(s.replica)}"><title>${esc(`${s.name}: ${ms(s.end - s.start)}ms on replica ${String.fromCharCode(65 + replicas.indexOf(s.replica))}`)}</title></rect>`,
  );
  parts.push(
    `<text x="${(bx + bw + 4).toFixed(1)}" y="${String(y + 21)}" font-size="11" fill="#4a4843">${ms(s.end - s.start)}ms · <tspan fill="${colorOf(s.replica)}" font-weight="600">${String.fromCharCode(65 + replicas.indexOf(s.replica))}</tspan></text>`,
  );
});
// Legend.
const ly = top + kept.length * rowH + 30;
replicas.forEach((r, i) => {
  const lx = 16 + i * 250;
  parts.push(
    `<rect x="${String(lx)}" y="${String(ly - 10)}" width="12" height="12" rx="2" fill="${colorOf(r)}"/>`,
  );
  parts.push(
    `<text x="${String(lx + 18)}" y="${String(ly)}" font-size="12" fill="#1c1b19">${esc(
      `Replica ${String.fromCharCode(65 + i)}${i === 0 ? ' (took the request)' : ''}`,
    )}</text>`,
  );
});
parts.push(
  `<text x="16" y="${String(ly + 22)}" font-size="11" fill="#6b6862">${esc(
    `Drawn by scripts/trace-chart.ts from trace ${traceId} in Grafana Cloud (Tempo).`,
  )}</text>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(W)} ${String(H)}" width="${String(W)}" height="${String(H)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="${esc(
  `One bid's trace across ${String(replicas.length)} replicas: ${kept.map((k) => k.d.label).join(', ')}`,
)}">\n${parts.join('\n')}\n</svg>\n`;
writeFileSync(resolve(root, outPath), svg);
console.log(
  `${outPath}: ${String(kept.length)} steps drawn of ${String(all.length)} spans, ${ms(total)}ms, ${String(replicas.length)} replicas`,
);
