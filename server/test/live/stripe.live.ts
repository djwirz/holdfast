// The opt-in suite against real Stripe test mode (spec §10): `pnpm test:live`. It checks
// that the adapter maps Stripe the way the fake behaves, runs the bid flow end to end with
// real holds, and runs the incremental-authorization experiment (spec §13 Q2). It is never
// part of CI; it runs by hand before a payment-touching merge.
import { cents } from '@holdfast/shared';
import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Bid, placeBid } from '../../src/bids/place-bid.ts';
import type { Db } from '../../src/db/client.ts';
import { auctions, bids, users } from '../../src/db/schema.ts';
import { checkInvariants } from '../../src/invariants.ts';
import { tickLifecycleOnce } from '../../src/lifecycle.ts';
import { customerFromUsers } from '../../src/payments/customers.ts';
import { TransientPaymentsError } from '../../src/payments/port.ts';
import { StripePayments, stripeAudit, stripeClient } from '../../src/payments/stripe.ts';
import { openAuction } from '../support/auctions.ts';
import { type TestDb, createUsers, freshDb } from '../support/db.ts';
import { settle } from '../support/settle.ts';

const key = process.env['STRIPE_SECRET_KEY'] ?? '';
const enabled = process.env['STRIPE_LIVE_TEST'] === '1' && key.startsWith('sk_test_');

let testDb: TestDb;
let db: Db;
let client: Stripe;
let payments: StripePayments;
const customerIds: string[] = [];
const run = `live-${String(Date.now())}`;

/**
 * Cards Stripe declines when they're saved, so card setup (slice 4) would never store
 * them. To see how a bid maps their decline, the bid uses the test token unsaved.
 */
const DECLINED_AT_SAVE = new Set(['pm_card_visa_chargeDeclinedInsufficientFunds']);

/** A Customer with this test card saved, as card setup (slice 4) will leave it. */
async function customerWithCard(card: string) {
  const customer = await client.customers.create({ metadata: { holdfast: run } });
  customerIds.push(customer.id);
  if (DECLINED_AT_SAVE.has(card)) return { customerId: customer.id, paymentMethodId: card };
  const pm = await client.paymentMethods.attach(card, { customer: customer.id });
  return { customerId: customer.id, paymentMethodId: pm.id };
}

/** Users in the test database, each with a Stripe Customer and the given card. */
async function bidders(cards: string[]): Promise<string[]> {
  const ids = await createUsers(db, cards.length);
  for (const [i, card] of cards.entries()) {
    const saved = await customerWithCard(card);
    await db
      .update(users)
      .set({ stripeCustomerId: saved.customerId, defaultPaymentMethodId: saved.paymentMethodId })
      .where(eq(users.id, ids[i] ?? ''));
  }
  return ids;
}

let n = 0;
const authorizeReq = (userId: string, amount = 1_500) => {
  const id = `${run}-${String(++n)}`;
  return {
    idempotencyKey: id,
    userId,
    amount: cents(amount),
    metadata: { bidId: id, auctionId: run },
  };
};

