// The HTTP API (spec §6) on Fastify (ADR 0005). Everything it needs is passed in, so tests
// build the same app against Testcontainers, two instances at once for the fan-out test.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { BidRequestSchema } from '@holdfast/shared';
import { and, eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import Stripe from 'stripe';
import { z } from 'zod';
import {
  AuctionNotFoundError,
  type Bid,
  IdempotencyConflictError,
  type PlaceBidDeps,
  placeBid,
} from '../bids/place-bid.ts';
import { auctions, bids, users } from '../db/schema.ts';
import type { LiveHub } from '../live/hub.ts';
import { type Aliaser, snapshot } from '../live/read.ts';
import { streamAuction } from '../live/sse.ts';
import type { Cards } from '../payments/cards.ts';
import { recordStripeEvent } from '../payments/webhook.ts';
import type { GitHub } from './github.ts';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionUser,
  createSession,
  deleteSession,
  devGithubId,
  upsertUser,
  userForSession,
} from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AppDeps extends PlaceBidDeps {
  hub: LiveHub;
  alias: Aliaser;
  appOrigin: string;
  /** Whether bids need a saved card (real Stripe) or not (the fake). */
  cardRequired: boolean;
  /** For rate limits; null keeps them in memory (tests, or no Redis). */
  rateLimitRedis?: Redis | null;
  /** For /healthz: the instance's Redis connection status. */
  redisStatus?: () => string;
  github?: GitHub | null;
  devSignIn?: boolean;
  stripeWebhook?: { secret: string } | null;
  /** Card setup through Stripe; null with the fake, which needs no card. */
  cards?: Cards | null;
  /** Sent to the page for Elements; only in real-Stripe mode. */
  stripePublishableKey?: string | null;
  /** How long a bid request waits before answering 202 pending (spec §6). */
  bidDeadlineMs?: number;
  /**
   * The built page (web/dist) to serve from this same origin, so the session cookie and the
   * origin check need nothing extra (spec §9). Unset locally, where Vite serves the page.
   */
  webDist?: string | null;
  rateLimits?: { bids: { max: number; windowMs: number }; auth: { max: number; windowMs: number } };
  logger?: boolean;
}

const UuidSchema = z.uuid();
const IdempotencyKeySchema = z.string().min(1).max(100);
const FinishSetupSchema = z.strictObject({
  setupIntentId: z.string().regex(/^seti_[A-Za-z0-9]+$/),
});
const DevSignInSchema = z.strictObject({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) });

