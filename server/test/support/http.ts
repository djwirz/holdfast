// Building the real app for tests: same routes, injected fake payments, the shared Redis.
import { type AddressInfo, type Server, type Socket, createServer, connect } from 'node:net';
import type { AuctionEvent } from '@holdfast/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import type { Db } from '../../src/db/client.ts';
import { type AppDeps, buildApp } from '../../src/http/app.ts';
import { LiveHub } from '../../src/live/hub.ts';
import { aliaser } from '../../src/live/read.ts';
import { FakePayments } from '../../src/payments/fake.ts';

export const ORIGIN = 'http://localhost:5173';
export const SECRET = 'test-secret-test-secret-test-secret-00';

export interface TestApp {
  app: FastifyInstance;
  deps: AppDeps;
  close: () => Promise<void>;
}

/** The real app on the given db; Redis optional (null runs the hub on polling alone). */
export async function testApp(
  db: Db,
  overrides: Partial<AppDeps> & { redisUrl?: string | null; pollMs?: number } = {},
): Promise<TestApp> {
  const { redisUrl = null, pollMs = 5_000, ...rest } = overrides;
  const subscriber = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : null;
  const commands = redisUrl
    ? new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
    : null;
  subscriber?.on('error', () => undefined);
  commands?.on('error', () => undefined);
  const alias = aliaser(SECRET);
  const hub = new LiveHub({ db, alias, subscriber, pollMs });
  const deps: AppDeps = {
    db,
    payments: new FakePayments(),
    alias,
    hub,
    appOrigin: ORIGIN,
    cardRequired: false,
    devSignIn: true,
    rateLimitRedis: commands,
    redisStatus: () => commands?.status ?? 'none',
    bidDeadlineMs: 2_000,
    ...rest,
  };
  const app = await buildApp(deps);
  return {
    app,
    deps,
    close: async () => {
      await app.close();
      deps.hub.close();
      subscriber?.disconnect();
      commands?.disconnect();
    },
  };
}

export function redisUrl(): string {
  return inject('redisUrl');
}

/** Signs in through the dev route and returns the cookie header to send. */
export async function signIn(app: FastifyInstance, login: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev',
    headers: { origin: ORIGIN },
    payload: { login },
  });
  if (res.statusCode !== 204) throw new Error(`dev sign-in failed: ${String(res.statusCode)}`);
  const setCookie = res.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!first) throw new Error('no session cookie');
  return first.split(';')[0] ?? '';
}

let keys = 0;
export function bidRequest(cookie: string, auctionId: string, amount: number, key?: string) {
  return {
    method: 'POST' as const,
    url: `/api/auctions/${auctionId}/bids`,
    headers: {
      origin: ORIGIN,
      cookie,
      'idempotency-key': key ?? `http-${String(++keys)}`,
    },
    payload: { amount },
  };
}

export interface SseFrame {
  event: string;
  id: number;
  data: unknown;
}

/**
 * A minimal SSE client over fetch, for tests: collects frames and lets a test wait for
 * the next one matching a predicate. EventSource itself isn't in Node.
 */
export async function openStream(
  baseUrl: string,
  auctionId: string,
  lastEventId?: number,
): Promise<{
  frames: SseFrame[];
  status: number;
  next: (pred: (f: SseFrame) => boolean, timeoutMs?: number) => Promise<SseFrame>;
  close: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/auctions/${auctionId}/events`, {
    signal: controller.signal,
    headers: lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) },
  });
  const frames: SseFrame[] = [];
  const waiters: { pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
  const push = (f: SseFrame) => {
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  };
  if (res.body) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += value;
          let at: number;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const fields = new Map<string, string>();
            for (const line of block.split('\n')) {
              const colon = line.indexOf(':');
              if (colon <= 0) continue; // comments (": keep-alive") and blank lines
              fields.set(line.slice(0, colon), line.slice(colon + 1).trimStart());
            }
            const event = fields.get('event');
            const data = fields.get('data');
            if (event && data !== undefined) {
              push({ event, id: Number(fields.get('id')), data: JSON.parse(data) as unknown });
            }
          }
        }
      } catch {
        // aborted
      }
    })();
  }
  return {
    frames,
    status: res.status,
    next(pred, timeoutMs = 5_000) {
      const found = frames.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`no matching frame in ${String(timeoutMs)}ms; got ${JSON.stringify(frames)}`),
          );
        }, timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
    close: () => {
      controller.abort();
    },
  };
}

export const isEvent =
  (type: AuctionEvent['type'], version?: number) =>
  (f: SseFrame): boolean =>
    f.event === type && (version === undefined || f.id === version);

/**
 * A TCP proxy in front of Redis that a test can cut and restore on the same port: "Redis
 * is down" without restarting a container (which would move its port).
 */
export async function cuttableRedis(target: string): Promise<{
  url: string;
  cut: () => Promise<void>;
  restore: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let listenPort = 0;
  const listen = () =>
    new Promise<void>((resolve) => {
      server = createServer((client) => {
        const upstream = connect(Number(port), hostname);
        sockets.add(client).add(upstream);
        client.pipe(upstream).pipe(client);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', drop).on('close', drop);
        upstream.on('error', drop).on('close', drop);
      });
      server.listen(listenPort, '127.0.0.1', () => {
        listenPort = (server?.address() as AddressInfo).port;
        resolve();
      });
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (server) {
        server.close(() => {
          resolve();
        });
      } else resolve();
      server = null;
    });
  await listen();
  return {
    url: `redis://127.0.0.1:${String(listenPort)}`,
    cut: stop,
    restore: listen,
    close: stop,
  };
}
