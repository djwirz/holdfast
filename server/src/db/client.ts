import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(
  connectionString: string,
  options: { max?: number } = {},
): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, ...options });
  return { db: drizzle(pool, { schema }), pool };
}

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env.local)');
  return url;
}
