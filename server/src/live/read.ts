// The public read model, straight from Postgres (ADR 0004: Postgres is the truth). Every
// event the stream can send is derivable from the tables: an accepted bid keeps its
// auction_version for good, and a closed auction's version is the close. So the snapshot,
// a Last-Event-ID resume and a live update are all one query: "what changed after v?".
import { createHmac } from 'node:crypto';
import type { AuctionEvent, AuctionSnapshot, AuctionStatus, PublicBid } from '@holdfast/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

export type Aliaser = (userId: string, auctionId: string) => string;

/**
 * A bidder's public name in one auction: an HMAC of user and auction, so it's stable within
 * the auction, unlinkable across auctions, and needs nothing stored.
 */
export function aliaser(secret: string): Aliaser {
  return (userId, auctionId) =>
    `Bidder ${createHmac('sha256', secret).update(`${auctionId}:${userId}`).digest('hex').slice(0, 4)}`;
}

// A type alias, not an interface: db.execute<T> needs an index-signature-compatible type.
type AuctionRow = {
  id: string;
  title: string;
  status: AuctionStatus;
  startsAtMs: number;
  endsAtMs: number;
  startingPrice: number;
  minIncrement: number;
  version: number;
  currentHighBidId: string | null;
};

type BidRow = { version: number; amount: number; userId: string; atMs: number; id: string };

async function auctionRow(db: Db, auctionId: string): Promise<AuctionRow | undefined> {
  const res = await db.execute<AuctionRow>(sql`
    select id, title, status,
           floor(extract(epoch from starts_at) * 1000)::float8 as "startsAtMs",
           floor(extract(epoch from ends_at) * 1000)::float8 as "endsAtMs",
           starting_price as "startingPrice", min_increment as "minIncrement",
           version::float8 as version, current_high_bid_id as "currentHighBidId"
      from auctions where id = ${auctionId}`);
  return res.rows[0];
}

async function acceptedBids(
  db: Db,
  auctionId: string,
  where: ReturnType<typeof sql>,
  order: 'asc' | 'desc',
  limit: number,
): Promise<BidRow[]> {
  const res = await db.execute<BidRow>(sql`
    select id, auction_version::float8 as version, amount, user_id as "userId",
           floor(extract(epoch from resolved_at) * 1000)::float8 as "atMs"
      from bids
     where auction_id = ${auctionId} and auction_version is not null and ${where}
     order by auction_version ${order === 'asc' ? sql`asc` : sql`desc`}
     limit ${limit}`);
  return res.rows;
}

function publicBid(alias: Aliaser, auctionId: string, b: BidRow): PublicBid {
  return {
    version: b.version,
    amount: b.amount,
    bidder: alias(b.userId, auctionId),
    at: new Date(b.atMs).toISOString(),
  };
}

const CLOSED: readonly AuctionStatus[] = ['closed', 'settled'];

export async function snapshot(
  db: Db,
  alias: Aliaser,
  auctionId: string,
  viewerId: string | null,
): Promise<AuctionSnapshot | null> {
  const a = await auctionRow(db, auctionId);
  if (!a) return null;
  const recent = await acceptedBids(db, auctionId, sql`true`, 'desc', 20);
  const high = recent.find((b) => b.id === a.currentHighBidId);
  const currentHigh = high ? publicBid(alias, auctionId, high) : null;
  return {
    auction: {
      id: a.id,
      title: a.title,
      status: a.status,
      startsAt: new Date(a.startsAtMs).toISOString(),
      endsAt: new Date(a.endsAtMs).toISOString(),
      startingPrice: a.startingPrice,
      minIncrement: a.minIncrement,
      version: a.version,
      minimumNextBid:
        a.status === 'open' || a.status === 'scheduled'
          ? currentHigh
            ? currentHigh.amount + a.minIncrement
            : a.startingPrice
          : null,
    },
    currentHigh,
    recentBids: recent.map((b) => publicBid(alias, auctionId, b)),
    you: viewerId ? alias(viewerId, auctionId) : null,
  };
}

/**
 * Every event after `version`, in version order; null if the auction doesn't exist. The
 * stream sends exactly these, so a lost or duplicated Redis message can't change what a
 * client sees, only when.
 */
export async function eventsSince(
  db: Db,
  alias: Aliaser,
  auctionId: string,
  version: number,
): Promise<{ events: AuctionEvent[]; version: number } | null> {
  const a = await auctionRow(db, auctionId);
  if (!a) return null;
  const rows = await acceptedBids(db, auctionId, sql`auction_version > ${version}`, 'asc', 1_000);
  const events: AuctionEvent[] = rows.map((b) => ({
    type: 'bid.accepted',
    ...publicBid(alias, auctionId, b),
  }));
  if (CLOSED.includes(a.status) && a.version > version) {
    // The close is the auction's last version; the winner is its current high, if any.
    const [winner] =
      a.currentHighBidId === null
        ? []
        : await acceptedBids(db, auctionId, sql`id = ${a.currentHighBidId}`, 'asc', 1);
    events.push({
      type: 'auction.closed',
      version: a.version,
      status: a.status,
      winner: winner ? alias(winner.userId, auctionId) : null,
      amount: winner?.amount ?? null,
    });
  }
  return { events, version: a.version };
}
