// One Postgres container for the whole integration run. Migrations go into a template
// database once; each test file clones it (fast, and isolated from the other files).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createDb } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';

export const TEMPLATE_DB = 'holdfast_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URI to the container's maintenance database, for CREATE DATABASE. */
    pgAdminUri: string;
  }
}

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const adminUri = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUri });
  await admin.connect();
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();

  const { db, pool } = createDb(withDatabase(adminUri, TEMPLATE_DB));
  await runMigrations(db);
  // A template can't be cloned while anything is connected to it.
  await pool.end();

  project.provide('pgAdminUri', adminUri);
  return async () => {
    await container.stop();
  };
}

export function withDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}
