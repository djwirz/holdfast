import { z } from 'zod';
import { MAX_CENTS } from './money.ts';
import { MAX_TITLE_LENGTH } from './rules.ts';

export const CentsSchema = z.number().int().positive().max(MAX_CENTS);

/** Request body for POST /auctions/:id/bids (spec §6). */
export const BidRequestSchema = z.strictObject({ amount: CentsSchema });
export type BidRequest = z.infer<typeof BidRequestSchema>;

/** Shape-level validation for a new auction; checkNewAuction adds the cross-field rules. */
export const NewAuctionSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  startingPrice: CentsSchema,
  minIncrement: CentsSchema,
});
export type NewAuction = z.infer<typeof NewAuctionSchema>;
