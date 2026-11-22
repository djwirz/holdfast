// The invariant checker as a command (spec §7, §11.2): after a load or end-to-end run against
// the running stack, wait until the auction has closed and everything has settled, then
// check all five invariants against the database and the shared Stripe fake's own record.
// Exits 1 on any violation, and on any failed outbox row (a side effect that gave up).
//
//   node src/check-invariants.ts --auction <id> [--wait 120] [--fake http://127.0.0.1:4010] [--out file.json]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { createDb, databaseUrl } from './db/client.ts';
import { checkInvariants } from './invariants.ts';
import { HttpFakePayments } from './payments/http-fake.ts';

const { values: args } = parseArgs({
  options: {
    auction: { type: 'string' },
    wait: { type: 'string', default: '120' },
    fake: { type: 'string' },
    out: { type: 'string' },
    'min-accepted': { type: 'string', default: '1' },
  },
});
if (!args.auction) {
  console.error('usage: node src/check-invariants.ts --auction <id> [--wait seconds] [--fake url]');
  process.exit(2);
}
const auctionId: string = args.auction;
const fakeUrl = args.fake ?? process.env['FAKE_PAYMENTS_URL'] ?? 'http://127.0.0.1:4010';
const payments = new HttpFakePayments(fakeUrl);
const { db, pool } = createDb(databaseUrl());

type State = {
  status: string;
  endsAtMs: number;
  pending: number;
  outboxOpen: number;
  outboxFailed: number;
  accepted: number;
  lostRace: number;
  rejected: number;
  won: number;
};

async function state(): Promise<State> {
  const res = await db.execute<State>(sql`
    select a.status, floor(extract(epoch from a.ends_at) * 1000)::float8 as "endsAtMs",
      (select count(*)::int from bids b where b.auction_id = a.id and b.status = 'pending') as pending,
      (select count(*)::int from outbox o where o.payload->>'auctionId' = a.id::text
         and o.done_at is null and o.failed_at is null) as "outboxOpen",
      (select count(*)::int from outbox o where o.payload->>'auctionId' = a.id::text
         and o.failed_at is not null) as "outboxFailed",
      (select count(*)::int from bids b where b.auction_id = a.id and b.auction_version is not null) as accepted,
      (select count(*)::int from bids b where b.auction_id = a.id and b.status = 'lost_race') as "lostRace",
      (select count(*)::int from bids b where b.auction_id = a.id and b.status = 'rejected') as rejected,
      (select count(*)::int from bids b where b.auction_id = a.id and b.status = 'won') as won
    from auctions a where a.id = ${auctionId}`);
  const row = res.rows[0];
  if (!row) throw new Error(`no auction ${auctionId}`);
  return row;
}

let exitCode = 0;
try {
  // Quiet means: closed by the close job, no bid waiting on a hold, and every side effect
  // either done or given up. The servers' own loops get it there; this only watches.
  const deadline = Date.now() + Number(args.wait) * 1000;
  let s = await state();
  while (
    !(['closed', 'settled'].includes(s.status) && s.pending === 0 && s.outboxOpen === 0) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 500));
    s = await state();
  }
  const quiet = ['closed', 'settled'].includes(s.status) && s.pending === 0 && s.outboxOpen === 0;

  const audit = await payments.audit();
  const violations = quiet
    ? await checkInvariants(db, payments, { auctionId, audit, outboxIdle: true })
    : [];
  const holds = [...audit.intents.values()].filter((i) => i.metadata.auctionId === auctionId);
  const summary = {
    auctionId,
    quiet,
    status: s.status,
    endsAt: new Date(s.endsAtMs).toISOString(),
    bidsAccepted: s.accepted,
    lostRace: s.lostRace,
    rejected: s.rejected,
    won: s.won,
    holds: holds.length,
    holdsReleased: holds.filter((i) => i.status === 'canceled').length,
    holdsCaptured: holds.filter((i) => i.status === 'succeeded').length,
    holdsLive: holds.filter((i) => i.status === 'requires_capture').length,
    outboxFailed: s.outboxFailed,
    violations,
  };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(
    `${s.status}: ${String(s.accepted)} accepted, ${String(s.lostRace)} lost races, ` +
      `${String(s.rejected)} rejected; holds ${String(summary.holdsReleased)} released, ` +
      `${String(summary.holdsCaptured)} captured, ${String(summary.holdsLive)} live`,
  );
  if (!quiet) {
    console.error(
      `not quiet after ${args.wait}s: status ${s.status}, ${String(s.pending)} pending bids, ` +
        `${String(s.outboxOpen)} open outbox rows`,
    );
    exitCode = 1;
  }
  if (s.outboxFailed > 0) {
    console.error(`${String(s.outboxFailed)} outbox rows failed (a side effect gave up)`);
    exitCode = 1;
  }
  for (const v of violations) {
    console.error(
      `invariant ${String(v.invariant)}: ${v.message}${v.bidId ? ` (bid ${v.bidId})` : ''}`,
    );
  }
  if (violations.length > 0) exitCode = 1;
  // Zero violations over nothing proves nothing.
  if (s.accepted < Number(args['min-accepted'])) {
    console.error(
      `only ${String(s.accepted)} bids accepted; expected at least ${args['min-accepted']}`,
    );
    exitCode = 1;
  }
  if (exitCode === 0) console.log('0 violations');
} finally {
  await pool.end();
}
process.exit(exitCode);
