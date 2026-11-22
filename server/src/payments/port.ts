// The boundary to the payment provider (ADR 0006). The real Stripe client (slice 3b) and
// the fake both implement it.
import type { Cents } from '@holdfast/shared';

export interface AuthorizeRequest {
  /** The bid id: a retry with the same key must never create a second hold. */
  idempotencyKey: string;
  userId: string;
  amount: Cents;
  metadata: { bidId: string; auctionId: string };
}

export type AuthorizeResult =
  | {
      ok: true;
      paymentIntentId: string;
      status: 'requires_capture';
      amountCapturable: number;
    }
  | { ok: false; reason: string };

/** The result of a cancel or capture. `retryable` says whether trying again may help. */
export type EffectResult = { ok: true } | { ok: false; reason: string; retryable: boolean };

export type PaymentIntentStatus = 'requires_capture' | 'canceled' | 'succeeded';

export interface PaymentIntentView {
  id: string;
  amount: number;
  amountCapturable: number;
  status: PaymentIntentStatus;
  metadata: { bidId: string; auctionId: string };
}

/**
 * A failure that says nothing about the outcome: a timeout, a 5xx, a dropped connection.
 * The hold may or may not exist; the caller leaves the bid pending for the reconciler.
 */
export class TransientPaymentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientPaymentsError';
  }
}

export interface Payments {
  /** Create and confirm a manual-capture PaymentIntent for the full amount. */
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  /** Release a hold. Canceling one that's already canceled succeeds. */
  cancel(paymentIntentId: string, options: { idempotencyKey: string }): Promise<EffectResult>;
  /** Capture a hold for `amount`. Capturing one that's already captured succeeds. */
  capture(
    paymentIntentId: string,
    options: { amount: number; idempotencyKey: string },
  ): Promise<EffectResult>;
  retrieve(paymentIntentId: string): Promise<PaymentIntentView | null>;
}
