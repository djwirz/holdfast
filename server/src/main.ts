// One server instance: the HTTP API plus the background loops. Every instance runs all
// of them; the outbox lease, SKIP LOCKED and resolving only from pending make that safe
// (ADR 0003), so two instances behave like one with more capacity.
import { Redis } from 'ioredis';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { gitHubOAuth } from './http/github.ts';
import { buildApp } from './http/app.ts';
import { startLifecycle } from './lifecycle.ts';
import { LiveHub, RedisPublisher } from './live/hub.ts';
import { aliaser } from './live/read.ts';
import { startOutboxWorker } from './outbox/worker.ts';
import { customerFromUsers } from './payments/customers.ts';
import { FakePayments } from './payments/fake.ts';
import type { Payments } from './payments/port.ts';
import { StripePayments, stripeClient } from './payments/stripe.ts';
import { reconcileOnce } from './reconciler.ts';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL, { max: 20 });

// Commands (publish, rate limits) fail fast while Redis is away instead of queueing, so a
// bid never waits on Redis (spec §7). The subscriber reconnects on its own.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
const subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const payments: Payments = config.STRIPE_SECRET_KEY
  ? new StripePayments({
      client: stripeClient(config.STRIPE_SECRET_KEY),
      customerFor: customerFromUsers(db),
    })
  : // The fake is the default (spec §11), slow enough that pending bids are visible.
    new FakePayments({ latency: () => 150 + Math.floor(Math.random() * 350) });

const alias = aliaser(config.SESSION_SECRET);
const app = await buildApp({
  db,
  payments,
  alias,
  hub: new LiveHub({ db, alias, subscriber }),
  appOrigin: config.APP_ORIGIN,
  cardRequired: payments instanceof StripePayments,
  rateLimitRedis: redis,
  redisStatus: () => redis.status,
  github:
    config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
      ? gitHubOAuth(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET)
      : null,
  devSignIn: config.DEV_SIGN_IN,
  stripeWebhook: config.STRIPE_WEBHOOK_SECRET ? { secret: config.STRIPE_WEBHOOK_SECRET } : null,
  logger: true,
});
const log = app.log;
const onError = (e: unknown) => {
  log.error(e);
};
redis.on('error', (e: Error) => {
  log.warn({ err: e.message }, 'redis unavailable');
});
subscriber.on('error', (e: Error) => {
  log.warn({ err: e.message }, 'redis subscriber unavailable');
});
app.addHook('onClose', () => {
  log.info('closing');
});

const outbox = startOutboxWorker(
  { db, payments, publisher: new RedisPublisher(redis) },
  { intervalMs: 100, onError },
);
const lifecycle = startLifecycle({ db }, { intervalMs: 500, onError });
const reconciler = setInterval(() => {
  reconcileOnce({ db, payments }).catch(onError);
}, 5_000);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
log.info(
  { payments: payments instanceof StripePayments ? 'stripe-test-mode' : 'fake' },
  'holdfast server up',
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  clearInterval(reconciler);
  await app.close();
  await Promise.all([outbox.stop(), lifecycle.stop()]);
  subscriber.disconnect();
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
