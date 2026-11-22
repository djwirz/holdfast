import type { AuctionSnapshot } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { type AuctionView, apply, describeOutcome } from './live.ts';

const snapshot: AuctionSnapshot = {
  auction: {
    id: 'a1',
    title: 'Lamp',
    status: 'open',
    startsAt: '2026-11-22T00:00:00.000Z',
    endsAt: '2026-11-22T01:00:00.000Z',
    startingPrice: 1_000,
    minIncrement: 100,
    version: 0,
    minimumNextBid: 1_000,
  },
  currentHigh: null,
  recentBids: [],
  you: 'Bidder aaaa',
};

const bid = (version: number, amount: number, bidder = 'Bidder bbbb') => ({
  type: 'bid.accepted' as const,
  version,
  amount,
  bidder,
  at: '2026-11-22T00:10:00.000Z',
});

const start = (): AuctionView | null => apply(null, { type: 'snapshot', snapshot });

describe('apply', () => {
  it('applies accepted bids in version order and announces them', () => {
    let view = start();
    view = apply(view, bid(1, 1_000));
    view = apply(view, bid(2, 1_200, 'Bidder aaaa'));
    expect(view?.snapshot.currentHigh?.amount).toBe(1_200);
    expect(view?.snapshot.auction.minimumNextBid).toBe(1_300);
    expect(view?.snapshot.recentBids.map((b) => b.version)).toEqual([2, 1]);
    expect(view?.announcement).toBe('New high bid $12.00 by you.');
  });

  it('ignores a replayed or stale version, so a reconnect cannot double-count', () => {
    let view = apply(start(), bid(1, 1_000));
    view = apply(view, bid(2, 1_100));
    const before = view;
    view = apply(view, bid(2, 1_100));
    view = apply(view, bid(1, 1_000));
    expect(view).toBe(before);
    expect(view?.snapshot.recentBids).toHaveLength(2);
  });

  it('closes with the result and no minimum', () => {
    let view = apply(start(), bid(1, 1_000));
    view = apply(view, {
      type: 'auction.closed',
      version: 2,
      status: 'closed',
      winner: 'Bidder bbbb',
      amount: 1_000,
    });
    expect(view?.result).toEqual({ winner: 'Bidder bbbb', amount: 1_000 });
    expect(view?.snapshot.auction.minimumNextBid).toBeNull();
    expect(view?.announcement).toBe('The auction ended. Sold to Bidder bbbb for $10.00.');
  });

  it('reads a closed snapshot as a finished sale', () => {
    const closed = apply(null, {
      type: 'snapshot',
      snapshot: {
        ...snapshot,
        auction: { ...snapshot.auction, status: 'settled', minimumNextBid: null },
        currentHigh: { version: 1, amount: 1_500, bidder: 'Bidder aaaa', at: '' },
      },
    });
    expect(closed?.result).toEqual({ winner: 'Bidder aaaa', amount: 1_500 });
  });
});

describe('describeOutcome', () => {
  it('puts reasons in plain words', () => {
    expect(describeOutcome('rejected', 'insufficient_funds')).toMatch(/insufficient funds/);
    expect(describeOutcome('lost_race', 'below_minimum')).toMatch(/confirmed first/);
    expect(describeOutcome('rejected', 'something_new')).toMatch(/try again/);
  });
});
