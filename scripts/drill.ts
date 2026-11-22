// Fire drills (spec §11.5): fire one alert on purpose, then make it resolve, against a local
// stack whose telemetry goes to Grafana as job "holdfast-drill". The live demo is never
// touched. Each drill is logged in docs/runbook.md.
//
//   node scripts/drill.ts <orphan|outbox|capture>
//
// Needs Postgres and Redis (docker compose up), and in .env.local: GRAFANA_OTLP_ENDPOINT,
// GRAFANA_INSTANCE_ID, GRAFANA_OTLP_TOKEN (to send telemetry), GRAFANA_URL and
// GRAFANA_SA_TOKEN (to read alert states). Nothing secret is printed.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRILLS = {
  orphan: { rule: 'Orphaned holds', faults: {} },
  outbox: { rule: 'Outbox failures', faults: { cancel: 'permanent' } },
  capture: { rule: 'Capture failure', faults: { capture: 'permanent' } },
} as const;
type Drill = keyof typeof DRILLS;

const drill = process.argv[2] as Drill | undefined;
if (!drill || !(drill in DRILLS)) {
  console.error('usage: node scripts/drill.ts <orphan|outbox|capture>');
  process.exit(2);
}
const { rule, faults } = DRILLS[drill];

const root = resolve(import.meta.dirname, '..');
const envFile = readFileSyncSafe(`${root}/.env.local`);
const env = (name: string) =>
  process.env[name] ??
  new RegExp(`^${name}=(.*)$`, 'm')
    .exec(envFile)?.[1]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2');
function readFileSyncSafe(path: string) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const otlp = env('GRAFANA_OTLP_ENDPOINT');
const instance = env('GRAFANA_INSTANCE_ID');
const otlpToken = env('GRAFANA_OTLP_TOKEN');
const grafanaUrl = env('GRAFANA_URL')?.replace(/\/+$/, '');
const saToken = env('GRAFANA_SA_TOKEN');
// The OTLP SDK drops an endpoint it can't parse with only a debug log, and exports nothing.
if (
  !otlp ||
  !/^https:\/\/otlp-gateway-[a-z0-9-]+\.grafana\.net\/otlp\/?$/.test(otlp) ||
  !instance ||
  !otlpToken?.startsWith('glc_') ||
  !grafanaUrl ||
  !saToken?.startsWith('glsa_')
) {
  console.error(
    'Needs GRAFANA_OTLP_ENDPOINT, GRAFANA_INSTANCE_ID, GRAFANA_OTLP_TOKEN, GRAFANA_URL and GRAFANA_SA_TOKEN in .env.local.',
  );
  process.exit(1);
}

const API = 'http://localhost:3000';
const FAKE = 'http://127.0.0.1:4010';
const ORIGIN = 'http://localhost:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
};

