// By hand only (`pnpm test:e2e:stripe`): the card-setup flow against real Stripe test
// mode. Card details go into Stripe's own iframe; the server saves the card only after
// checking Stripe's record, and a bid then places a real hold.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { addCard, bid, bidder, seedAuction } from './support.ts';

test.skip(process.env['E2E_STRIPE'] !== '1', 'set E2E_STRIPE=1 (pnpm test:e2e:stripe)');

// The servers stop before these auctions close, so nothing would release the holds the
// bids placed. Release them here, so the sandbox keeps invariant 4 too.
const seeded: string[] = [];
test.afterAll(() => {
  if (seeded.length === 0) return;
  execFileSync(process.execPath, ['scripts/release-test-holds.ts', ...seeded], {
    cwd: resolve(import.meta.dirname, '../server'),
    stdio: 'inherit',
  });
});

test('save a test card, then bid with a real hold', async ({ browser }) => {
  const auction = seedAuction(120);
  seeded.push(auction.id);
  const page = await bidder(
    browser,
    `card${String(Date.now() % 100_000)}`,
    `/auctions/${auction.id}`,
  );
  await expect(page.getByText('Add a card to bid').first()).toBeVisible();
  await addCard(page, '4242 4242 4242 4242');
  await bid(page, '10.00');
  // Accepted only once Stripe holds the amount (invariant 1, checked in code).
  await expect(page.getByTestId('bid-status')).toHaveText('Your bid is the high bid.', {
    timeout: 30_000,
  });
});

test('a card that saves but declines when charged is refused, in words', async ({ browser }) => {
  const auction = seedAuction(120);
  seeded.push(auction.id);
  const page = await bidder(
    browser,
    `decl${String(Date.now() % 100_000)}`,
    `/auctions/${auction.id}`,
  );
  await addCard(page, '4000 0000 0000 0341');
  await bid(page, '10.00');
  await expect(page.getByTestId('bid-status')).toHaveText('Not accepted: your card was declined.', {
    timeout: 30_000,
  });
});
