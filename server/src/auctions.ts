import { type NewAuctionInput, checkNewAuction } from '@holdfast/shared';
import type { Db } from './db/client.ts';
import { auctions } from './db/schema.ts';

export class InvalidAuctionError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid auction: ${problems.join(', ')}`);
    this.problems = problems;
    this.name = 'InvalidAuctionError';
  }
}

/**
 * The one way to create an auction (spec §6): the seed script uses it now, and the admin
 * page will if it's built. The database CHECKs repeat the important rules as a backstop.
 */
export async function createAuction(
  // A database or a transaction: it only inserts.
  db: Pick<Db, 'insert'>,
  input: NewAuctionInput & { status?: 'scheduled' | 'open' },
): Promise<typeof auctions.$inferSelect> {
  const problems = checkNewAuction(input);
  if (problems.length > 0) throw new InvalidAuctionError(problems);
  const [row] = await db
    .insert(auctions)
    .values({
      title: input.title.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      startingPrice: input.startingPrice,
      minIncrement: input.minIncrement,
      status: input.status ?? 'scheduled',
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}
