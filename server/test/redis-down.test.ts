// Redis is down (spec §7, §10): bids still commit, health says so, the outbox retries the
// publish, and once Redis is back a reconnecting client resumes from Last-Event-ID.
import { and, eq, isNotNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { outbox } from '../src/db/schema.ts';
import { RedisPublisher } from '../src/live/hub.ts';
import { runOutboxOnce } from '../src/outbox/worker.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, freshDb } from './support/db.ts';
import {
  type TestApp,
  bidRequest,
  cuttableRedis,
  isEvent,
  openStream,
  redisUrl,
  signIn,
  testApp,
} from './support/http.ts';
import { FAST_OUTBOX } from './support/settle.ts';

let testDb: TestDb;
let db: Db;
let t: TestApp;
let base: string;
let proxy: Awaited<ReturnType<typeof cuttableRedis>>;
let publisherRedis: Redis;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  proxy = await cuttableRedis(redisUrl());
  t = await testApp(db, { redisUrl: proxy.url, pollMs: 60_000 });
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
  publisherRedis = new Redis(proxy.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  publisherRedis.on('error', () => undefined);
});

afterAll(async () => {
  publisherRedis.disconnect();
  await t.close();
  await proxy.close();
  await testDb.close();
});

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('with Redis down', () => {
  it('commits bids, retries the publish, and lets clients catch up afterwards', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    const alice = await signIn(t.app, 'alice');
    await waitFor(() => publisherRedis.status === 'ready');
    await t.app.inject(bidRequest(alice, auction.id, 1_000));
    const outboxDeps = {
      db,
      payments: t.deps.payments,
      publisher: new RedisPublisher(publisherRedis),
    };
    await runOutboxOnce(outboxDeps, FAST_OUTBOX);

    const stream = await openStream(base, auction.id);
    await stream.next((f) => f.event === 'snapshot');

    await proxy.cut();
    await waitFor(() => publisherRedis.status !== 'ready');

    // The bid still commits: Postgres is the truth, and rate limiting skips a dead Redis.
    const res = await t.app.inject(bidRequest(alice, auction.id, 1_100));
    expect(res.statusCode).toBe(201);
    expect((await t.app.inject({ url: '/healthz' })).json()).toMatchObject({ ok: true });
    expect((await t.app.inject({ url: '/healthz' })).json<{ redis: string }>().redis).not.toBe(
      'ready',
    );

    // The publish fails and is left to retry, not lost.
    const run = await runOutboxOnce(outboxDeps, FAST_OUTBOX);
    expect(run.retried).toBeGreaterThanOrEqual(1);
    stream.close();

    // Redis comes back. A client reconnecting with its Last-Event-ID gets what it missed,
    // from Postgres; the retried publish then succeeds.
    await proxy.restore();
    const resumed = await openStream(base, auction.id, 1);
    try {
      const frame = await resumed.next(isEvent('bid.accepted', 2));
      expect(frame.data).toMatchObject({ amount: 1_100 });
    } finally {
      resumed.close();
    }
    await waitFor(() => publisherRedis.status === 'ready');
    await waitFor(async () => {
      await new Promise((r) => setTimeout(r, 30)); // past the retry backoff
      await runOutboxOnce(outboxDeps, FAST_OUTBOX);
      const done = await db
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(eq(outbox.kind, 'publish'), isNotNull(outbox.doneAt)));
      return done.length === 2;
    });
  });
});
