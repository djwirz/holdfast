import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CENTS, cents } from './money.ts';
import {
  type AuctionState,
  MAX_AUCTION_MS,
  checkBid,
  checkNewAuction,
  minimumNextBid,
} from './rules.ts';

const start = new Date('2026-12-01T12:00:00.000Z');
const end = new Date('2026-12-01T13:00:00.000Z');
const during = new Date('2026-12-01T12:30:00.000Z');

function auction(overrides: Partial<AuctionState> = {}): AuctionState {
  return {
    status: 'open',
    startsAt: start,
    endsAt: end,
    startingPrice: cents(1_000),
    minIncrement: cents(100),
    currentHigh: null,
    ...overrides,
  };
}

describe('minimumNextBid', () => {
  it('is the starting price before any bid', () => {
    expect(minimumNextBid(auction())).toBe(1_000);
  });
  it('is the current high plus the increment after one', () => {
    expect(minimumNextBid(auction({ currentHigh: cents(1_500) }))).toBe(1_600);
  });
});

describe('checkBid', () => {
  it.each([
    ['exactly the starting price', auction(), 1_000, during, { ok: true }],
    [
      'one cent below the starting price',
      auction(),
      999,
      during,
      { ok: false, reason: 'below_minimum' },
    ],
    [
      'exactly high plus increment',
      auction({ currentHigh: cents(1_500) }),
      1_600,
      during,
      { ok: true },
    ],
    [
      'one cent short of high plus increment',
      auction({ currentHigh: cents(1_500) }),
      1_599,
      during,
      { ok: false, reason: 'below_minimum' },
    ],
    [
      'equal to the current high',
      auction({ currentHigh: cents(1_500) }),
      1_500,
      during,
      { ok: false, reason: 'below_minimum' },
    ],
    ['exactly at starts_at', auction(), 1_000, start, { ok: true }],
    [
      'one ms before starts_at',
      auction(),
      1_000,
      new Date(start.getTime() - 1),
      { ok: false, reason: 'not_open' },
    ],
    ['one ms before ends_at', auction(), 1_000, new Date(end.getTime() - 1), { ok: true }],
    ['exactly at ends_at', auction(), 1_000, end, { ok: false, reason: 'ended' }],
    [
      'after ends_at',
      auction(),
      1_000,
      new Date(end.getTime() + 1),
      { ok: false, reason: 'ended' },
    ],
    [
      'a scheduled auction',
      auction({ status: 'scheduled' }),
      1_000,
      during,
      { ok: false, reason: 'not_open' },
    ],
    [
      'a closed auction before ends_at',
      auction({ status: 'closed' }),
      1_000,
      during,
      { ok: false, reason: 'not_open' },
    ],
    ['a fractional amount', auction(), 1_000.5, during, { ok: false, reason: 'not_integer_cents' }],
    ['zero', auction(), 0, during, { ok: false, reason: 'not_integer_cents' }],
    ['a negative amount', auction(), -1_000, during, { ok: false, reason: 'not_integer_cents' }],
    [
      'above the ceiling',
      auction(),
      MAX_CENTS + 1,
      during,
      { ok: false, reason: 'not_integer_cents' },
    ],
    ['NaN', auction(), Number.NaN, during, { ok: false, reason: 'not_integer_cents' }],
  ] as const)('%s', (_name, a, amount, now, expected) => {
    expect(checkBid(a, amount, now)).toEqual(expected);
  });

  const arbAuction = fc
    .record({
      startingPrice: fc.integer({ min: 1, max: 1_000_000 }),
      minIncrement: fc.integer({ min: 1, max: 100_000 }),
      currentHigh: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
    })
    .map((r) =>
      auction({
        startingPrice: cents(r.startingPrice),
        minIncrement: cents(r.minIncrement),
        currentHigh: r.currentHigh === null ? null : cents(r.currentHigh),
      }),
    );

  it('never accepts an amount below the minimum next bid', () => {
    fc.assert(
      fc.property(arbAuction, fc.integer({ min: 1, max: 2_000_000 }), (a, amount) => {
        if (checkBid(a, amount, during).ok)
          expect(amount).toBeGreaterThanOrEqual(minimumNextBid(a));
      }),
    );
  });

  it('never accepts at or after ends_at', () => {
    fc.assert(
      fc.property(
        arbAuction,
        fc.integer({ min: 1, max: MAX_CENTS }),
        fc.integer({ min: 0, max: 10 * MAX_AUCTION_MS }),
        (a, amount, msAfterEnd) => {
          expect(checkBid(a, amount, new Date(end.getTime() + msAfterEnd)).ok).toBe(false);
        },
      ),
    );
  });
});

describe('checkNewAuction', () => {
  const valid = {
    title: 'Signed first edition',
    startsAt: start,
    endsAt: end,
    startingPrice: 1_000,
    minIncrement: 100,
  };

  it('accepts a valid auction', () => {
    expect(checkNewAuction(valid)).toEqual([]);
  });
  it('accepts exactly one day', () => {
    expect(
      checkNewAuction({ ...valid, endsAt: new Date(start.getTime() + MAX_AUCTION_MS) }),
    ).toEqual([]);
  });
  it('refuses one day plus one ms', () => {
    expect(
      checkNewAuction({ ...valid, endsAt: new Date(start.getTime() + MAX_AUCTION_MS + 1) }),
    ).toEqual(['too_long']);
  });
  it('refuses ending at or before the start', () => {
    expect(checkNewAuction({ ...valid, endsAt: start })).toEqual(['ends_before_start']);
  });
  it('refuses a blank title', () => {
    expect(checkNewAuction({ ...valid, title: '   ' })).toEqual(['title_empty']);
  });
  it('refuses a long title', () => {
    expect(checkNewAuction({ ...valid, title: 'x'.repeat(121) })).toEqual(['title_too_long']);
  });
  it('refuses bad prices', () => {
    expect(checkNewAuction({ ...valid, startingPrice: 0, minIncrement: 0.5 })).toEqual([
      'bad_starting_price',
      'bad_min_increment',
    ]);
  });
});
