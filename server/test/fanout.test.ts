// The fan-out test (spec §10): two instances of the real app sharing Postgres and Redis.
// A bid on one reaches a stream on the other, through the outbox and Redis pub/sub.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { RedisPublisher } from '../src/live/hub.ts';
import { runOutboxOnce } from '../src/outbox/worker.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, freshDb } from './support/db.ts';
import {
  type TestApp,
  bidRequest,
  isEvent,
  openStream,
  redisUrl,
  signIn,
  testApp,
} from './support/http.ts';
import { FAST_OUTBOX } from './support/settle.ts';

let testDb: TestDb;
let db: Db;
let a: TestApp;
let b: TestApp;
let baseB: string;
let redis: Redis;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  // A long poll, so delivery within the test can only have come through Redis.
  [a, b] = await Promise.all([
    testApp(db, { redisUrl: redisUrl(), pollMs: 60_000 }),
    testApp(db, { redisUrl: redisUrl(), pollMs: 60_000 }),
  ]);
  await a.app.listen({ port: 0, host: '127.0.0.1' });
  baseB = await b.app.listen({ port: 0, host: '127.0.0.1' });
  redis = new Redis(redisUrl());
});

afterAll(async () => {
  redis.disconnect();
  await Promise.all([a.close(), b.close()]);
  await testDb.close();
});

describe('two instances', () => {
  it('a bid placed on instance A reaches a stream on instance B', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    const stream = await openStream(baseB, auction.id);
    try {
      await stream.next((f) => f.event === 'snapshot');
      const alice = await signIn(a.app, 'alice');
      const res = await a.app.inject(bidRequest(alice, auction.id, 1_000));
      expect(res.statusCode).toBe(201);

      // Instance A's outbox worker publishes; instance B hears it.
      await runOutboxOnce(
        { db, payments: a.deps.payments, publisher: new RedisPublisher(redis) },
        FAST_OUTBOX,
      );
      const frame = await stream.next(isEvent('bid.accepted', 1), 3_000);
      expect(frame.data).toMatchObject({ amount: 1_000, version: 1 });
    } finally {
      stream.close();
    }
  });
});
