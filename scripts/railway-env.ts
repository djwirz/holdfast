// Sets the demo's Railway variables from local env files, so secrets go from your machine
// to Railway without being pasted anywhere (docs/deploy.md). Prints variable names only,
// never values. Needs the Railway CLI, logged in and linked: `railway login`, `railway link`.
//
//   node scripts/railway-env.ts --service <app service> --domain <host> [--dry-run]
//
// Values come from .env.railway (production-only values, such as the GitHub OAuth app and
// the dashboard webhook secret), falling back to .env.local (the same Stripe test keys).
// Both files are gitignored and kept out of the image.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    service: { type: 'string' },
    domain: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const service = args.service;
const domain = args.domain?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
if (!service || !domain) {
  console.error('usage: node scripts/railway-env.ts --service <app service> --domain <host>');
  process.exit(2);
}

/** KEY=VALUE lines, without running the file as a shell script. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    out[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const root = resolve(import.meta.dirname, '..');
const local = { ...readEnvFile(`${root}/.env.local`), ...readEnvFile(`${root}/.env.railway`) };

// What each secret must look like; anything else is refused before it reaches Railway.
const SECRETS: Record<string, { required: boolean; check: (v: string) => boolean; hint: string }> =
  {
    STRIPE_SECRET_KEY: {
      required: true,
      check: (v) => v.startsWith('sk_test_'),
      hint: 'sk_test_…',
    },
    STRIPE_PUBLISHABLE_KEY: {
      required: true,
      check: (v) => v.startsWith('pk_test_'),
      hint: 'pk_test_…',
    },
    STRIPE_WEBHOOK_SECRET: {
      required: false,
      check: (v) => v.startsWith('whsec_'),
      hint: 'whsec_… from the dashboard endpoint, not `stripe listen`',
    },
    GITHUB_CLIENT_ID: { required: true, check: (v) => v.length > 0, hint: 'the OAuth app id' },
    GITHUB_CLIENT_SECRET: { required: true, check: (v) => v.length > 0, hint: 'its secret' },
  };

const problems: string[] = [];
const sets = new Map<string, string>([
  ['NODE_ENV', 'production'],
  ['APP_ORIGIN', `https://${domain}`],
  ['OUTBOX_INTERVAL_MS', '250'],
  ['LIFECYCLE_INTERVAL_MS', '1000'],
  // References: Railway resolves these to the private-network URLs of the other services.
  ['DATABASE_URL', '${{Postgres.DATABASE_URL}}'],
  ['REDIS_URL', '${{Redis.REDIS_URL}}'],
]);
const skipped: string[] = [];
for (const [name, rule] of Object.entries(SECRETS)) {
  const value = local[name];
  if (!value) {
    if (rule.required) problems.push(`${name} is missing (${rule.hint})`);
    else skipped.push(`${name} (not in .env.railway; webhooks answer 503 until it's set)`);
    continue;
  }
  if (!rule.check(value)) problems.push(`${name} doesn't look right (expected ${rule.hint})`);
  else sets.set(name, value);
}
if (problems.length > 0) {
  console.error(`Not setting anything:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// The session secret keys bidder aliases, so it's created once and then left alone:
// replacing it would rename every bidder mid-auction. The current variables are read into
// memory only to see which names exist; nothing from them is printed.
let current: Record<string, string>;
try {
  current = JSON.parse(
    execFileSync('railway', ['variables', '--service', service, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ) as Record<string, string>;
} catch (e) {
  // The CLI's own message (not logged in, not linked, no such service) has no values in it.
  const why = String((e as { stderr?: Buffer }).stderr ?? e).trim();
  console.error(`Couldn't read the service's variables: ${why}`);
  console.error('Run `railway login` and `railway link` first, and check the service name.');
  process.exit(1);
}
if (current['SESSION_SECRET']) skipped.push('SESSION_SECRET (already set; kept)');
else sets.set('SESSION_SECRET', randomBytes(48).toString('base64'));

console.log(`Service "${service}", origin https://${domain}`);
console.log(`Setting: ${[...sets.keys()].join(', ')}`);
if (skipped.length > 0) console.log(`Skipping: ${skipped.join('; ')}`);
if (args['dry-run']) {
  console.log('Dry run: nothing sent.');
  process.exit(0);
}

const setArgs = [...sets].flatMap(([k, v]) => ['--set', `${k}=${v}`]);
try {
  // Arguments, not a shell: no value is ever interpreted. Output is dropped in case the
  // CLI echoes what it set.
  execFileSync('railway', ['variables', '--service', service, ...setArgs], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (e) {
  let message = String((e as { stderr?: Buffer }).stderr ?? 'railway variables failed');
  for (const v of sets.values()) message = message.replaceAll(v, '[redacted]');
  console.error(message.trim());
  process.exit(1);
}
console.log('Done. Railway redeploys the service with the new variables.');
