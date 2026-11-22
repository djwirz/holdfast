// The data model in spec §4. Rules the database can enforce on its own are CHECKs and
// unique indexes here, so a bug in application code can't write a state the invariants forbid.
import { AUCTION_STATUSES, BID_STATUSES } from '@holdfast/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const auctionStatus = pgEnum('auction_status', AUCTION_STATUSES);
export const bidStatus = pgEnum('bid_status', BID_STATUSES);
export const outboxKind = pgEnum('outbox_kind', ['cancel_hold', 'capture', 'publish']);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  login: text('login').notNull(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  defaultPaymentMethodId: text('default_payment_method_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auctions = pgTable(
  'auctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: auctionStatus('status').notNull().default('scheduled'),
    startingPrice: integer('starting_price').notNull(),
    minIncrement: integer('min_increment').notNull(),
    currentHighBidId: uuid('current_high_bid_id').references((): AnyPgColumn => bids.id),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('auctions_ends_after_starts', sql`${t.endsAt} > ${t.startsAt}`),
    // A card hold must outlive the auction (spec §2).
    check('auctions_at_most_one_day', sql`${t.endsAt} - ${t.startsAt} <= interval '1 day'`),
    check('auctions_starting_price_positive', sql`${t.startingPrice} > 0`),
    check('auctions_min_increment_positive', sql`${t.minIncrement} > 0`),
    check('auctions_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    index('auctions_status_ends_at').on(t.status, t.endsAt),
  ],
);

export const bids = pgTable(
  'bids',
  {
    // Also the Stripe idempotency key for the hold (spec §5).
    id: uuid('id').primaryKey().defaultRandom(),
    auctionId: uuid('auction_id')
      .notNull()
      .references(() => auctions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    amount: integer('amount').notNull(),
    status: bidStatus('status').notNull().default('pending'),
    reason: text('reason'),
    paymentIntentId: text('payment_intent_id'),
    auctionVersion: bigint('auction_version', { mode: 'number' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    check('bids_amount_positive', sql`${t.amount} > 0`),
    // Invariant 5: a retry with the same user and key finds the existing bid.
    uniqueIndex('bids_user_idempotency_key').on(t.userId, t.idempotencyKey),
    uniqueIndex('bids_payment_intent_id')
      .on(t.paymentIntentId)
      .where(sql`${t.paymentIntentId} is not null`),
    // Invariant 2: two bids can never be accepted at the same auction version.
    uniqueIndex('bids_auction_version')
      .on(t.auctionId, t.auctionVersion)
      .where(sql`${t.auctionVersion} is not null`),
    // The reconciler looks for stale pending bids.
    index('bids_status_created_at').on(t.status, t.createdAt),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: outboxKind('kind').notNull(),
    // Includes the W3C traceparent, so one bid's trace spans the side effects (spec §8).
    payload: jsonb('payload').notNull(),
    availableAt: ts('available_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    doneAt: ts('done_at'),
    // A row that hit a permanent error or ran out of attempts stops here, visible to
    // alerts (spec §7, §8) instead of retrying forever.
    failedAt: ts('failed_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // The claim query: undone rows that are due, oldest first.
    index('outbox_due')
      .on(t.availableAt)
      .where(sql`${t.doneAt} is null and ${t.failedAt} is null`),
  ],
);

export const stripeEvents = pgTable('stripe_events', {
  // Stripe's event id: dedupes webhook deliveries (spec §5).
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_expires_at').on(t.expiresAt)],
);
