// One Stripe fake that every server instance shares, over HTTP (ADR 0006). With a fake per
// process, a hold placed on instance A was unknown to instance B, so a cancel run there
// failed as not_found and left the hold open: invariant 4, broken by the test setup itself.
// Real Stripe is one service; so is this. Development, tests and load only.
//
//   node src/payments/fake-server.ts        (FAKE_PORT, default 4010; FAKE_* knobs below)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Decision, FakePayments } from './fake.ts';
import { type AuthorizeRequest, TransientPaymentsError } from './port.ts';

/** Fault and latency settings, from env, with the storm's knobs (server/test/concurrency.test.ts). */
export function fakeFromEnv(env: NodeJS.ProcessEnv = process.env): FakePayments {
  const [min = 0, max = min] = (env['FAKE_LATENCY_MS'] ?? '0').split('-').map((n) => Number(n));
  const rate = (name: string) => Number(env[name] ?? 0);
  const declineRate = rate('FAKE_DECLINE_RATE');
  const lostRate = rate('FAKE_LOST_RESPONSE_RATE');
  const serverErrorEvery = rate('FAKE_SERVER_ERROR_EVERY');
  const cancelFaultRate = rate('FAKE_CANCEL_FAULT_RATE');
  let authorizations = 0;
  return new FakePayments({
    latency: () => Math.floor(min + Math.random() * (max - min)),
    decide: (): Decision => {
      if (serverErrorEvery > 0 && ++authorizations % serverErrorEvery === 0) {
        return { error: 'server_error', created: Math.random() < 0.5 };
      }
      const r = Math.random();
      if (r < declineRate) return { approve: false, reason: 'card_declined' };
      if (r < declineRate + lostRate) return { error: 'after_authorize' };
      return { approve: true };
    },
    effectFault: (op) =>
      op === 'cancel' && Math.random() < cancelFaultRate
        ? { retryable: true, reason: 'rate_limited' }
        : undefined,
  });
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

/** Writes a JSON response; returns true so a route can `return send(...)`. */
function send(res: ServerResponse, status: number, payload: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
  return true;
}

export function fakeStripeServer(fake: FakePayments): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    void (async () => {
      try {
        if (route === 'POST /authorize') {
          // A transient error (timeout, lost response, 409 for a key in flight) is a 503,
          // which the client maps back to TransientPaymentsError, as the Stripe adapter does.
          return send(res, 200, await fake.authorize(await body<AuthorizeRequest>(req)));
        }
        if (route === 'POST /cancel') {
          const b = await body<{ paymentIntentId: string; idempotencyKey: string }>(req);
          return send(
            res,
            200,
            await fake.cancel(b.paymentIntentId, { idempotencyKey: b.idempotencyKey }),
          );
        }
        if (route === 'POST /capture') {
          const b = await body<{ paymentIntentId: string; amount: number; idempotencyKey: string }>(
            req,
          );
          return send(
            res,
            200,
            await fake.capture(b.paymentIntentId, {
              amount: b.amount,
              idempotencyKey: b.idempotencyKey,
            }),
          );
        }
        if (req.method === 'GET' && url.pathname.startsWith('/intents/')) {
          const intent = await fake.retrieve(
            decodeURIComponent(url.pathname.slice('/intents/'.length)),
          );
          return intent ? send(res, 200, intent) : send(res, 404, { error: 'not_found' });
        }
        if (route === 'GET /audit') return send(res, 200, { intents: [...fake.intents.values()] });
        if (route === 'GET /healthz') return send(res, 200, { ok: true });
        return send(res, 404, { error: 'not_found' });
      } catch (e) {
        if (e instanceof TransientPaymentsError)
          return send(res, 503, { error: 'transient', message: e.message });
        return send(res, 500, { error: 'internal', message: String(e) });
      }
    })();
  });
}

export async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  return (server.address() as AddressInfo).port;
}

if (import.meta.main) {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('the Stripe fake never runs in production');
    process.exit(1);
  }
  const port = await listen(
    fakeStripeServer(fakeFromEnv()),
    Number(process.env['FAKE_PORT'] ?? 4010),
  );
  console.log(`fake Stripe on :${String(port)}`);
}
