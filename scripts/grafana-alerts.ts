// Applies the alert rules in ops/grafana/alerts.json to the Grafana Cloud stack (spec §8),
// through Grafana's alerting provisioning API, so the rules are reviewed in PRs like any
// code. Idempotent: the whole rule group is replaced each time. Prints rule names and states
// only, never credentials. Needs GRAFANA_URL and GRAFANA_SA_TOKEN (a service account with
// the Editor role) in .env.local.
//
//   node scripts/grafana-alerts.ts            apply
//   node scripts/grafana-alerts.ts --status   show each rule's current state
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function envFromFile(name: string): string | undefined {
  const file = `${root}/.env.local`;
  if (process.env[name]) return process.env[name];
  if (!existsSync(file)) return undefined;
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'));
  return match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
}

const baseUrl = envFromFile('GRAFANA_URL')?.replace(/\/+$/, '');
const token = envFromFile('GRAFANA_SA_TOKEN');
if (!baseUrl || !token?.startsWith('glsa_')) {
  console.error('Needs GRAFANA_URL and a service-account GRAFANA_SA_TOKEN (glsa_…) in .env.local.');
  process.exit(1);
}

async function grafana(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl ?? ''}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? ''}`,
      'content-type': 'application/json',
      // Rules stay editable in the UI too; the repo is still where changes are made.
      'x-disable-provenance': 'true',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

type RuleSpec = {
  uid: string;
  title: string;
  expr: string;
  for: string;
  summary: string;
  runbook: string;
  severity: string;
};
type Spec = {
  group: string;
  folderUid: string;
  folderTitle: string;
  intervalSeconds: number;
  rules: RuleSpec[];
};
const spec = JSON.parse(readFileSync(`${root}/ops/grafana/alerts.json`, 'utf8')) as Spec;

if (process.argv.includes('--status')) {
  const { status, json } = await grafana('GET', '/api/prometheus/grafana/api/v1/rules');
  if (status !== 200) {
    console.error(`status read failed: HTTP ${String(status)}`);
    process.exit(1);
  }
  type Rule = {
    name: string;
    state: string;
    health: string;
    alerts?: { labels?: Record<string, string>; state: string }[];
  };
  const groups = (json as { data: { groups: { name: string; rules: Rule[] }[] } }).data.groups;
  for (const g of groups.filter((x) => x.name === spec.group)) {
    for (const r of g.rules) {
      const firing = (r.alerts ?? [])
        .map((a) => `${a.labels?.['job'] ?? '?'}:${a.state}`)
        .join(', ');
      console.log(`${r.name}: ${r.state} (${r.health})${firing ? ` [${firing}]` : ''}`);
    }
  }
  process.exit(0);
}

// The stack's Prometheus (Mimir) data source, where the OTLP metrics land.
const ds = await grafana('GET', '/api/datasources');
const prom = (ds.json as { uid: string; type: string; name: string }[]).find(
  (d) => d.type === 'prometheus' && /prom/i.test(d.name) && !/usage|alert/i.test(d.name),
);
if (!prom) {
  console.error(`no Prometheus data source found (HTTP ${String(ds.status)})`);
  process.exit(1);
}

const folder = await grafana('GET', `/api/folders/${spec.folderUid}`);
if (folder.status === 404) {
  const made = await grafana('POST', '/api/folders', {
    uid: spec.folderUid,
    title: spec.folderTitle,
  });
  if (made.status >= 300) {
    console.error(`could not create the folder: HTTP ${String(made.status)}`);
    process.exit(1);
  }
}

const rules = spec.rules.map((r) => ({
  uid: r.uid,
  title: r.title,
  folderUID: spec.folderUid,
  ruleGroup: spec.group,
  condition: 'C',
  for: r.for,
  // No data means the app isn't reporting: that isn't an orphaned hold, and a stopped drill
  // shouldn't page. Production silence shows up in the smoke test and Railway instead.
  noDataState: 'OK',
  execErrState: 'Error',
  labels: { severity: r.severity, service: 'holdfast' },
  annotations: {
    summary: r.summary,
    runbook_url: `https://github.com/djwirz/holdfast/blob/main/${r.runbook}`,
  },
  data: [
    {
      refId: 'A',
      relativeTimeRange: { from: 600, to: 0 },
      datasourceUid: prom.uid,
      model: { refId: 'A', expr: r.expr, instant: true },
    },
    {
      refId: 'C',
      relativeTimeRange: { from: 0, to: 0 },
      datasourceUid: '__expr__',
      model: {
        refId: 'C',
        type: 'threshold',
        expression: 'A',
        conditions: [{ evaluator: { type: 'gt', params: [0] } }],
      },
    },
  ],
}));

const put = await grafana(
  'PUT',
  `/api/v1/provisioning/folder/${spec.folderUid}/rule-groups/${spec.group}`,
  { title: spec.group, interval: spec.intervalSeconds, rules },
);
if (put.status >= 300) {
  console.error(
    `apply failed: HTTP ${String(put.status)} ${JSON.stringify(put.json).slice(0, 300)}`,
  );
  process.exit(1);
}
console.log(
  `applied rule group "${spec.group}" (${String(rules.length)} rules) using data source ${prom.name}`,
);
for (const r of spec.rules) console.log(`  ${r.title}: ${r.expr}  for ${r.for}`);
