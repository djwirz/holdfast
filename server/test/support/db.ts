import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { type Db, createDb } from '../../src/db/client.ts';
import { users } from '../../src/db/schema.ts';
import { TEMPLATE_DB, withDatabase } from './global-setup.ts';

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** A new database cloned from the migrated template. */
export async function freshDb(options: { max?: number } = {}): Promise<TestDb> {
  const adminUri = inject('pgAdminUri');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUri });
  await admin.connect();
  try {
    await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const { db, pool } = createDb(withDatabase(adminUri, name), options);
  return { db, pool, close: () => pool.end() };
}

let nextGithubId = 1;

export async function createUsers(db: Db, count: number): Promise<string[]> {
  const rows = await db
    .insert(users)
    .values(
      Array.from({ length: count }, () => {
        const githubId = nextGithubId++;
        return { githubId, login: `bidder${String(githubId)}` };
      }),
    )
    .returning({ id: users.id });
  return rows.map((r) => r.id);
}
