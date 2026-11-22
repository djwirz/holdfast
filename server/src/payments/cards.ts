// Card setup (spec §5): a SetupIntent saves a card to the bidder's Stripe Customer for
// off-session holds. Card details go from the browser to Stripe through Elements and never
// reach this server; the server only checks Stripe's record of what was saved.
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';

export interface Cards {
  /** Starts card setup; returns the client secret Elements needs. */
  startSetup(userId: string): Promise<{ clientSecret: string }>;
  /**
   * Saves the card from a finished SetupIntent, after checking with Stripe that it
   * succeeded and belongs to this user. The client's word alone is never enough.
   */
  finishSetup(userId: string, setupIntentId: string): Promise<'saved' | 'refused'>;
}

type SetupClient = {
  customers: Pick<Stripe['customers'], 'create'>;
  setupIntents: Pick<Stripe['setupIntents'], 'create' | 'retrieve'>;
};

export function stripeCards(db: Db, client: SetupClient): Cards {
  async function customerFor(userId: string): Promise<string> {
    const [user] = await db
      .select({ customer: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId));
    if (user?.customer) return user.customer;
    // Keyed by user, so two tabs starting setup at once make one Customer, not two.
    const customer = await client.customers.create(
      { metadata: { holdfastUserId: userId } },
      { idempotencyKey: `customer:${userId}` },
    );
    await db.update(users).set({ stripeCustomerId: customer.id }).where(eq(users.id, userId));
    return customer.id;
  }

  return {
    async startSetup(userId) {
      const customer = await customerFor(userId);
      const intent = await client.setupIntents.create({
        customer,
        usage: 'off_session',
        // This API version has no payment_method_types here. Methods that redirect away
        // can't be confirmed off-session later, so they're excluded.
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { holdfastUserId: userId },
      });
      if (!intent.client_secret) throw new Error('setup intent has no client secret');
      return { clientSecret: intent.client_secret };
    },

    async finishSetup(userId, setupIntentId) {
      const [user] = await db
        .select({ customer: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId));
      if (!user?.customer) return 'refused';
      const intent = await client.setupIntents.retrieve(setupIntentId);
      const customer = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
      const pm =
        typeof intent.payment_method === 'string'
          ? intent.payment_method
          : intent.payment_method?.id;
      if (intent.status !== 'succeeded' || customer !== user.customer || !pm) return 'refused';
      await db.update(users).set({ defaultPaymentMethodId: pm }).where(eq(users.id, userId));
      return 'saved';
    },
  };
}
