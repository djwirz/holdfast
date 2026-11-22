import { describe, expect, it } from 'vitest';
import { BidRequestSchema, NewAuctionSchema } from './schemas.ts';

describe('BidRequestSchema', () => {
  it('accepts integer cents', () => {
    expect(BidRequestSchema.parse({ amount: 1_250 })).toEqual({ amount: 1_250 });
  });
  it.each([{ amount: 12.5 }, { amount: 0 }, { amount: '1250' }, { amount: 1_250, extra: true }])(
    'rejects %j',
    (body) => {
      expect(BidRequestSchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('NewAuctionSchema', () => {
  it('coerces ISO dates', () => {
    const parsed = NewAuctionSchema.parse({
      title: ' Lamp ',
      startsAt: '2026-12-01T12:00:00Z',
      endsAt: '2026-12-01T13:00:00Z',
      startingPrice: 500,
      minIncrement: 50,
    });
    expect(parsed.title).toBe('Lamp');
    expect(parsed.startsAt).toBeInstanceOf(Date);
  });
});
