// One bid, one trace, across two instances (spec §8, §11.4): the bid's own steps, the outbox
// publish its row carries the context into, the Redis doorbell, and the fan-out and SSE write
// on the other instance all share one trace id. Spans go to an in-memory exporter here; in
// production the same spans go to Grafana.
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
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

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager().enable();

let testDb: TestDb;
let db: Db;
let a: TestApp;
let b: TestApp;
let baseB: string;
let redis: Redis;

beforeAll(async () => {
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
  testDb = await freshDb();
  db = testDb.db;
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
  trace.disable();
  propagation.disable();
  context.disable();
});

describe('a bid’s trace', () => {
  it('runs from the request to the SSE write on the other instance', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000 });
    const stream = await openStream(baseB, auction.id);
    try {
      await stream.next((f) => f.event === 'snapshot');
      const alice = await signIn(a.app, 'alice');
      exporter.reset();

      // The incoming request's span, as the HTTP instrumentation makes in production.
      const traceId = await trace
        .getTracer('test')
        .startActiveSpan('POST /api/auctions/:id/bids', async (span) => {
          const res = await a.app.inject(bidRequest(alice, auction.id, 1_000));
          expect(res.statusCode).toBe(201);
          span.end();
          return span.spanContext().traceId;
        });

      // Instance A's outbox worker publishes, outside the request; instance B hears it.
      await runOutboxOnce(
        { db, payments: a.deps.payments, publisher: new RedisPublisher(redis) },
        FAST_OUTBOX,
      );
      await stream.next(isEvent('bid.accepted', 1), 3_000);
      await new Promise((r) => setTimeout(r, 100));

      const spans = exporter.getFinishedSpans();
      const inTrace = spans.filter((s) => s.spanContext().traceId === traceId).map((s) => s.name);
      for (const name of [
        'bid.claim',
        'payments.authorize',
        'bid.decide',
        'outbox.publish',
        'live.fanout',
        'sse.write',
      ]) {
        expect(inTrace, `${name} in ${JSON.stringify(inTrace)}`).toContain(name);
      }
      const decide = spans.find((s) => s.name === 'bid.decide');
      expect(decide?.attributes['bid.outcome']).toBe('accepted');
    } finally {
      stream.close();
    }
  });
});
