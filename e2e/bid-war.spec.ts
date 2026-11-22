// Acceptance 1 (spec §11), with the fake: two people in two browsers bid against each
// other and both see every change live, through the round-robin proxy, so the bid and the
// stream usually land on different instances and arrive through Redis.
import { expect, test } from '@playwright/test';
import { bid, bidder, seedAuction } from './support.ts';

test('two bidders: a bid war, live on both pages, through to the close', async ({ browser }) => {
  const auction = seedAuction(25);
  const path = `/auctions/${auction.id}`;
  const alice = await bidder(browser, 'alice', path);
  const bob = await bidder(browser, 'bob', path);
  for (const page of [alice, bob]) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(auction.title);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  }

  // Alice opens at the starting price; Bob's page updates without a reload.
  await bid(alice, '10.00');
  await expect(alice.getByTestId('bid-status')).toHaveText('Your bid is the high bid.');
  await expect(bob.getByTestId('current-price')).toHaveText('$10.00');
  await expect(bob.getByTestId('announcer')).toHaveText(/New high bid \$10\.00 by Bidder/);
  // The minimum moved, and Bob's form follows it.
  await expect(bob.getByLabel(/Your bid in dollars/)).toHaveValue('11.00');

  // Bob outbids; Alice sees it, and that she's been outbid.
  await bid(bob, '12.00');
  await expect(bob.getByTestId('bid-status')).toHaveText('Your bid is the high bid.');
  await expect(alice.getByTestId('current-price')).toHaveText('$12.00');
  await expect(alice.getByTestId('bid-status')).toHaveText('You’ve been outbid.');

  // A bid under the minimum is refused, in words.
  await bid(alice, '12.50');
  await expect(alice.getByTestId('bid-status')).toHaveText(
    'Not accepted: the bid is below the minimum.',
  );
  await expect(bob.getByTestId('current-price')).toHaveText('$12.00');

  // The auction closes on the server's clock; both pages show the sale.
  await expect(bob.getByTestId('result')).toHaveText('You won, at $12.00.', { timeout: 40_000 });
  await expect(alice.getByTestId('result')).toHaveText(
    /^Sold to Bidder [0-9a-f]{4} for \$12\.00\.$/,
  );
  await expect(alice.getByTestId('announcer')).toHaveText(/The auction ended\. Sold to Bidder/);

  // Both pages saw the same history, newest first.
  for (const page of [alice, bob]) {
    await expect(page.getByTestId('recent-bids').locator('li')).toHaveCount(2);
  }
});
