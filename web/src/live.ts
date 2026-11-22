// What the auction page shows, as a pure reducer over the SSE stream (ADR 0004). Events
// carry the auction version; anything at or below the version already applied is ignored,
// so a reconnect's replay can't double-count a bid or move the price backwards.
import {
  type AuctionEvent,
  type AuctionSnapshot,
  type AuctionStatus,
  formatCents,
  cents,
} from '@holdfast/shared';

export interface AuctionView {
  snapshot: AuctionSnapshot;
  /** The sale, once closed. */
  result: { winner: string | null; amount: number | null } | null;
  /** The latest change, for the screen-reader live region. */
  announcement: string;
}

export type StreamMessage = { type: 'snapshot'; snapshot: AuctionSnapshot } | AuctionEvent;

const CLOSED: readonly AuctionStatus[] = ['closed', 'settled'];

export const money = (amount: number): string => formatCents(cents(amount));

const who = (bidder: string | null, you: string | null) =>
  bidder === null ? 'nobody' : bidder === you ? 'you' : bidder;

function fromSnapshot(snapshot: AuctionSnapshot): AuctionView {
  const closed = CLOSED.includes(snapshot.auction.status);
  return {
    snapshot,
    result: closed
      ? {
          winner: snapshot.currentHigh?.bidder ?? null,
          amount: snapshot.currentHigh?.amount ?? null,
        }
      : null,
    announcement: '',
  };
}

export function apply(view: AuctionView | null, message: StreamMessage): AuctionView | null {
  if (message.type === 'snapshot') return fromSnapshot(message.snapshot);
  // Without a snapshot there's nothing to apply to; the stream always starts with one,
  // except on a resume, which only happens after one.
  if (!view || message.version <= view.snapshot.auction.version) return view;
  const { snapshot } = view;

  if (message.type === 'bid.accepted') {
    const bid = {
      version: message.version,
      amount: message.amount,
      bidder: message.bidder,
      at: message.at,
    };
    return {
      snapshot: {
        ...snapshot,
        auction: {
          ...snapshot.auction,
          version: message.version,
          minimumNextBid: message.amount + snapshot.auction.minIncrement,
        },
        currentHigh: bid,
        recentBids: [bid, ...snapshot.recentBids].slice(0, 20),
      },
      result: null,
      announcement: `New high bid ${money(message.amount)} by ${who(message.bidder, snapshot.you)}.`,
    };
  }

  return {
    snapshot: {
      ...snapshot,
      auction: {
        ...snapshot.auction,
        version: message.version,
        status: message.status,
        minimumNextBid: null,
      },
    },
    result: { winner: message.winner, amount: message.amount },
    announcement:
      message.winner === null || message.amount === null
        ? 'The auction ended with no bids.'
        : `The auction ended. Sold to ${who(message.winner, snapshot.you)} for ${money(message.amount)}.`,
  };
}

/** A bid outcome in plain words (spec §6: the reason is the bidder's own to see). */
export function describeOutcome(status: string, reason: string | null): string {
  switch (status) {
    case 'accepted':
      return 'Your bid is the high bid.';
    case 'pending':
      return 'Confirming your card…';
    case 'outbid':
      return 'You’ve been outbid.';
    case 'won':
      return 'You won.';
    case 'lost_race':
      return reason === 'below_minimum' || reason === 'not_covered'
        ? 'Someone else’s bid was confirmed first. Try again at the new minimum.'
        : `Not accepted: ${REASONS[reason ?? ''] ?? 'the auction changed before your bid was confirmed'}.`;
    default:
      return `Not accepted: ${REASONS[reason ?? ''] ?? 'something went wrong; try again'}.`;
  }
}

const REASONS: Record<string, string> = {
  below_minimum: 'the bid is below the minimum',
  ended: 'the auction has ended',
  not_open: 'the auction isn’t open',
  not_integer_cents: 'enter an amount in dollars and cents',
  card_declined: 'your card was declined',
  generic_decline: 'your card was declined',
  insufficient_funds: 'your card has insufficient funds',
  authentication_required: 'your card needs you to confirm each payment, which bids can’t do',
  no_payment_method: 'add a card first',
  processing_error: 'the payment provider had a problem; try again',
};
