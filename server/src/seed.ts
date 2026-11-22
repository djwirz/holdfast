// Creates demo auctions (spec §6: no public create endpoint in v1). Safe to run twice:
// an auction whose title already exists and hasn't ended is left alone.
import { and, eq, gt } from 'drizzle-orm';
import { createAuction } from './auctions.ts';
import { createDb, databaseUrl, type Db } from './db/client.ts';
import { auctions } from './db/schema.ts';

const MINUTE = 60_000;

export const DEMO_AUCTIONS = [
  { title: 'Hand-thrown stoneware mug', minutes: 30, startingPrice: 1_500, minIncrement: 100 },
  { title: 'Vintage film camera', minutes: 120, startingPrice: 5_000, minIncrement: 250 },
] as const;

export async function seed(
  db: Db,
  now = new Date(),
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const demo of DEMO_AUCTIONS) {
    const live = await db
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(eq(auctions.title, demo.title), gt(auctions.endsAt, now)))
      .limit(1);
    if (live.length > 0) {
      skipped++;
      continue;
    }
    await createAuction(db, {
      title: demo.title,
      startsAt: now,
      endsAt: new Date(now.getTime() + demo.minutes * MINUTE),
      startingPrice: demo.startingPrice,
      minIncrement: demo.minIncrement,
      status: 'open',
    });
    created++;
  }
  return { created, skipped };
}

if (import.meta.main) {
  const { db, pool } = createDb(databaseUrl());
  try {
    const result = await seed(db);
    console.log(
      `seeded: ${String(result.created)} created, ${String(result.skipped)} already live`,
    );
  } finally {
    await pool.end();
  }
}
