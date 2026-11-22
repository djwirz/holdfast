// The bid API (spec §6) through the real Fastify app: guards, status codes, and the
// pending path a bidder follows up with GET /bids/:id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { FakePayments } from '../src/payments/fake.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, freshDb } from './support/db.ts';
import { ORIGIN, type TestApp, bidRequest, signIn, testApp } from './support/http.ts';

let testDb: TestDb;
let db: Db;
let t: TestApp;
let alice: string;
let bob: string;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  t = await testApp(db, {
    rateLimits: { bids: { max: 1_000, windowMs: 60_000 }, auth: { max: 1_000, windowMs: 60_000 } },
  });
  alice = await signIn(t.app, 'alice');
  bob = await signIn(t.app, 'bob');
});

afterAll(async () => {
  await t.close();
  await testDb.close();
});

describe('POST /auctions/:id/bids', () => {
  it('accepts a bid: 201 with the bidder’s own view of it', async () => {
    const auction = await openAuction(db);
    const res = await t.app.inject(bidRequest(alice, auction.id, 2_000));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ bid: { amount: 2_000, status: 'accepted', reason: null } });
  });

  it('refuses without a session (401) and from another origin (403)', async () => {
    const auction = await openAuction(db);
    const anon = bidRequest('', auction.id, 2_000);
    expect((await t.app.inject(anon)).statusCode).toBe(401);
    const cross = bidRequest(alice, auction.id, 2_000);
    cross.headers.origin = 'https://evil.example';
    expect((await t.app.inject(cross)).statusCode).toBe(403);
  });

  it('validates the body and the Idempotency-Key header (400)', async () => {
    const auction = await openAuction(db);
    for (const amount of [0, -5, 12.5, 'lots'] as unknown[]) {
      const res = await t.app.inject({ ...bidRequest(alice, auction.id, 1), payload: { amount } });
      expect(res.statusCode, String(amount)).toBe(400);
    }
    const noKey = bidRequest(alice, auction.id, 2_000);
    noKey.headers['idempotency-key'] = '';
    expect((await t.app.inject(noKey)).statusCode).toBe(400);
  });

  it('404s an unknown or malformed auction id', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await t.app.inject(bidRequest(alice, missing, 2_000))).statusCode).toBe(404);
    expect((await t.app.inject(bidRequest(alice, 'not-a-uuid', 2_000))).statusCode).toBe(404);
  });

  it('replays a retried key, and 422s the same key with another amount', async () => {
    const auction = await openAuction(db);
    const first = await t.app.inject(bidRequest(bob, auction.id, 2_000, 'retry-me'));
    const again = await t.app.inject(bidRequest(bob, auction.id, 2_000, 'retry-me'));
    expect(again.json()).toEqual(first.json());
    const changed = await t.app.inject(bidRequest(bob, auction.id, 2_500, 'retry-me'));
    expect(changed.statusCode).toBe(422);
    expect(changed.json()).toMatchObject({ error: 'idempotency_conflict' });
  });

  it('rate-limits one bidder (429) without affecting another', async () => {
    const limited = await testApp(db, {
      rateLimits: { bids: { max: 5, windowMs: 60_000 }, auth: { max: 100, windowMs: 60_000 } },
    });
    try {
      const auction = await openAuction(db);
      const carol = await signIn(limited.app, 'carol');
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await limited.app.inject(bidRequest(carol, auction.id, 2_000 + 100 * i));
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
      expect(codes[5]).toBe(429);
      const dave = await signIn(limited.app, 'dave');
      expect((await limited.app.inject(bidRequest(dave, auction.id, 5_000))).statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe('a slow hold: 202 pending, then GET /bids/:id', () => {
  it('answers 202 at the deadline and the bid resolves in the background', async () => {
    const slow = await testApp(db, {
      payments: new FakePayments({ latency: () => 300 }),
      bidDeadlineMs: 50,
    });
    try {
      const auction = await openAuction(db);
      const erin = await signIn(slow.app, 'erin');
      const res = await slow.app.inject(bidRequest(erin, auction.id, 2_000));
      expect(res.statusCode).toBe(202);
      const { bid } = res.json<{ bid: { id: string; status: string } }>();
      expect(bid.status).toBe('pending');

      let status = 'pending';
      for (let i = 0; i < 50 && status === 'pending'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const poll = await slow.app.inject({ url: `/bids/${bid.id}`, headers: { cookie: erin } });
        status = poll.json<{ bid: { status: string } }>().bid.status;
      }
      expect(status).toBe('accepted');

      // Someone else asking gets a 404, not a 403: the bid's existence isn't confirmed.
      const frank = await signIn(slow.app, 'frank');
      const peek = await slow.app.inject({ url: `/bids/${bid.id}`, headers: { cookie: frank } });
      expect(peek.statusCode).toBe(404);
    } finally {
      await slow.close();
    }
  });
});

describe('GET /auctions/:id and /me', () => {
  it('shows a public snapshot with aliases, never user ids or logins', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
    await t.app.inject(bidRequest(alice, auction.id, 1_000));
    await t.app.inject(bidRequest(bob, auction.id, 1_100));
    const res = await t.app.inject({ url: `/auctions/${auction.id}`, headers: { cookie: bob } });
    const snap = res.json<{
      auction: { version: number; minimumNextBid: number };
      currentHigh: { amount: number; bidder: string };
      recentBids: { bidder: string }[];
      you: string;
    }>();
    expect(snap.auction).toMatchObject({ version: 2, minimumNextBid: 1_200 });
    expect(snap.currentHigh).toMatchObject({ amount: 1_100, bidder: snap.you });
    expect(snap.recentBids).toHaveLength(2);
    expect(snap.recentBids[1]?.bidder).not.toBe(snap.you);
    expect(res.body).not.toMatch(/alice|bob/);
  });

  it('gives each bidder a different alias in every auction', async () => {
    const [a, b] = [await openAuction(db), await openAuction(db)];
    const you = async (id: string) =>
      (await t.app.inject({ url: `/auctions/${id}`, headers: { cookie: alice } })).json<{
        you: string;
      }>().you;
    expect(await you(a.id)).not.toBe(await you(b.id));
  });

  it('/me is 401 signed out and shows the login signed in', async () => {
    expect((await t.app.inject({ url: '/me' })).statusCode).toBe(401);
    const me = await t.app.inject({ url: '/me', headers: { cookie: alice } });
    expect(me.json()).toEqual({
      user: { login: 'dev-alice' },
      hasCard: false,
      cardRequired: false,
    });
  });

  it('reports health without Redis rather than failing', async () => {
    const res = await t.app.inject({ url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, redis: 'none' });
    expect(ORIGIN).toMatch(/^http/);
  });
});
