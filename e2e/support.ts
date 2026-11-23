import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type Browser, type Page, expect } from '@playwright/test';
import { serverEnv } from '../playwright.config.ts';

/** A fresh open auction ending in `seconds`, made with the validated create function. */
export function seedAuction(seconds: number, title?: string): { id: string; title: string } {
  const args = ['src/seed-e2e.ts', String(seconds), ...(title ? [title] : [])];
  const out = execFileSync(process.execPath, args, {
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

/** Saves a test card through Stripe's card form on the page (real test mode only). */
export async function addCard(page: Page, number: string) {
  await page.getByRole('button', { name: 'Add a card' }).click();
  // Stripe's card-only element: one iframe with all four fields.
  const card = page.locator('iframe[title*="card payment input"]').first().contentFrame();
  await card.getByPlaceholder('Card number').fill(number);
  await card.getByPlaceholder('MM / YY').fill('12 / 34');
  await card.getByPlaceholder('CVC').fill('123');
  const zip = card.getByPlaceholder('ZIP');
  if (await zip.isVisible().catch(() => false)) await zip.fill('94107');
  await page.getByRole('button', { name: 'Save card' }).click();
  await expect(page.getByRole('heading', { name: 'Place a bid' })).toBeVisible({
    timeout: 30_000,
  });
}
