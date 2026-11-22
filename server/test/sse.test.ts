// The SSE stream (spec §4, ADR 0004): a snapshot, then every version exactly once and in
// order, resumable from Last-Event-ID, and whole even when a doorbell or a batch is lost.
import type { AuctionEvent } from '@holdfast/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import type { Listener } from '../src/live/hub.ts';
import { aliaser } from '../src/live/read.ts';
import { streamAuction } from '../src/live/sse.ts';
import { RedisPublisher } from '../src/live/hub.ts';
import { tickLifecycleOnce } from '../src/lifecycle.ts';
import { MemoryPublisher } from '../src/outbox/publisher.ts';
import { runOutboxOnce } from '../src/outbox/worker.ts';
import { auctions } from '../src/db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { openAuction } from './support/auctions.ts';
import { type TestDb, freshDb } from './support/db.ts';
import {
  SECRET,
  type TestApp,
  bidRequest,
  isEvent,
  openStream,
  redisUrl,
  signIn,
  testApp,
} from './support/http.ts';
import { FAST_OUTBOX } from './support/settle.ts';
import { Redis } from 'ioredis';

let testDb: TestDb;
let db: Db;
let t: TestApp;
let base: string;
let alice: string;
let bob: string;
let redis: Redis;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  t = await testApp(db, { redisUrl: redisUrl() });
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
  alice = await signIn(t.app, 'alice');
  bob = await signIn(t.app, 'bob');
  redis = new Redis(redisUrl());
});

afterAll(async () => {
  redis.disconnect();
  await t.close();
  await testDb.close();
});

/** What the outbox worker does in production: publish rows ring Redis. */
const drainOutbox = () =>
  runOutboxOnce(
    { db, payments: t.deps.payments, publisher: new RedisPublisher(redis) },
    FAST_OUTBOX,
  );

describe('GET /auctions/:id/events', () => {
  it('sends a snapshot, then each accepted bid and the close in version order', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    await t.app.inject(bidRequest(alice, auction.id, 1_000));
    const stream = await openStream(base, auction.id);
    try {
      const snap = await stream.next((f) => f.event === 'snapshot');
      expect(snap.id).toBe(1);

      await t.app.inject(bidRequest(bob, auction.id, 1_100));
      await t.app.inject(bidRequest(alice, auction.id, 1_200));
      await drainOutbox();
      await stream.next(isEvent('bid.accepted', 3));

      await db
        .update(auctions)
        .set({ endsAt: sql`clock_timestamp()` })
        .where(eq(auctions.id, auction.id));
      await tickLifecycleOnce({ db });
      await drainOutbox();
      const closed = await stream.next(isEvent('auction.closed'));
      // Read when sent: the capture may already have settled it.
      const data = closed.data as { amount: number; winner: string | null; status: string };
      expect(closed.id).toBe(4);
      expect(data.amount).toBe(1_200);
      expect(data.winner).toMatch(/^Bidder /);
      expect(['closed', 'settled']).toContain(data.status);

      const versions = stream.frames.map((f) => f.id);
      expect(versions).toEqual([1, 2, 3, 4]);
      expect(JSON.stringify(stream.frames)).not.toMatch(/alice|bob|userId/);
    } finally {
      stream.close();
    }
  });

  it('resumes from Last-Event-ID with exactly what was missed', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    for (const [who, amount] of [
      [alice, 1_000],
      [bob, 1_100],
      [alice, 1_200],
    ] as const) {
      await t.app.inject(bidRequest(who, auction.id, amount));
    }
    const stream = await openStream(base, auction.id, 1);
    try {
      await stream.next(isEvent('bid.accepted', 3));
      expect(stream.frames.map((f) => [f.event, f.id])).toEqual([
        ['bid.accepted', 2],
        ['bid.accepted', 3],
      ]);
    } finally {
      stream.close();
    }
  });

  it('still delivers when the doorbell is lost: the poll reads Postgres', async () => {
    const polling = await testApp(db, { redisUrl: null, pollMs: 100 });
    const pollingBase = await polling.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const auction = await openAuction(db);
      const stream = await openStream(pollingBase, auction.id);
      await stream.next((f) => f.event === 'snapshot');
      // Accepted and its publish row "sent" to nowhere: no Redis, no doorbell.
      await polling.app.inject(bidRequest(alice, auction.id, 2_000));
      await runOutboxOnce(
        { db, payments: polling.deps.payments, publisher: new MemoryPublisher() },
        FAST_OUTBOX,
      );
      await stream.next(isEvent('bid.accepted', 1));
      stream.close();
    } finally {
      await polling.close();
    }
  });

  it('404s an unknown auction', async () => {
    const stream = await openStream(base, '00000000-0000-4000-8000-000000000000');
    expect(stream.status).toBe(404);
    stream.close();
  });
});

describe('streamAuction gap fill', () => {
  it('reads skipped versions from Postgres before sending past them', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    const alias = aliaser(SECRET);
    let listener: Listener = () => undefined;
    const hub = {
      watch: (_id: string, l: Listener) => {
        listener = l;
        return () => undefined;
      },
    };
    const written: string[] = [];
    await streamAuction(
      { write: (c) => written.push(c), onClose: () => undefined },
      {
        db,
        alias,
        hub,
        auctionId: auction.id,
        viewerId: null,
        lastEventId: null,
        heartbeatMs: 60_000,
      },
    );
    // Two bids commit, but the hub only passes on the second (a lost batch).
    await t.app.inject(bidRequest(alice, auction.id, 1_000));
    await t.app.inject(bidRequest(bob, auction.id, 1_100));
    const second: AuctionEvent = {
      type: 'bid.accepted',
      version: 2,
      amount: 1_100,
      bidder: 'x',
      at: new Date().toISOString(),
    };
    listener([second]);
    await new Promise((r) => setTimeout(r, 200));
    const ids = written.flatMap((c) => [...c.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));
    expect(ids).toEqual([0, 1, 2]);
  });
});