/** The one error shape clients see. Nothing internal leaks through it. */
function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/** A bid as its own bidder sees it: the reason is theirs to know, nobody else's. */
function ownBid(b: Bid) {
  return {
    id: b.id,
    auctionId: b.auctionId,
    amount: b.amount,
    status: b.status,
    reason: b.reason,
    createdAt: b.createdAt.toISOString(),
    resolvedAt: b.resolvedAt?.toISOString() ?? null,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  const secureCookies = deps.appOrigin.startsWith('https://');
  const limits = deps.rateLimits ?? {
    bids: { max: 10, windowMs: 10_000 },
    auth: { max: 20, windowMs: 60_000 },
  };
  const streams = new Set<ServerResponse>();

  await app.register(cookie);
  // Limits are a courtesy, not a guard on correctness: if Redis is down they're skipped
  // rather than blocking bids, which still commit (spec §7).
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    skipOnError: true,
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis, nameSpace: 'holdfast-rl:' } : {}),
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    // State changes only from our own origin (spec §9). Stripe's webhook is signed instead.
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.url !== '/api/stripe/webhook' &&
      request.headers.origin !== deps.appOrigin
    ) {
      return fail(reply, 403, 'forbidden', 'cross-origin request refused');
    }
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await userForSession(deps.db, token) : null;
    return undefined;
  });

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return fail(reply, 500, 'internal', 'something went wrong');
    }
    return fail(reply, status, 'bad_request', status === 429 ? 'too many requests' : 'bad request');
  });
  const webDist = deps.webDist;
  if (webDist && !existsSync(`${webDist}/index.html`)) {
    // Fail the start, so the host's health check keeps the previous deploy serving.
    throw new Error(`WEB_DIST has no index.html: ${webDist}`);
  }
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: true,
      index: 'index.html',
      setHeaders(res, path) {
        // Vite fingerprints everything under assets/, so those never change; the page itself
        // must be re-fetched so a deploy takes effect at once.
        res.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    // Page routes such as /auctions/:id are the page's to handle: send it the app shell.
    // Anything under /api stays a JSON 404.
    if (
      webDist &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.url.startsWith('/api/') &&
      (request.headers.accept ?? '').includes('text/html')
    ) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return fail(reply, 404, 'not_found', 'not found');
  });

  const startSession = async (reply: FastifyReply, userId: string) => {
    const token = await createSession(deps.db, userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: SESSION_TTL_MS / 1000,
    });
  };
  const authLimit = {
    rateLimit: { max: limits.auth.max, timeWindow: limits.auth.windowMs },
  };

  // --- Health -----------------------------------------------------------------------
  app.get('/api/healthz', async (_request, reply) => {
    await deps.db.execute(sql`select 1`);
    // Redis down is reported, not fatal: bids still commit without it.
    return reply.send({ ok: true, redis: deps.redisStatus?.() ?? 'none' });
  });

  // --- Sign-in (spec §9) ------------------------------------------------------------
  const github = deps.github;
  if (github) {
    const redirectUri = `${deps.appOrigin}/api/auth/github/callback`;
    app.get('/api/auth/github', { config: authLimit }, async (_request, reply) => {
      const state = randomBytes(16).toString('base64url');
      reply.setCookie('holdfast_oauth_state', state, {
        path: '/api/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: 600,
      });
      return reply.redirect(github.authorizeUrl(state, redirectUri));
    });
    app.get('/api/auth/github/callback', { config: authLimit }, async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;
      const expected = request.cookies['holdfast_oauth_state'];
      reply.clearCookie('holdfast_oauth_state', { path: '/api/auth' });
      if (q['error']) return reply.redirect('/?signin=denied');
      if (!q['code'] || !q['state'] || !expected || q['state'] !== expected) {
        return fail(reply, 400, 'bad_state', 'sign-in expired or was tampered with; try again');
      }
      const token = await github.exchangeCode(q['code'], redirectUri);
      const ghUser = await github.user(token);
      await startSession(reply, await upsertUser(deps.db, ghUser.id, ghUser.login));
      return reply.redirect('/');
    });
  }

  if (deps.devSignIn) {
    // Development and tests only; config refuses DEV_SIGN_IN in production, and without
    // the flag this route doesn't exist.
    app.post('/api/auth/dev', { config: authLimit }, async (request, reply) => {
      const body = DevSignInSchema.safeParse(request.body);
      if (!body.success)
        return fail(reply, 400, 'bad_request', 'login must be 1-39 of A-Z, 0-9, -');
      const login = `dev-${body.data.login}`;
      await startSession(reply, await upsertUser(deps.db, devGithubId(login), login));
      return reply.code(204).send();
    });
  }

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(deps.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', async (request, reply) => {
    if (!request.user) return fail(reply, 401, 'unauthenticated', 'sign in first');
    const [row] = await deps.db
      .select({ customer: users.stripeCustomerId, card: users.defaultPaymentMethodId })
      .from(users)
      .where(eq(users.id, request.user.id));
    return reply.send({
      user: { login: request.user.login },
      hasCard: Boolean(row?.customer && row.card),
      cardRequired: deps.cardRequired,
    });
  });

  // What the page needs to know before anyone signs in: which sign-in and card steps exist.
  app.get('/api/config', async (_request, reply) =>
    reply.send({
      githubSignIn: Boolean(deps.github),
      devSignIn: Boolean(deps.devSignIn),
      cardRequired: deps.cardRequired,
      stripePublishableKey: deps.cardRequired ? (deps.stripePublishableKey ?? null) : null,
    }),
  );

  // --- Card setup (spec §5) ---------------------------------------------------------
  const cards = deps.cards;
  if (cards) {
    app.post('/api/me/card/setup', async (request, reply) => {
      if (!request.user) return fail(reply, 401, 'unauthenticated', 'sign in first');
      return reply.send(await cards.startSetup(request.user.id));
    });
    app.post('/api/me/card', async (request, reply) => {
      if (!request.user) return fail(reply, 401, 'unauthenticated', 'sign in first');
      const body = FinishSetupSchema.safeParse(request.body);
      if (!body.success) return fail(reply, 400, 'bad_request', 'a setupIntentId is required');
      const outcome = await cards.finishSetup(request.user.id, body.data.setupIntentId);
      if (outcome === 'refused') {
        return fail(
          reply,
          422,
          'card_not_saved',
          'that card setup did not finish for this account',
        );
      }
      return reply.send({ hasCard: true });
    });
  }

  // --- Auctions and bids (spec §6) --------------------------------------------------
  app.get('/api/auctions', async (_request, reply) => {
    // Live and upcoming auctions, and ones that ended in the last day.
    const rows = await deps.db
      .select({
        id: auctions.id,
        title: auctions.title,
        status: auctions.status,
        endsAt: auctions.endsAt,
        currentHigh: bids.amount,
      })
      .from(auctions)
      .leftJoin(bids, eq(bids.id, auctions.currentHighBidId))
      .where(sql`${auctions.endsAt} > clock_timestamp() - interval '1 day'`)
      .orderBy(sql`${auctions.endsAt} desc`)
      .limit(50);
    return reply.send({
      auctions: rows.map((r) => ({ ...r, endsAt: r.endsAt.toISOString() })),
    });
  });

  app.get('/api/auctions/:id', async (request, reply) => {
    const id = UuidSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return fail(reply, 404, 'not_found', 'no such auction');
    const snap = await snapshot(deps.db, deps.alias, id.data, request.user?.id ?? null);
    if (!snap) return fail(reply, 404, 'not_found', 'no such auction');
    return reply.send(snap);
  });

  app.get('/api/auctions/:id/events', async (request, reply) => {
    const id = UuidSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return fail(reply, 404, 'not_found', 'no such auction');
    const header = request.headers['last-event-id'];
    const parsed = typeof header === 'string' ? Number(header) : Number.NaN;
    const lastEventId = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;

    reply.hijack();
    const raw = reply.raw;
    // An object, so lint sees the write from the sink's closure.
    const state = { started: false };
    const found = await streamAuction(
      {
        write(chunk) {
          if (!state.started) {
            state.started = true;
            streams.add(raw);
            raw.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              // Proxies must not buffer the stream.
              'x-accel-buffering': 'no',
            });
          }
          raw.write(chunk);
        },
        onClose(fn) {
          request.raw.on('close', () => {
            streams.delete(raw);
            fn();
          });
        },
      },
      {
        db: deps.db,
        alias: deps.alias,
        hub: deps.hub,
        auctionId: id.data,
        viewerId: request.user?.id ?? null,
        lastEventId,
      },
    );
    if (!found && !state.started) {
      raw.writeHead(404, { 'content-type': 'application/json' });
      raw.end(JSON.stringify({ error: 'not_found', message: 'no such auction' }));
    }
  });

  app.post(
    '/api/auctions/:id/bids',
    {
      config: {
        rateLimit: {
          max: limits.bids.max,
          timeWindow: limits.bids.windowMs,
          keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      if (!request.user) return fail(reply, 401, 'unauthenticated', 'sign in to bid');
      const id = UuidSchema.safeParse((request.params as { id: string }).id);
      if (!id.success) return fail(reply, 404, 'not_found', 'no such auction');
      const key = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!key.success) {
        return fail(
          reply,
          400,
          'bad_request',
          'an Idempotency-Key header (1-100 chars) is required',
        );
      }
      const body = BidRequestSchema.safeParse(request.body);
      if (!body.success) {
        return fail(reply, 400, 'bad_request', 'amount must be a positive whole number of cents');
      }
      try {
        const bid = await placeBid(
          deps,
          {
            auctionId: id.data,
            userId: request.user.id,
            amount: body.data.amount,
            idempotencyKey: key.data,
          },
          { deadlineMs: deps.bidDeadlineMs ?? 8_000 },
        );
        return await reply.code(bid.status === 'pending' ? 202 : 201).send({ bid: ownBid(bid) });
      } catch (e) {
        if (e instanceof AuctionNotFoundError)
          return fail(reply, 404, 'not_found', 'no such auction');
        if (e instanceof IdempotencyConflictError) {
          return fail(
            reply,
            422,
            'idempotency_conflict',
            'this Idempotency-Key was already used for a different bid',
          );
        }
        throw e;
      }
    },
  );

  app.get('/api/bids/:id', async (request, reply) => {
    if (!request.user) return fail(reply, 401, 'unauthenticated', 'sign in first');
    const id = UuidSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return fail(reply, 404, 'not_found', 'no such bid');
    // Someone else's bid is "not found", so its existence isn't confirmed either.
    const [bid] = await deps.db
      .select()
      .from(bids)
      .where(and(eq(bids.id, id.data), eq(bids.userId, request.user.id)));
    if (!bid) return fail(reply, 404, 'not_found', 'no such bid');
    return reply.send({ bid: ownBid(bid) });
  });

  // --- Stripe webhook (spec §5) -----------------------------------------------------
  const webhook = deps.stripeWebhook;
  await app.register((scope, _options, done) => {
    // The signature covers the exact bytes, so this route parses nothing itself.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    scope.post('/api/stripe/webhook', async (request, reply) => {
      if (!webhook) return fail(reply, 503, 'unavailable', 'webhooks are not configured');
      const signature = request.headers['stripe-signature'];
      let event: Stripe.Event;
      try {
        event = Stripe.webhooks.constructEvent(
          request.body as Buffer,
          typeof signature === 'string' ? signature : '',
          webhook.secret,
        );
      } catch {
        return fail(reply, 400, 'bad_signature', 'signature check failed');
      }
      const result = await recordStripeEvent(deps, event);
      return reply.send({ received: true, duplicate: result.duplicate });
    });
    done();
  });

  // preClose, not onClose: close() waits for open requests, and an SSE stream never ends
  // on its own, so ending them after close would never happen. Clients reconnect elsewhere.
  app.addHook('preClose', () => {
    for (const raw of streams) raw.end();
    streams.clear();
  });

  return app;
}
