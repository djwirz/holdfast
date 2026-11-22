// Sign-in and sessions (spec §9): GitHub OAuth against a stand-in GitHub, the dev route's
// guard, cookie flags, expiry and logout, and that only a hash of the token is stored.
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { sessions, users } from '../src/db/schema.ts';
import type { GitHub } from '../src/http/github.ts';
import { type TestDb, freshDb } from './support/db.ts';
import { ORIGIN, type TestApp, signIn, testApp } from './support/http.ts';

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

const fakeGitHub = (user = { id: 4242, login: 'octo' }): GitHub => ({
  authorizeUrl: (state, redirectUri) =>
    `https://github.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: (code) =>
    code === 'good' ? Promise.resolve('gho_token') : Promise.reject(new Error('bad code')),
  user: () => Promise.resolve(user),
});

async function withApp<T>(
  overrides: Parameters<typeof testApp>[1],
  fn: (t: TestApp) => Promise<T>,
) {
  const t = await testApp(db, overrides);
  try {
    return await fn(t);
  } finally {
    await t.close();
  }
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return all.find((c) => c.startsWith(`${name}=`));
}

describe('GitHub sign-in', () => {
  it('redirects with a state, then signs in on a matching callback', async () => {
    await withApp({ github: fakeGitHub() }, async ({ app }) => {
      const start = await app.inject({ url: '/api/auth/github' });
      expect(start.statusCode).toBe(302);
      const state = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
      expect(new URL(start.headers.location ?? '').searchParams.get('redirect_uri')).toBe(
        `${ORIGIN}/api/auth/github/callback`,
      );
      const stateCookie = cookieValue(start.headers['set-cookie'], 'holdfast_oauth_state') ?? '';
      expect(stateCookie).toMatch(/HttpOnly/);

      const back = await app.inject({
        url: `/api/auth/github/callback?code=good&state=${state}`,
        headers: { cookie: stateCookie.split(';')[0] ?? '' },
      });
      expect(back.statusCode).toBe(302);
      const session = cookieValue(back.headers['set-cookie'], 'holdfast_session') ?? '';
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/SameSite=Lax/);

      const me = await app.inject({
        url: '/api/me',
        headers: { cookie: session.split(';')[0] ?? '' },
      });
      expect(me.json()).toMatchObject({ user: { login: 'octo' } });
      const [row] = await db.select().from(users).where(eq(users.githubId, 4242));
      expect(row?.login).toBe('octo');
    });
  });

  it('refuses a callback whose state does not match', async () => {
    await withApp({ github: fakeGitHub() }, async ({ app }) => {
      const res = await app.inject({
        url: '/api/auth/github/callback?code=good&state=forged',
        headers: { cookie: 'holdfast_oauth_state=real' },
      });
      expect(res.statusCode).toBe(400);
      expect(cookieValue(res.headers['set-cookie'], 'holdfast_session')).toBeUndefined();
    });
  });

  it('sends a bidder who declined consent back to the page, signed out', async () => {
    await withApp({ github: fakeGitHub() }, async ({ app }) => {
      const res = await app.inject({
        url: '/api/auth/github/callback?error=access_denied&state=x',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/?signin=denied');
    });
  });

  it('has no GitHub routes when the app isn’t configured', async () => {
    await withApp({ github: null }, async ({ app }) => {
      expect((await app.inject({ url: '/api/auth/github' })).statusCode).toBe(404);
    });
  });
});

describe('dev sign-in', () => {
  it('does not exist without the flag', async () => {
    await withApp({ devSignIn: false }, async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/dev',
        headers: { origin: ORIGIN },
        payload: { login: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('gives dev users negative GitHub ids, which real accounts never have', async () => {
    await withApp({}, async ({ app }) => {
      await signIn(app, 'neg');
      const [row] = await db.select().from(users).where(eq(users.login, 'dev-neg'));
      expect(row?.githubId).toBeLessThan(0);
    });
  });
});

describe('sessions', () => {
  it('stores only a hash of the token', async () => {
    await withApp({}, async ({ app }) => {
      const cookie = await signIn(app, 'hashy');
      const token = cookie.split('=')[1] ?? '';
      const ids = (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id);
      expect(ids).not.toContain(token);
      expect(ids).toContain(createHash('sha256').update(token).digest('hex'));
    });
  });

  it('ends at expiry and at logout', async () => {
    await withApp({}, async ({ app }) => {
      const cookie = await signIn(app, 'expiry');
      const me = () => app.inject({ url: '/api/me', headers: { cookie } });
      expect((await me()).statusCode).toBe(200);
      await db.update(sessions).set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
      expect((await me()).statusCode).toBe(401);

      const fresh = await signIn(app, 'logout');
      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: ORIGIN, cookie: fresh },
      });
      expect(out.statusCode).toBe(204);
      expect((await app.inject({ url: '/api/me', headers: { cookie: fresh } })).statusCode).toBe(
        401,
      );
    });
  });

  it('refuses a sign-out from another origin', async () => {
    await withApp({}, async ({ app }) => {
      const cookie = await signIn(app, 'csrf');
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: 'https://evil.example', cookie },
      });
      expect(res.statusCode).toBe(403);
      expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    });
  });
});
