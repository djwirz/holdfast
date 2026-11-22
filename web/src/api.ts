// The page's calls to the server (spec §6). Same origin, so the session cookie and the
// Origin header the server checks come with every request on their own.
import type { AuctionSnapshot, AuctionStatus } from '@holdfast/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', ...init });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText);
  }
  return body as T;
}

const json = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});

export interface Config {
  githubSignIn: boolean;
  devSignIn: boolean;
  cardRequired: boolean;
  stripePublishableKey: string | null;
}

export interface Me {
  user: { login: string };
  hasCard: boolean;
  cardRequired: boolean;
}

export interface AuctionSummary {
  id: string;
  title: string;
  status: AuctionStatus;
  endsAt: string;
  currentHigh: number | null;
}

export interface OwnBid {
  id: string;
  auctionId: string;
  amount: number;
  status: string;
  reason: string | null;
}

export const api = {
  config: () => call<Config>('GET', '/config'),
  me: async (): Promise<Me | null> => {
    try {
      return await call<Me>('GET', '/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  devSignIn: (login: string) => call<undefined>('POST', '/auth/dev', json({ login })),
  signOut: () => call<undefined>('POST', '/auth/logout'),
  auctions: () => call<{ auctions: AuctionSummary[] }>('GET', '/auctions'),
  auction: (id: string) => call<AuctionSnapshot>('GET', `/auctions/${id}`),
  /** The key must stay the same across retries of one bid (invariant 5). */
  bid: (auctionId: string, amount: number, idempotencyKey: string) =>
    call<{ bid: OwnBid }>(
      'POST',
      `/auctions/${auctionId}/bids`,
      json({ amount }, { 'idempotency-key': idempotencyKey }),
    ),
  ownBid: (id: string) => call<{ bid: OwnBid }>('GET', `/bids/${id}`),
  startCardSetup: () => call<{ clientSecret: string }>('POST', '/me/card/setup'),
  finishCardSetup: (setupIntentId: string) =>
    call<{ hasCard: true }>('POST', '/me/card', json({ setupIntentId })),
};
