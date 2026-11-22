// The Payments port over HTTP to the shared fake (fake-server.ts). Failures map the way the
// Stripe adapter maps them: no answer or a 5xx says nothing about the outcome, so the bid
// stays pending for the reconciler (TransientPaymentsError).
import type { PaymentsAudit } from '../invariants.ts';
import {
  type AuthorizeRequest,
  type AuthorizeResult,
  type EffectResult,
  type PaymentIntentView,
  type Payments,
  TransientPaymentsError,
} from './port.ts';

export class HttpFakePayments implements Payments {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        ...(payload === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new TransientPaymentsError(`fake Stripe unreachable: ${String(e)}`);
    }
    if (res.status >= 500) throw new TransientPaymentsError(`fake Stripe: ${String(res.status)}`);
    return { status: res.status, body: await res.json() };
  }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    return (await this.call('POST', '/authorize', req)).body as AuthorizeResult;
  }

  async cancel(
    paymentIntentId: string,
    options: { idempotencyKey: string },
  ): Promise<EffectResult> {
    try {
      const { body } = await this.call('POST', '/cancel', { paymentIntentId, ...options });
      return body as EffectResult;
    } catch (e) {
      if (e instanceof TransientPaymentsError)
        return { ok: false, reason: e.message, retryable: true };
      throw e;
    }
  }

  async capture(
    paymentIntentId: string,
    options: { amount: number; idempotencyKey: string },
  ): Promise<EffectResult> {
    try {
      const { body } = await this.call('POST', '/capture', { paymentIntentId, ...options });
      return body as EffectResult;
    } catch (e) {
      if (e instanceof TransientPaymentsError)
        return { ok: false, reason: e.message, retryable: true };
      throw e;
    }
  }

  async retrieve(paymentIntentId: string): Promise<PaymentIntentView | null> {
    const { status, body } = await this.call(
      'GET',
      `/intents/${encodeURIComponent(paymentIntentId)}`,
    );
    return status === 404 ? null : (body as PaymentIntentView);
  }

  /** Every intent the fake holds, for the invariant checker. */
  async audit(): Promise<PaymentsAudit> {
    const { body } = await this.call('GET', '/audit');
    const { intents } = body as { intents: PaymentIntentView[] };
    return { intents: new Map(intents.map((i) => [i.id, i])) };
  }
}
