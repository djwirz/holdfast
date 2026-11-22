// Releases test-mode holds left open by a by-hand test run, by auction id: the card E2E
// (e2e/stripe.spec.ts) bids on auctions it seeds and stops the servers before they close.
// Only intents in requires_capture whose metadata names one of the given auctions are
// canceled. Test keys only.
//
//   node scripts/release-test-holds.ts <auctionId> [auctionId…]
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Stripe from 'stripe';

const auctionIds = new Set(process.argv.slice(2));
if (auctionIds.size === 0) {
  console.error('usage: node scripts/release-test-holds.ts <auctionId> [auctionId…]');
  process.exit(2);
}
const envFile = resolve(import.meta.dirname, '../../.env.local');
const fromFile = existsSync(envFile)
  ? /^STRIPE_SECRET_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim()
  : undefined;
const key = process.env['STRIPE_SECRET_KEY'] || fromFile || '';
if (!key.startsWith('sk_test_')) {
  console.error('needs a test-mode STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = new Stripe(key);
// The run is minutes old; a day back is plenty and keeps the listing short.
const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
let released = 0;
for await (const intent of stripe.paymentIntents.list({ created: { gte: since }, limit: 100 })) {
  const auction = intent.metadata['auctionId'];
  if (intent.status === 'requires_capture' && auction && auctionIds.has(auction)) {
    await stripe.paymentIntents.cancel(intent.id);
    released++;
  }
}
console.log(`released ${String(released)} test hold(s)`);
