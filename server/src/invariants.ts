// The invariant checker (spec §7). The concurrency test runs it now and the load test
// will in slice 6. It reads the database and the payment provider and reports every
// violation with its evidence; an empty list is the claim "zero violations".
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { auctions, bids, outbox } from './db/schema.ts';
import type { Payments, PaymentIntentView } from './payments/port.ts';

export interface Violation {
  invariant: 1 | 2 | 3 | 4 | 5;
  auctionId: string;
  bidId?: string;
  message: string;
}

/** Extra evidence only the fake can give: how often each key was sent to authorize. */
export interface PaymentsAudit {
  callsByKey: ReadonlyMap<string, number>;
  intents: ReadonlyMap<string, PaymentIntentView>;
}

const EVER_ACCEPTED = new Set(['accepted', 'outbid', 'won']);

export async function checkInvariants(
  db: Db,
  payments: Payments,
  options: { auctionId?: string; audit?: PaymentsAudit } = {},
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const auctionRows = options.auctionId
    ? await db.select().from(auctions).where(eq(auctions.id, options.auctionId))
    : await db.select().from(auctions);
  if (auctionRows.length === 0) return violations;
  const ids = auctionRows.map((a) => a.id);
  const bidRows = await db.select().from(bids).where(inArray(bids.auctionId, ids));
  const cancelRows = await db.select().from(outbox).where(eq(outbox.kind, 'cancel_hold'));

  const cancelsByBid = new Map<string, number>();
  for (const row of cancelRows) {
    const bidId = (row.payload as { bidId?: unknown }).bidId;
    if (typeof bidId === 'string') cancelsByBid.set(bidId, (cancelsByBid.get(bidId) ?? 0) + 1);
  }

  // Invariant 5, across everything checked: one hold per bid, one bid per hold.
  const bidsByIntent = new Map<string, string[]>();
  for (const b of bidRows) {
    if (b.paymentIntentId === null) continue;
    bidsByIntent.set(b.paymentIntentId, [...(bidsByIntent.get(b.paymentIntentId) ?? []), b.id]);
  }
  for (const [intentId, bidIds] of bidsByIntent) {
    if (bidIds.length > 1) {
      const first = bidRows.find((b) => b.id === bidIds[0]);
      violations.push({
        invariant: 5,
        auctionId: first?.auctionId ?? '',
        message: `PaymentIntent ${intentId} is shared by bids ${bidIds.join(', ')}`,
      });
    }
  }
  if (options.audit) {
    const intentsPerBid = new Map<string, number>();
    for (const intent of options.audit.intents.values()) {
      const n = (intentsPerBid.get(intent.metadata.bidId) ?? 0) + 1;
      intentsPerBid.set(intent.metadata.bidId, n);
    }
    for (const b of bidRows) {
      const calls = options.audit.callsByKey.get(b.id) ?? 0;
      const intents = intentsPerBid.get(b.id) ?? 0;
      if (calls > 1 || intents > 1) {
        violations.push({
          invariant: 5,
          auctionId: b.auctionId,
          bidId: b.id,
          message: `bid sent to authorize ${String(calls)} times, ${String(intents)} intents created`,
        });
      }
    }
  }

  for (const auction of auctionRows) {
    const mine = bidRows.filter((b) => b.auctionId === auction.id);
    const everAccepted = mine
      .filter((b) => EVER_ACCEPTED.has(b.status))
      .sort((a, b) => (a.auctionVersion ?? 0) - (b.auctionVersion ?? 0));
    const fail = (invariant: Violation['invariant'], message: string, bidId?: string) => {
      violations.push({ invariant, auctionId: auction.id, message, ...(bidId ? { bidId } : {}) });
    };

    // Invariant 1: covered.
    for (const b of everAccepted) {
      if (b.paymentIntentId === null) {
        fail(1, 'accepted bid has no PaymentIntent', b.id);
        continue;
      }
      const intent = await payments.retrieve(b.paymentIntentId);
      if (!intent) fail(1, `PaymentIntent ${b.paymentIntentId} not found`, b.id);
      else if (intent.amount < b.amount || intent.metadata.bidId !== b.id) {
        fail(
          1,
          `PaymentIntent ${intent.id} for ${String(intent.amount)} doesn't cover bid of ${String(b.amount)}`,
          b.id,
        );
      } else if (b.status === 'accepted' && intent.status !== 'requires_capture') {
        fail(1, `current high's hold is ${intent.status}`, b.id);
      }
    }

    // Invariant 2: ordered.
    let previous: (typeof everAccepted)[number] | undefined;
    everAccepted.forEach((b, i) => {
      if (b.auctionVersion !== i + 1) {
        fail(
          2,
          `expected auction_version ${String(i + 1)}, found ${String(b.auctionVersion)}`,
          b.id,
        );
      }
      const minimum = previous ? previous.amount + auction.minIncrement : auction.startingPrice;
      if (b.amount < minimum) {
        fail(
          2,
          `amount ${String(b.amount)} below the minimum ${String(minimum)} at version ${String(b.auctionVersion)}`,
          b.id,
        );
      }
      previous = b;
    });
    const current = everAccepted.filter((b) => b.status === 'accepted');
    if (everAccepted.length > 0 && current.length !== 1) {
      fail(2, `${String(current.length)} bids are accepted; expected exactly one`);
    }
    const last = everAccepted.at(-1);
    if ((last?.id ?? null) !== auction.currentHighBidId || (last && last.status !== 'accepted')) {
      fail(
        2,
        `current_high_bid_id ${String(auction.currentHighBidId)} isn't the last accepted bid ${String(last?.id)}`,
      );
    }
    if (auction.version !== everAccepted.length) {
      fail(
        2,
        `auction version ${String(auction.version)} but ${String(everAccepted.length)} accepted bids`,
      );
    }

    // Invariant 3: closed is closed.
    for (const b of everAccepted) {
      if (b.resolvedAt === null || b.resolvedAt.getTime() >= auction.endsAt.getTime()) {
        fail(
          3,
          `accepted at ${String(b.resolvedAt?.toISOString())}, ends_at ${auction.endsAt.toISOString()}`,
          b.id,
        );
      }
    }

    // Invariant 4, slice 2 form: every hold that isn't the current high's is queued for
    // cancellation exactly once, and the current high's isn't. Slice 3 adds "and canceled".
    for (const b of mine) {
      if (b.paymentIntentId === null || b.status === 'pending') continue;
      const cancels = cancelsByBid.get(b.id) ?? 0;
      const isCurrentHigh = b.id === auction.currentHighBidId;
      if (isCurrentHigh && cancels > 0) fail(4, 'current high bid has a cancel_hold queued', b.id);
      if (!isCurrentHigh && cancels !== 1) {
        fail(4, `${b.status} bid's hold has ${String(cancels)} cancel_hold rows; expected 1`, b.id);
      }
    }
  }
  return violations;
}
