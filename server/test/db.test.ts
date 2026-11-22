import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidAuctionError, createAuction } from '../src/auctions.ts';
import type { Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { auctions, bids, users } from '../src/db/schema.ts';
import { DEMO_AUCTIONS, seed } from '../src/seed.ts';
import { type TestDb, freshDb } from './support/db.ts';

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate sessions, bids, auctions, users restart identity cascade`);
});

const start = new Date('2026-12-01T12:00:00.000Z');
const hour = 60 * 60 * 1000;
const day = 24 * hour;

const lamp = {
  title: 'Brass desk lamp',
  startsAt: start,
  endsAt: new Date(start.getTime() + hour),
  startingPrice: 2_000,
  minIncrement: 100,
};

/** The Postgres error under drizzle's wrapper, so tests can check the constraint name. */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause ?? e;
    return cause as { code?: string; constraint?: string };
  }
  throw new Error('expected the database to refuse this');
}

async function aUser(githubId = 1) {
  const [u] = await db
    .insert(users)
    .values({ githubId, login: `user${String(githubId)}` })
    .returning();
  if (!u) throw new Error('no user');
  return u;
}

describe('migrations', () => {
  it('apply cleanly and are idempotent', async () => {
    await runMigrations(db);
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'auctions',
      'bids',
      'outbox',
      'sessions',
      'stripe_events',
      'users',
    ]);
  });
});

describe('createAuction', () => {
  it('round-trips a valid auction', async () => {
    const created = await createAuction(db, lamp);
    expect(created).toMatchObject({
      title: 'Brass desk lamp',
      status: 'scheduled',
      startingPrice: 2_000,
      minIncrement: 100,
      version: 0,
      currentHighBidId: null,
    });
    expect(created.endsAt.toISOString()).toBe('2026-12-01T13:00:00.000Z');
  });

  it('refuses an invalid auction before touching the database', async () => {
    await expect(
      createAuction(db, { ...lamp, endsAt: new Date(start.getTime() + day + 1) }),
    ).rejects.toBeInstanceOf(InvalidAuctionError);
  });
});

describe('database constraints (backstop when application checks are bypassed)', () => {
  it.each([
    [
      'longer than a day',
      { endsAt: new Date(start.getTime() + day + 1000) },
      'auctions_at_most_one_day',
    ],
    ['ending before it starts', { endsAt: start }, 'auctions_ends_after_starts'],
    ['a zero starting price', { startingPrice: 0 }, 'auctions_starting_price_positive'],
    ['a negative increment', { minIncrement: -1 }, 'auctions_min_increment_positive'],
    ['a blank title', { title: '  ' }, 'auctions_title_not_blank'],
  ])('refuses an auction %s', async (_name, overrides, constraint) => {
    const err = await pgError(db.insert(auctions).values({ ...lamp, ...overrides }));
    expect(err).toMatchObject({ code: '23514', constraint });
  });

  it('refuses a second bid with the same user and idempotency key', async () => {
    const user = await aUser();
    const auction = await createAuction(db, lamp);
    const bid = { auctionId: auction.id, userId: user.id, idempotencyKey: 'k1', amount: 2_000 };
    await db.insert(bids).values(bid);
    const err = await pgError(db.insert(bids).values({ ...bid, amount: 2_100 }));
    expect(err).toMatchObject({ code: '23505', constraint: 'bids_user_idempotency_key' });
  });

  it('allows the same idempotency key for different users', async () => {
    const [a, b] = [await aUser(1), await aUser(2)];
    const auction = await createAuction(db, lamp);
    await db.insert(bids).values([
      { auctionId: auction.id, userId: a.id, idempotencyKey: 'same', amount: 2_000 },
      { auctionId: auction.id, userId: b.id, idempotencyKey: 'same', amount: 2_100 },
    ]);
  });

  it('refuses two bids accepted at the same auction version', async () => {
    const user = await aUser();
    const auction = await createAuction(db, lamp);
    const accepted = {
      auctionId: auction.id,
      userId: user.id,
      status: 'accepted' as const,
      auctionVersion: 1,
    };
    await db.insert(bids).values({ ...accepted, idempotencyKey: 'a', amount: 2_000 });
    const err = await pgError(
      db.insert(bids).values({ ...accepted, idempotencyKey: 'b', amount: 2_100 }),
    );
    expect(err).toMatchObject({ code: '23505', constraint: 'bids_auction_version' });
  });

  it('refuses a non-positive bid amount', async () => {
    const user = await aUser();
    const auction = await createAuction(db, lamp);
    const err = await pgError(
      db
        .insert(bids)
        .values({ auctionId: auction.id, userId: user.id, idempotencyKey: 'z', amount: 0 }),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'bids_amount_positive' });
  });
});

describe('seed', () => {
  it('creates the demo auctions once, then leaves live ones alone', async () => {
    const now = new Date();
    expect(await seed(db, now)).toEqual({ created: DEMO_AUCTIONS.length, skipped: 0 });
    expect(await seed(db, now)).toEqual({ created: 0, skipped: DEMO_AUCTIONS.length });
    const rows = await db.select().from(auctions);
    expect(rows).toHaveLength(DEMO_AUCTIONS.length);
    expect(rows.every((r) => r.status === 'open')).toBe(true);
  });
});
