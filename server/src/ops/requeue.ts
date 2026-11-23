// The runbook's tool (docs/runbook.md): after fixing what made an outbox row give up, put it
// back in the queue. Only rows that failed are touched; a done row is never rerun.
//
//   node src/ops/requeue.ts <outbox id>…        one or more rows
//   node src/ops/requeue.ts --auction <id>      every failed row for one auction
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { createDb, databaseUrl } from '../db/client.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { auction: { type: 'string' } },
});
if (!values.auction && positionals.length === 0) {
  console.error('usage: node src/ops/requeue.ts <outbox id>… | --auction <id>');
  process.exit(2);
}
const ids = positionals.map(Number).filter((n) => Number.isInteger(n) && n > 0);
const { db, pool } = createDb(databaseUrl());
try {
  const where = values.auction ? sql`payload->>'auctionId' = ${values.auction}` : sql`id in ${ids}`;
  const res = await db.execute<{ id: number; kind: string }>(sql`
    update outbox
       set failed_at = null, last_error = null, attempts = 0, available_at = clock_timestamp()
     where failed_at is not null and ${where}
     returning id::float8 as id, kind::text`);
  for (const r of res.rows) console.log(`requeued ${r.kind} row ${String(r.id)}`);
  if (res.rows.length === 0) console.log('no failed rows matched');
} finally {
  await pool.end();
}
