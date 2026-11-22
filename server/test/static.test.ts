// Serving the built page from the server (slice 5): one origin for page and API, page
// routes fall back to the app shell, the API keeps its JSON 404s, and caching is safe
// across deploys.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { type TestDb, freshDb } from './support/db.ts';
import { type TestApp, testApp } from './support/http.ts';

let testDb: TestDb;
let db: Db;
let t: TestApp;
let dist: string;

beforeAll(async () => {
  testDb = await freshDb();
  db = testDb.db;
  dist = mkdtempSync(join(tmpdir(), 'holdfast-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Holdfast</title>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  t = await testApp(db, { webDist: dist });
});

afterAll(async () => {
  await t.close();
  await testDb.close();
  rmSync(dist, { recursive: true, force: true });
});

const html = { accept: 'text/html,application/xhtml+xml' };

describe('the built page, served by the server', () => {
  it('serves the app shell at / and for page routes, never cached', async () => {
    for (const url of ['/', '/auctions/00000000-0000-4000-8000-000000000000']) {
      const res = await t.app.inject({ url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>Holdfast</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches fingerprinted assets for good', async () => {
    const res = await t.app.inject({ url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps unknown API paths a JSON 404, even for a browser', async () => {
    const res = await t.app.inject({ url: '/api/nope', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'not found' });
  });

  it('404s a missing file that is not a page request', async () => {
    const res = await t.app.inject({ url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to start without the page, so a bad deploy never goes live', async () => {
    await expect(testApp(db, { webDist: join(dist, 'nowhere') })).rejects.toThrow(/index\.html/);
  });

  it('serves the API alongside', async () => {
    expect((await t.app.inject({ url: '/api/config' })).statusCode).toBe(200);
  });
});
