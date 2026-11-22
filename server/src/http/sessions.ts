// Sessions (spec §9). The cookie carries 32 random bytes; the table stores only their
// SHA-256, so a copy of the database can't be replayed as a sign-in.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_COOKIE = 'holdfast_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  login: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    id: hash(token),
    userId,
    expiresAt: sql`clock_timestamp() + make_interval(secs => ${SESSION_TTL_MS / 1000})`,
  });
  return token;
}

export async function userForSession(db: Db, token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hash(token)), gt(sessions.expiresAt, sql`clock_timestamp()`)));
  return row ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hash(token)));
}

/** Insert or refresh a user by GitHub id; returns our user id. */
export async function upsertUser(db: Db, githubId: number, login: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ githubId, login })
    .onConflictDoUpdate({ target: users.githubId, set: { login } })
    .returning({ id: users.id });
  if (!row) throw new Error('upsert returned no user');
  return row.id;
}

/**
 * The GitHub id for a dev sign-in: negative, so it can never collide with a real account
 * (GitHub ids are positive), and stable per login.
 */
export function devGithubId(login: string): number {
  return -Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 12), 16) - 1;
}