function startStack(): ChildProcess {
  return spawn(process.execPath, ['src/dev/two-instances.ts'], {
    cwd: `${root}/server`,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEV_SIGN_IN: '1',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      APP_ORIGIN: ORIGIN,
      SESSION_SECRET: 'drill-only-not-a-secret-000000000000000',
      FAKE_LATENCY_MS: '50-150',
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic%20${Buffer.from(`${instance ?? ''}:${otlpToken ?? ''}`).toString('base64')}`,
      OTEL_SERVICE_NAME: 'holdfast-drill',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=drill',
    },
  });
}

async function until(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 15_000,
) {
  const start = Date.now();
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** This rule's alert state for the drill job: 'firing', 'pending' or 'normal'. */
async function alertState(): Promise<string> {
  const res = await fetch(`${grafanaUrl ?? ''}/api/prometheus/grafana/api/v1/rules`, {
    headers: { authorization: `Bearer ${saToken ?? ''}` },
  });
  type Alert = { labels?: Record<string, string>; state: string };
  const json = (await res.json()) as {
    data: { groups: { rules: { name: string; alerts?: Alert[] }[] }[] };
  };
  const found = json.data.groups.flatMap((g) => g.rules).find((r) => r.name === rule);
  if (!found) throw new Error(`rule "${rule}" not found: run pnpm grafana:alerts first`);
  const mine = (found.alerts ?? []).find((a) => a.labels?.['job'] === 'holdfast-drill');
  return (mine?.state ?? 'normal').toLowerCase();
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function signIn(login: string): Promise<string> {
  const res = await post('/api/auth/dev', { login });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (res.status !== 204 || !cookie) throw new Error(`sign-in failed: ${String(res.status)}`);
  return cookie;
}

function seed(seconds: number): string {
  const out = execFileSync(
    process.execPath,
    [
      '--env-file-if-exists=../.env.local',
      'src/seed-e2e.ts',
      String(seconds),
      `Drill ${drill ?? ''}`,
    ],
    {
      cwd: `${root}/server`,
      encoding: 'utf8',
    },
  );
  return (JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { id: string }).id;
}

const stack = startStack();
const stop = () => stack.kill('SIGTERM');
process.on('exit', stop);
try {
  await until(
    'the drill stack',
    async () => (await fetch(`${API}/api/healthz`)).ok && (await fetch(`${FAKE}/healthz`)).ok,
    60_000,
    1_000,
  );
  log(`drill "${drill}": stack up, telemetry to Grafana as job holdfast-drill`);
  await fetch(`${FAKE}/faults`, {
    method: 'POST',
    body: JSON.stringify({ cancel: 'ok', capture: 'ok', ...faults }),
  });

  // Break one thing, the way it would break for real.
  let auctionId: string;
  let ghostHold: string | null = null;
  if (drill === 'orphan') {
    // A hold with no bid behind it, as a handler that crashed before recording its bid, or a
    // bug that forgot to release one, would leave.
    auctionId = seed(600);
    const ghost = crypto.randomUUID();
    const res = await fetch(`${FAKE}/authorize`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: ghost,
        userId: ghost,
        amount: 2_500,
        metadata: { bidId: ghost, auctionId },
      }),
    });
    ghostHold = ((await res.json()) as { paymentIntentId: string }).paymentIntentId;
    log('placed a hold for a bid that does not exist');
  } else if (drill === 'outbox') {
    auctionId = seed(600);
    const [a, b] = [await signIn('drill-a'), await signIn('drill-b')];
    await post(
      `/api/auctions/${auctionId}/bids`,
      { amount: 1_000 },
      { cookie: a, 'idempotency-key': crypto.randomUUID() },
    );
    await post(
      `/api/auctions/${auctionId}/bids`,
      { amount: 1_100 },
      { cookie: b, 'idempotency-key': crypto.randomUUID() },
    );
    log('outbid a hold while every cancel fails for good');
  } else {
    auctionId = seed(15);
    const a = await signIn('drill-a');
    await post(
      `/api/auctions/${auctionId}/bids`,
      { amount: 1_000 },
      { cookie: a, 'idempotency-key': crypto.randomUUID() },
    );
    log('won an auction that closes in 15s while every capture fails for good');
  }

  log(
    `waiting for "${rule}" to fire (sampler 30s, export 30s, rule evaluation 1m, plus its "for")`,
  );
  await until(
    `"${rule}" to fire`,
    async () => {
      const state = await alertState();
      log(`  ${rule}: ${state}`);
      return state === 'firing' || state === 'alerting';
    },
    15 * 60_000,
    30_000,
  );
  const firedAt = new Date().toISOString();
  log(`FIRED: "${rule}". The email from Grafana is the proof.`);

  // Put it right, as the runbook says.
  await fetch(`${FAKE}/faults`, {
    method: 'POST',
    body: JSON.stringify({ cancel: 'ok', capture: 'ok' }),
  });
  if (ghostHold) {
    await fetch(`${FAKE}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        paymentIntentId: ghostHold,
        idempotencyKey: `drill-release-${ghostHold}`,
      }),
    });
    log('released the hold');
  } else {
    execFileSync(
      process.execPath,
      ['--env-file-if-exists=../.env.local', 'src/ops/requeue.ts', '--auction', auctionId],
      {
        cwd: `${root}/server`,
        stdio: 'inherit',
      },
    );
  }
  log(`waiting for "${rule}" to resolve`);
  await until(
    `"${rule}" to resolve`,
    async () => {
      const state = await alertState();
      log(`  ${rule}: ${state}`);
      return state === 'normal' || state === 'inactive';
    },
    15 * 60_000,
    30_000,
  );
  const resolvedAt = new Date().toISOString();
  log(`RESOLVED: "${rule}"`);

  appendFileSync(
    `${root}/docs/runbook.md`,
    `| ${firedAt.slice(0, 10)} | ${rule} | \`pnpm drill ${drill}\` | ${firedAt.slice(11, 16)} UTC | ${resolvedAt.slice(11, 16)} UTC |\n`,
  );
  log('logged in docs/runbook.md');
} finally {
  stop();
}
