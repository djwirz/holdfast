// One short auction for an end-to-end test, through the same validated create function
// the demo seed uses (no public create endpoint in v1). Prints the auction as JSON.
//   node src/seed-e2e.ts [secondsUntilEnd] [title]
import { createAuction } from './auctions.ts';
import { createDb, databaseUrl } from './db/client.ts';

const seconds = Number(process.argv[2] ?? 30);
const title = process.argv[3] ?? `E2E auction ${new Date().toISOString()}`;
const { db, pool } = createDb(databaseUrl());
try {
  const now = Date.now();
  const auction = await createAuction(db, {
    title,
    startsAt: new Date(now - 1_000),
    endsAt: new Date(now + seconds * 1_000),
    startingPrice: 1_000,
    minIncrement: 100,
    status: 'open',
  });
  console.log(JSON.stringify({ id: auction.id, title: auction.title }));
} finally {
  await pool.end();
}
