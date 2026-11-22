// Creates the demo's Stripe webhook endpoint (test mode) for a deployed origin and writes
// its signing secret into .env.railway, so the secret is never shown or pasted
// (docs/deploy.md). Prints the endpoint id and events only.
//
//   pnpm stripe:webhook --domain <host>
//
// Safe to run again: if an endpoint for that URL exists, it's left alone and reported
// (Stripe shows a signing secret only when an endpoint is created).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Stripe from 'stripe';

const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'payment_intent.amount_capturable_updated',
  'payment_intent.canceled',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
];

const { values: args } = parseArgs({ options: { domain: { type: 'string' } } });
const domain = args.domain?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
if (!domain) {
  console.error('usage: pnpm stripe:webhook --domain <host>');
  process.exit(2);
}
const url = `https://${domain}/api/stripe/webhook`;

const root = resolve(import.meta.dirname, '../..');
const envLocal = `${root}/.env.local`;
const envRailway = `${root}/.env.railway`;
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const key =
  /^STRIPE_SECRET_KEY=(.*)$/m.exec(read(envRailway) || read(envLocal))?.[1]?.trim() ??
  /^STRIPE_SECRET_KEY=(.*)$/m.exec(read(envLocal))?.[1]?.trim();
if (!key?.startsWith('sk_test_')) {
  console.error('Needs a test-mode STRIPE_SECRET_KEY (sk_test_…) in .env.local or .env.railway.');
  process.exit(1);
}

// The SDK's own client, same as the server; the key is used, never printed.
const stripe = new Stripe(key);
const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(
  (e) => e.url === url,
);
if (existing) {
  console.log(`An endpoint for ${url} already exists (${existing.id}); left as is.`);
  console.log('Its secret is in the dashboard: Developers → Webhooks → the endpoint → Reveal.');
  process.exit(0);
}

const endpoint = await stripe.webhookEndpoints.create({
  url,
  enabled_events: EVENTS,
  description: 'Holdfast demo (test mode)',
});
if (!endpoint.secret) throw new Error('Stripe returned no signing secret');

// Replace or add the one line; everything else in the file stays as it was.
const before = read(envRailway);
const line = `STRIPE_WEBHOOK_SECRET=${endpoint.secret}`;
const after = /^STRIPE_WEBHOOK_SECRET=.*$/m.test(before)
  ? before.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, line)
  : `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${line}\n`;
writeFileSync(envRailway, after, { mode: 0o600 });

console.log(`Created ${endpoint.id} → ${url}`);
console.log(`Events: ${EVENTS.join(', ')}`);
console.log('Signing secret written to .env.railway as STRIPE_WEBHOOK_SECRET (not shown).');
