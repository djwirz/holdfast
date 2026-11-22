// The Stripe webhook (spec §5): signature checked on the raw body, each event recorded
// once, and a capturable-hold event finishes a bid whose handler died.
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedCrash, placeBid } from '../src/bids/place-bid.ts';
import type { Db } from '../src/db/client.ts';
import { bids, stripeEvents } from '../src/db/schema.ts';
import { FakePayments } from '../src/payments/fake.ts';
import { recordStripeEvent } from '../src/payments/webhook.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, createUsers, freshDb } from './support/db.ts';
import { type TestApp, testApp } from './support/http.ts';

const SECRET = 'whsec_test_not_a_real_secret';

let testDb: TestDb;
let db: Db;
let t: TestApp;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  t = await testApp(db, { stripeWebhook: { secret: SECRET } });
});

afterAll(async () => {
  await t.close();
  await testDb.close();
});

function event(id: string, type: string, metadata: Record<string, string> = {}) {
  return {
    id,
    object: 'event',
    type,
    data: { object: { id: 'pi_x', object: 'payment_intent', metadata } },
  };
}

function signed(body: unknown, secret = SECRET) {
  const payload = JSON.stringify(body);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return {
    method: 'POST' as const,
    url: '/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    payload,
  };
}

describe('POST /stripe/webhook', () => {
  it('refuses a bad signature', async () => {
    const res = await t.app.inject(
      signed(event('evt_1', 'payment_intent.canceled'), 'whsec_wrong'),
    );
    expect(res.statusCode).toBe(400);
  });

  it('records an event once, however often Stripe delivers it', async () => {
    const req = signed(event('evt_dupe', 'payment_intent.canceled'));
    const first = await t.app.inject(req);
    const second = await t.app.inject(req);
    expect(first.json()).toEqual({ received: true, duplicate: false });
    expect(second.json()).toEqual({ received: true, duplicate: true });
    const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, 'evt_dupe'));
    expect(rows).toHaveLength(1);
  });

  it('is unavailable, not open, when no secret is configured', async () => {
    const bare = await testApp(db, { stripeWebhook: null });
    try {
      expect((await bare.app.inject(signed(event('evt_2', 'x')))).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe('recordStripeEvent', () => {
  it('finishes a stranded pending bid when its hold is reported capturable', async () => {
    const [user = ''] = await createUsers(db, 1);
    const payments = new FakePayments();
    const auction = await openAuction(db);
    const crashing = {
      db,
      payments,
      faults: {
        afterAuthorize: () => {
          throw new SimulatedCrash();
        },
      },
    };
    const stranded = await placeBid(crashing, {
      auctionId: auction.id,
      userId: user,
      amount: 2_000,
      idempotencyKey: 'wh-1',
    });
    expect(stranded.status).toBe('pending');

    const capturable = event('evt_cap', 'payment_intent.amount_capturable_updated', {
      bidId: stranded.id,
    }) as unknown as Stripe.Event;
    const result = await recordStripeEvent({ db, payments }, capturable, { staleAfterMs: 0 });
    await result.resumed;
    const [after] = await db.select().from(bids).where(eq(bids.id, stranded.id));
    expect(after?.status).toBe('accepted');
    // Found through the provider's replay of the bid's key, not a second hold.
    expect(payments.intents.size).toBe(1);
  });

  it('leaves a young pending bid to its own handler', async () => {
    const [user = ''] = await createUsers(db, 1);
    const payments = new FakePayments({ latency: () => 200 });
    const auction = await openAuction(db);
    const running = placeBid(
      { db, payments },
      {
        auctionId: auction.id,
        userId: user,
        amount: 2_000,
        idempotencyKey: 'wh-2',
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    const [pending] = await db.select().from(bids).where(eq(bids.idempotencyKey, 'wh-2'));
    const result = await recordStripeEvent(
      { db, payments },
      event('evt_young', 'payment_intent.amount_capturable_updated', {
        bidId: pending?.id ?? '',
      }) as unknown as Stripe.Event,
    );
    expect(result.resumed).toBeUndefined();
    expect((await running).status).toBe('accepted');
  });
});
