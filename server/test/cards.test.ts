// Card setup (spec §5): the server saves a card only after checking Stripe's own record of
// the SetupIntent, never on the client's word. Stripe is stubbed; the live E2E project
// runs the same flow against test mode.
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import { stripeCards } from '../src/payments/cards.ts';
import { openAuction } from './support/auctions.ts';
import { type TestDb, freshDb } from './support/db.ts';
import { ORIGIN, type TestApp, signIn, testApp } from './support/http.ts';

let testDb: TestDb;
let db: Db;
let t: TestApp;
let intents: Map<string, Partial<Stripe.SetupIntent>>;
let customersCreated: number;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  intents = new Map();
  customersCreated = 0;
  const client = {
    customers: {
      create: () => Promise.resolve({ id: `cus_${String(++customersCreated)}` }),
    },
    setupIntents: {
      create: (params: { customer: string }) => {
        const id = `seti_${String(intents.size + 1)}`;
        intents.set(id, { id, customer: params.customer, status: 'requires_payment_method' });
        return Promise.resolve({ id, client_secret: `${id}_secret_x` });
      },
      retrieve: (id: string) => Promise.resolve(intents.get(id) ?? {}),
    },
  } as unknown as Parameters<typeof stripeCards>[1];
  t = await testApp(db, {
    cardRequired: true,
    cards: stripeCards(db, client),
    stripePublishableKey: 'pk_test_stub',
  });
});

afterAll(async () => {
  await t.close();
  await testDb.close();
});

const post = (cookie: string, url: string, payload?: Record<string, string | undefined>) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, cookie },
    ...(payload === undefined ? {} : { payload }),
  });

async function userId(login: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.login, `dev-${login}`));
  return row;
}

describe('card setup', () => {
  it('creates one Customer and saves the card once Stripe says the setup succeeded', async () => {
    const cookie = await signIn(t.app, 'carder');
    const start = await post(cookie, '/api/me/card/setup');
    expect(start.json()).toEqual({ clientSecret: 'seti_1_secret_x' });
    await post(cookie, '/api/me/card/setup'); // a second tab: same Customer
    expect((await userId('carder'))?.stripeCustomerId).toBe('cus_1');
    expect(customersCreated).toBe(1);

    // Not finished yet: refused.
    expect((await post(cookie, '/api/me/card', { setupIntentId: 'seti_1' })).statusCode).toBe(422);

    intents.set('seti_1', {
      ...intents.get('seti_1'),
      status: 'succeeded',
      payment_method: 'pm_1',
    });
    const done = await post(cookie, '/api/me/card', { setupIntentId: 'seti_1' });
    expect(done.json()).toEqual({ hasCard: true });
    expect((await userId('carder'))?.defaultPaymentMethodId).toBe('pm_1');
    const me = await t.app.inject({ url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ hasCard: true, cardRequired: true });
  });

  it("refuses someone else's finished setup", async () => {
    const owner = await signIn(t.app, 'owner');
    await post(owner, '/api/me/card/setup');
    const [id] = [...intents.keys()].slice(-1);
    intents.set(id ?? '', {
      ...intents.get(id ?? ''),
      status: 'succeeded',
      payment_method: 'pm_x',
    });

    const thief = await signIn(t.app, 'thief');
    await post(thief, '/api/me/card/setup');
    const res = await post(thief, '/api/me/card', { setupIntentId: id });
    expect(res.statusCode).toBe(422);
    expect((await userId('thief'))?.defaultPaymentMethodId).toBeNull();
  });

  it('needs a session and a well-formed setup intent id', async () => {
    expect((await post('', '/api/me/card/setup')).statusCode).toBe(401);
    const cookie = await signIn(t.app, 'shape');
    expect((await post(cookie, '/api/me/card', { setupIntentId: 'pi_nope' })).statusCode).toBe(400);
  });
});

describe('config and the auction list', () => {
  it('tells the page which steps exist, with a publishable key only for real Stripe', async () => {
    expect((await t.app.inject({ url: '/api/config' })).json()).toEqual({
      githubSignIn: false,
      devSignIn: true,
      cardRequired: true,
      stripePublishableKey: 'pk_test_stub',
    });
    const fake = await testApp(db, { stripePublishableKey: 'pk_test_stub' });
    try {
      expect((await fake.app.inject({ url: '/api/config' })).json()).toMatchObject({
        cardRequired: false,
        stripePublishableKey: null,
      });
      // With the fake there's no card to set up.
      const cookie = await signIn(fake.app, 'nocard');
      const res = await fake.app.inject({
        method: 'POST',
        url: '/api/me/card/setup',
        headers: { origin: ORIGIN, cookie },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fake.close();
    }
  });

  it('lists live auctions with their current price', async () => {
    const auction = await openAuction(db, { startingPrice: 1_000 });
    const res = await t.app.inject({ url: '/api/auctions' });
    const list = res.json<{
      auctions: { id: string; status: string; currentHigh: number | null }[];
    }>();
    expect(list.auctions.find((a) => a.id === auction.id)).toMatchObject({
      status: 'open',
      currentHigh: null,
    });
  });
});
