// By hand only (`pnpm test:e2e:stripe`): the card-setup flow against real Stripe test
// mode. Card details go into Stripe's own iframe; the server saves the card only after
// checking Stripe's record, and a bid then places a real hold.
import { type Page, expect, test } from '@playwright/test';
import { bid, bidder, seedAuction } from './support.ts';

test.skip(process.env['E2E_STRIPE'] !== '1', 'set E2E_STRIPE=1 (pnpm test:e2e:stripe)');

async function addCard(page: Page, number: string) {
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

test('save a test card, then bid with a real hold', async ({ browser }) => {
  const auction = seedAuction(120);
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
