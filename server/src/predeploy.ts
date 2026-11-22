// Runs before each deploy goes live (.railway/railway.ts): migrations, then the idempotent
// demo seed. If either fails, the deploy stops and the previous one keeps serving.
import { createDb, databaseUrl } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { seed } from './seed.ts';

const { db, pool } = createDb(databaseUrl());
try {
  await runMigrations(db);
  console.log('migrations applied');
  const result = await seed(db);
  console.log(`seeded: ${String(result.created)} created, ${String(result.skipped)} already live`);
} finally {
  await pool.end();
}
