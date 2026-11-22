import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type Browser, type Page, expect } from '@playwright/test';
import { serverEnv } from '../playwright.config.ts';

/** A fresh open auction ending in `seconds`, made with the validated create function. */
export function seedAuction(seconds: number): { id: string; title: string } {
  const out = execFileSync(process.execPath, ['src/seed-e2e.ts', String(seconds)], {
    cwd: resolve(import.meta.dirname, '../server'),
    env: { ...process.env, ...serverEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { id: string; title: string };
}

/** A bidder in their own browser context, signed in through the dev form on the page. */
export async function bidder(browser: Browser, name: string, path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(path);
  await page.getByLabel('Dev sign-in name').fill(name);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(`Signed in as dev-${name}`)).toBeVisible();
  return page;
}

export async function bid(page: Page, dollars: string): Promise<void> {
  const input = page.getByLabel(/Your bid in dollars/);
  await input.fill(dollars);
  await page.getByRole('button', { name: 'Bid', exact: true }).click();
}

/**
 * The invariant checker CLI against the running stack: waits until the auction has settled,
 * then checks all five invariants with the shared fake's record. Any violation, or any outbox
 * row that gave up, makes it exit non-zero.
 */
export function checkInvariants(auctionId: string): { ok: boolean; output: string } {
  const run = spawnSync(
    process.execPath,
    ['src/check-invariants.ts', '--auction', auctionId, '--wait', '60'],
    {
      cwd: resolve(import.meta.dirname, '../server'),
      env: { ...process.env, ...serverEnv },
      encoding: 'utf8',
    },
  );
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}
