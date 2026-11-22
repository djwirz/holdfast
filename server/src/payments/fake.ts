// A stateful in-process stand-in for Stripe's PaymentIntent subset (ADR 0006). Unlike a
// stateless mock, it remembers intents, so the invariant checker can audit every hold.
import { randomUUID } from 'node:crypto';
import type { AuthorizeRequest, AuthorizeResult, Payments, PaymentIntentView } from './port.ts';

export type Decision = { approve: true } | { approve: false; reason: string };

export interface FakePaymentsOptions {
  /** Milliseconds before the authorization returns. Tests use it to force an order. */
  latency?: (req: AuthorizeRequest) => number;
  decide?: (req: AuthorizeRequest) => Decision;
}

export class FakePayments implements Payments {
  readonly intents = new Map<string, PaymentIntentView>();
  /** Authorize calls per idempotency key, including retries. */
  readonly callsByKey = new Map<string, number>();
  private readonly byKey = new Map<string, Promise<AuthorizeResult>>();
  private readonly latency: (req: AuthorizeRequest) => number;
  private readonly decide: (req: AuthorizeRequest) => Decision;

  constructor(options: FakePaymentsOptions = {}) {
    this.latency = options.latency ?? (() => 0);
    this.decide = options.decide ?? (() => ({ approve: true }));
  }

  authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    this.callsByKey.set(req.idempotencyKey, (this.callsByKey.get(req.idempotencyKey) ?? 0) + 1);
    // Like Stripe's idempotency keys: the same key replays the first result.
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return existing;
    const result = this.run(req);
    this.byKey.set(req.idempotencyKey, result);
    return result;
  }

  private async run(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const ms = this.latency(req);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    const decision = this.decide(req);
    if (!decision.approve) return { ok: false, reason: decision.reason };
    // Globally unique, like Stripe's ids: fakes in different tests share one database.
    const id = `pi_fake_${randomUUID().replaceAll('-', '')}`;
    this.intents.set(id, {
      id,
      amount: req.amount,
      amountCapturable: req.amount,
      status: 'requires_capture',
      metadata: req.metadata,
    });
    return {
      ok: true,
      paymentIntentId: id,
      status: 'requires_capture',
      amountCapturable: req.amount,
    };
  }

  retrieve(paymentIntentId: string): Promise<PaymentIntentView | null> {
    const intent = this.intents.get(paymentIntentId);
    return Promise.resolve(intent ? { ...intent } : null);
  }
}

/** mulberry32: a tiny seeded PRNG, so a failing storm can be replayed from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
