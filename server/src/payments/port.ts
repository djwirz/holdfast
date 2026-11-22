// The boundary to the payment provider (ADR 0006). The real Stripe client and the fake
// both implement it. Cancel and capture arrive with the outbox worker in slice 3.
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

export type PaymentIntentStatus = 'requires_capture' | 'canceled' | 'succeeded';

export interface PaymentIntentView {
  id: string;
  amount: number;
  amountCapturable: number;
  status: PaymentIntentStatus;
  metadata: { bidId: string; auctionId: string };
}

export interface Payments {
  /** Create and confirm a manual-capture PaymentIntent for the full amount. */
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  retrieve(paymentIntentId: string): Promise<PaymentIntentView | null>;
}
