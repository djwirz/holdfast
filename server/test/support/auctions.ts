import { createAuction } from '../../src/auctions.ts';
import type { Db } from '../../src/db/client.ts';

/** An open auction around the current time; offsets are in ms from now. */
export async function openAuction(
  db: Db,
  options: {
    startsIn?: number;
    endsIn?: number;
    startingPrice?: number;
    minIncrement?: number;
  } = {},
) {
  const now = Date.now();
  return createAuction(db, {
    title: 'Test auction',
    startsAt: new Date(now + (options.startsIn ?? -60_000)),
    endsAt: new Date(now + (options.endsIn ?? 60 * 60_000)),
    startingPrice: options.startingPrice ?? 2_000,
    minIncrement: options.minIncrement ?? 100,
    status: 'open',
  });
}
