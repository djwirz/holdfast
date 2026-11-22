import { type Cents, isCents } from './money.ts';

export const AUCTION_STATUSES = ['scheduled', 'open', 'closed', 'settled'] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];

export const BID_STATUSES = [
  'pending',
  'accepted',
  'outbid',
  'lost_race',
  'rejected',
  'won',
] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

/** Longest auction allowed: a card hold has to outlive it (spec §2). */
export const MAX_AUCTION_MS = 24 * 60 * 60 * 1000;
export const MAX_TITLE_LENGTH = 120;

/** What the bid rules need to know about an auction. */
export interface AuctionState {
  status: AuctionStatus;
  startsAt: Date;
  endsAt: Date;
  startingPrice: Cents;
  minIncrement: Cents;
  /** Amount of the current high bid, or null before the first accepted bid. */
  currentHigh: Cents | null;
}

export type BidRejection = 'not_open' | 'ended' | 'below_minimum' | 'not_integer_cents';
export type BidCheck = { ok: true } | { ok: false; reason: BidRejection };

export function minimumNextBid(auction: AuctionState): number {
  return auction.currentHigh === null
    ? auction.startingPrice
    : auction.currentHigh + auction.minIncrement;
}

/**
 * The bid rules (spec §4). `now` is passed in: in the bid transaction it's database time,
 * so invariant 3 (closed is closed) doesn't depend on any server's clock.
 */
export function checkBid(auction: AuctionState, amount: number, now: Date): BidCheck {
  if (!isCents(amount)) return { ok: false, reason: 'not_integer_cents' };
  if (now.getTime() >= auction.endsAt.getTime()) return { ok: false, reason: 'ended' };
  if (auction.status !== 'open' || now.getTime() < auction.startsAt.getTime()) {
    return { ok: false, reason: 'not_open' };
  }
  if (amount < minimumNextBid(auction)) return { ok: false, reason: 'below_minimum' };
  return { ok: true };
}

export interface NewAuctionInput {
  title: string;
  startsAt: Date;
  endsAt: Date;
  startingPrice: number;
  minIncrement: number;
}

export type NewAuctionProblem =
  | 'title_empty'
  | 'title_too_long'
  | 'ends_before_start'
  | 'too_long'
  | 'bad_starting_price'
  | 'bad_min_increment';

export function checkNewAuction(input: NewAuctionInput): NewAuctionProblem[] {
  const problems: NewAuctionProblem[] = [];
  const title = input.title.trim();
  if (title.length === 0) problems.push('title_empty');
  if (title.length > MAX_TITLE_LENGTH) problems.push('title_too_long');
  const duration = input.endsAt.getTime() - input.startsAt.getTime();
  if (!(duration > 0)) problems.push('ends_before_start');
  else if (duration > MAX_AUCTION_MS) problems.push('too_long');
  if (!isCents(input.startingPrice)) problems.push('bad_starting_price');
  if (!isCents(input.minIncrement)) problems.push('bad_min_increment');
  return problems;
}
