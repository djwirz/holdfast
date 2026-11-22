/** Money is integer cents everywhere (spec §4). The brand stops a raw number slipping through. */
export type Cents = number & { readonly __brand: 'Cents' };

/** A sane ceiling for a demo bid: ten million dollars. Stops overflow and typos. */
export const MAX_CENTS = 1_000_000_000;

export function isCents(n: unknown): n is Cents {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= MAX_CENTS;
}

export function cents(n: number): Cents {
  if (!isCents(n)) throw new RangeError(`not a valid amount in cents: ${String(n)}`);
  return n;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(amount: Cents): string {
  return usd.format(amount / 100);
}
