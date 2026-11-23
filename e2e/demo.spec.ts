// The README's GIF (spec §11.1), by hand only: `pnpm demo:gif`. Two bidders in two browsers,
// against two server instances and real Stripe test mode, bid against each other live until
// the auction closes. Signing in and saving cards happen first, unrecorded; the recording
// starts at the bidding. Then the invariant checker reads Stripe's own record: every losing
// hold released, the winner's captured. scripts/demo-gif.ts turns the two videos into a GIF.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { serverEnv } from '../playwright.config.ts';
import { addCard, bid, bidder, seedAuction } from './support.ts';

test.skip(process.env['DEMO_GIF'] !== '1', 'run with pnpm demo:gif');

const OUT = resolve(import.meta.dirname, '../test-results/demo');
const SIZE = { width: 560, height: 900 };

test('two bidders, live, through to the close', async ({ browser }) => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const run = String(Date.now() % 100_000);

  // Unrecorded: sign in and save a card on a throwaway auction that gets no bids.
  const setup = seedAuction(300, 'Card setup (not recorded)');
  const states: Awaited<ReturnType<BrowserContext['storageState']>>[] = [];
  for (const name of ['alice', 'bob']) {
    const page = await bidder(browser, `${name}${run}`, `/auctions/${setup.id}`);
    await addCard(page, '4242 4242 4242 4242');
    states.push(await page.context().storageState());
    await page.context().close();
  }

  // Recorded: the auction they'll fight over, ending soon after their last bid.
  const auction = seedAuction(26, 'Hand-thrown stoneware mug');
  const open = async (b: Browser, i: number) => {
    const storageState = states[i];
    if (!storageState) throw new Error('no saved sign-in');
    const context = await b.newContext({
      storageState,
      viewport: SIZE,
      recordVideo: { dir: OUT, size: SIZE },
    });
    const page = await context.newPage();
    await page.goto(`/auctions/${auction.id}`);
    await expect(page.getByRole('heading', { name: 'Place a bid' })).toBeVisible();
    return page;
  };
  const [alice, bob] = [await open(browser, 0), await open(browser, 1)];
  const pause = (ms: number) => alice.waitForTimeout(ms);
  await pause(1_500);

  // Each bid lands on the other page live, over the stream from the other instance.
  const rounds: [Page, Page, string, string][] = [
    [alice, bob, '10.00', '$10.00'],
    [bob, alice, '12.00', '$12.00'],
    [alice, bob, '15.00', '$15.00'],
    [bob, alice, '20.00', '$20.00'],
  ];
  for (const [mine, theirs, dollars, shown] of rounds) {
    await bid(mine, dollars);
    await expect(mine.getByTestId('bid-status')).toHaveText('Your bid is the high bid.', {
      timeout: 30_000,
    });
    await expect(theirs.getByText(shown).first()).toBeVisible();
    await pause(1_500);
  }

  // The close, on both pages.
  for (const page of [alice, bob]) {
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 60_000 });
  }
  await pause(3_000);
  const videos = [alice, bob].map((p) => {
    const video = p.video();
    if (!video) throw new Error('no recording');
    return video;
  });
  await Promise.all([alice.context().close(), bob.context().close()]);
  const paths = await Promise.all(videos.map((v) => v.path()));
  writeFileSync(`${OUT}/videos.json`, JSON.stringify({ auctionId: auction.id, paths }));

  // The money, from Stripe's side: losing holds released, the winner's captured.
  const check = spawnSync(
    process.execPath,
    [
      '--env-file-if-exists=../.env.local',
      'src/check-invariants.ts',
      '--auction',
      auction.id,
      '--stripe',
      '--wait',
      '90',
      '--min-accepted',
      '4',
    ],
    {
      cwd: resolve(import.meta.dirname, '../server'),
      env: { ...process.env, ...serverEnv },
      encoding: 'utf8',
    },
  );
  console.log(`${check.stdout}${check.stderr}`);
  expect(check.status, 'invariant check against Stripe').toBe(0);
});
