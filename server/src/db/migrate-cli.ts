import { createDb, databaseUrl } from './client.ts';
import { runMigrations } from './migrate.ts';

const { db, pool } = createDb(databaseUrl());
try {
  await runMigrations(db);
  console.log('migrations applied');
} finally {
  await pool.end();
}
