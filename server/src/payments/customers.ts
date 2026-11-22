// Where a bidder's Stripe Customer and saved card come from: the users table. Card setup
// (slice 4) fills these in; until then, the live suite does.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { SavedCard } from './stripe.ts';

export function customerFromUsers(db: Db): (userId: string) => Promise<SavedCard | null> {
  return async (userId) => {
    const [row] = await db
      .select({
        customerId: users.stripeCustomerId,
        paymentMethodId: users.defaultPaymentMethodId,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!row?.customerId || !row.paymentMethodId) return null;
    return { customerId: row.customerId, paymentMethodId: row.paymentMethodId };
  };
}
