// What the public API and the SSE stream show (spec §6): amounts, versions and per-auction
// bidder aliases, never user ids, logins or another bidder's rejection reasons.
import type { AuctionStatus } from './rules.ts';

export interface PublicBid {
  version: number;
  amount: number;
  /** "Bidder 3f9a": stable within one auction, unlinkable across auctions. */
  bidder: string;
  at: string;
}

export type AuctionEvent =
  | ({ type: 'bid.accepted' } & PublicBid)
  | {
      type: 'auction.closed';
      version: number;
      status: AuctionStatus;
      winner: string | null;
      amount: number | null;
    };

export interface AuctionSnapshot {
  auction: {
    id: string;
    title: string;
    status: AuctionStatus;
    startsAt: string;
    endsAt: string;
    startingPrice: number;
    minIncrement: number;
    version: number;
    minimumNextBid: number | null;
  };
  currentHigh: PublicBid | null;
  /** The most recent accepted bids, newest first. */
  recentBids: PublicBid[];
  /** The caller's own alias in this auction, if signed in. */
  you: string | null;
}