describe.skipIf(!enabled)('Stripe test mode', () => {
  beforeAll(async () => {
    testDb = await freshDb();
    db = testDb.db;
    client = stripeClient(key);
    payments = new StripePayments({ client, customerFor: customerFromUsers(db) });
  });

  afterAll(async () => {
    // Release every hold this run left open (invariant 4 holds in the sandbox too): deleting
    // a Customer doesn't release its holds, they'd sit there for 7 days. The intents stay in
    // the dashboard for inspection.
    for (const customer of customerIds) {
      for await (const intent of client.paymentIntents.list({ customer, limit: 100 })) {
        if (intent.status === 'requires_capture') {
          await client.paymentIntents.cancel(intent.id).catch(() => undefined);
        }
      }
    }
    for (const id of customerIds) await client.customers.del(id).catch(() => undefined);
    await testDb.close();
  });

  describe('adapter contract (the cases the fake asserts)', () => {
    it('places a hold, and the same key replays it instead of placing a second', async () => {
      const [user] = await bidders(['pm_card_visa']);
      const req = authorizeReq(user ?? '');
      const first = await payments.authorize(req);
      expect(first).toMatchObject({
        ok: true,
        status: 'requires_capture',
        amountCapturable: 1_500,
      });
      expect(await payments.authorize(req)).toEqual(first);
      const audit = await stripeAudit(client, customerIds.slice(-1));
      expect(
        [...audit.intents.values()].filter((i) => i.metadata.bidId === req.metadata.bidId),
      ).toHaveLength(1);
    });

    it.each([
      // Saves fine, declines when charged: what a bidder whose card goes bad would hit.
      ['pm_card_chargeCustomerFail', 'generic_decline'],
      ['pm_card_visa_chargeDeclinedInsufficientFunds', 'insufficient_funds'],
      ['pm_card_authenticationRequired', 'authentication_required'],
    ])('refuses %s with %s', async (card, reason) => {
      const [user] = await bidders([card]);
      expect(await payments.authorize(authorizeReq(user ?? ''))).toEqual({ ok: false, reason });
    });

    it('cancels and captures idempotently, judged by the intent', async () => {
      const [user] = await bidders(['pm_card_visa']);
      const a = await payments.authorize(authorizeReq(user ?? ''));
      const b = await payments.authorize(authorizeReq(user ?? ''));
      if (!a.ok || !b.ok) throw new Error('expected holds');
      // A second attempt uses a new key, as the outbox does, so Stripe judges the state.
      expect(await payments.cancel(a.paymentIntentId, { idempotencyKey: `${run}-c1` })).toEqual({
        ok: true,
      });
      expect(await payments.cancel(a.paymentIntentId, { idempotencyKey: `${run}-c2` })).toEqual({
        ok: true,
      });
      const capture = (k: string) =>
        payments.capture(b.paymentIntentId, { amount: 1_500, idempotencyKey: k });
      expect(await capture(`${run}-p1`)).toEqual({ ok: true });
      expect(await capture(`${run}-p2`)).toEqual({ ok: true });
      expect(await payments.cancel(b.paymentIntentId, { idempotencyKey: `${run}-c3` })).toEqual({
        ok: false,
        reason: 'already_captured',
        retryable: false,
      });
      expect((await payments.retrieve(a.paymentIntentId))?.status).toBe('canceled');
      expect((await payments.retrieve(b.paymentIntentId))?.status).toBe('succeeded');
    });

    it('never places two holds for two requests with one key in flight', async () => {
      const [user] = await bidders(['pm_card_visa']);
      const req = authorizeReq(user ?? '');
      const results = await Promise.allSettled([payments.authorize(req), payments.authorize(req)]);
      // Stripe answers the second with a 409, which the SDK retries; it either ends as a
      // replay of the first or surfaces as transient. Either way, one hold.
      const ids = new Set<string>();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.ok) ids.add(r.value.paymentIntentId);
        else if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(TransientPaymentsError);
      }
      expect(ids.size).toBe(1);
      console.log('same key in flight:', results.map((r) => r.status).join(', '));
    });
  });

  describe('bid flow end to end with real holds', () => {
    async function closeAndCheck(auctionId: string) {
      await db
        .update(auctions)
        .set({ endsAt: sql`clock_timestamp()` })
        .where(eq(auctions.id, auctionId));
      await tickLifecycleOnce({ db });
      await settle({ db, payments });
      const violations = await checkInvariants(db, payments, {
        auctionId,
        audit: await stripeAudit(client, customerIds),
        outboxIdle: true,
      });
      expect(violations).toEqual([]);
      const [a] = await db.select().from(auctions).where(eq(auctions.id, auctionId));
      expect(a?.status).toBe('settled');
      const [winner] = await db
        .select()
        .from(bids)
        .where(eq(bids.id, a?.currentHighBidId ?? ''));
      expect((await payments.retrieve(winner?.paymentIntentId ?? ''))?.status).toBe('succeeded');
      return { winner };
    }

    it('a bid war: losers released, the winner captured, zero violations', async () => {
      const [alice, bob, carol] = await bidders([
        'pm_card_visa',
        'pm_card_mastercard',
        'pm_card_chargeCustomerFail',
      ]);
      const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
      const bid = (userId: string, amount: number) =>
        placeBid(
          { db, payments },
          { auctionId: auction.id, userId, amount, idempotencyKey: `${run}-${String(++n)}` },
        );
      const outcomes: Bid[] = [
        await bid(alice ?? '', 1_000),
        await bid(bob ?? '', 1_200),
        await bid(carol ?? '', 1_500), // declined card
        await bid(alice ?? '', 1_100), // below the minimum: refused before any hold
        await bid(alice ?? '', 1_400),
      ];
      expect(outcomes.map((b) => b.status)).toEqual([
        'accepted',
        'accepted',
        'rejected',
        'rejected',
        'accepted',
      ]);
      const { winner } = await closeAndCheck(auction.id);
      expect(winner?.amount).toBe(1_400);
    });

    it('ten near-simultaneous bids: one winner, every losing hold released', async () => {
      const users3 = await bidders(['pm_card_visa', 'pm_card_visa', 'pm_card_mastercard']);
      const auction = await openAuction(db, { startingPrice: 1_000, minIncrement: 100 });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          placeBid(
            { db, payments },
            {
              auctionId: auction.id,
              userId: users3[i % 3] ?? '',
              amount: 1_000 + 100 * (i % 4),
              idempotencyKey: `${run}-burst-${String(i)}`,
            },
          ),
        ),
      );
      console.log('burst outcomes:', results.map((b) => b.status).join(', '));
      expect(results.some((b) => b.status === 'lost_race')).toBe(true);
      await closeAndCheck(auction.id);
    });
  });

  describe('incremental authorization experiment (spec §13 Q2)', () => {
    async function holdWithIncrements(card: string) {
      const saved = await customerWithCard(card);
      return client.paymentIntents.create({
        amount: 1_000,
        currency: 'usd',
        customer: saved.customerId,
        payment_method: saved.paymentMethodId,
        capture_method: 'manual',
        confirm: true,
        off_session: true,
        payment_method_options: { card: { request_incremental_authorization: 'if_available' } },
        expand: ['latest_charge'],
      });
    }

    const availability = (pi: Stripe.PaymentIntent) =>
      (pi.latest_charge as Stripe.Charge | null)?.payment_method_details?.card
        ?.incremental_authorization?.status ?? 'missing';

    it('records what this account can do', async () => {
      const facts: Record<string, unknown> = {};
      let pi: Stripe.PaymentIntent;
      try {
        pi = await holdWithIncrements('pm_card_debit_incrementalAuthAuthorized');
      } catch (e) {
        // On standard pricing Stripe refuses the request outright; that is the answer.
        if (!(e instanceof Stripe.errors.StripeError) || e.statusCode !== 400) throw e;
        facts['eligible'] = false;
        facts['refusal'] = { type: e.type, code: e.code ?? null, message: e.message };
        console.log('incremental authorization:', JSON.stringify(facts, null, 2));
        return;
      }
      facts['eligible'] = true;
      facts['status'] = pi.status;
      facts['availability'] = availability(pi);
      try {
        const grown = await client.paymentIntents.incrementAuthorization(pi.id, { amount: 1_500 });
        facts['increment'] = { status: grown.status, amountCapturable: grown.amount_capturable };
        expect(grown.amount_capturable).toBe(1_500);
      } catch (e) {
        facts['increment'] = { error: (e as Stripe.errors.StripeError).code ?? String(e) };
      }
      await client.paymentIntents.cancel(pi.id);

      const declined = await holdWithIncrements('pm_card_credit_disableEnterpriseCardFeatures');
      facts['declineCard'] = { status: declined.status, availability: availability(declined) };
      try {
        await client.paymentIntents.incrementAuthorization(declined.id, { amount: 1_500 });
        facts['declineCardIncrement'] = 'succeeded';
      } catch (e) {
        facts['declineCardIncrement'] = (e as Stripe.errors.StripeError).code ?? String(e);
        // Stripe documents that a declined increment leaves the original hold capturable.
        const after = await client.paymentIntents.retrieve(declined.id);
        facts['afterDeclinedIncrement'] = {
          status: after.status,
          amountCapturable: after.amount_capturable,
        };
        expect(after.status).toBe('requires_capture');
        expect(after.amount_capturable).toBe(1_000);
      }
      await client.paymentIntents.cancel(declined.id);
      console.log('incremental authorization:', JSON.stringify(facts, null, 2));
    });
  });
});
