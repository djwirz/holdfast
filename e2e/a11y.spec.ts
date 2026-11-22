// Accessibility (artifact spec): no serious axe violations on the pages people use, price
// changes announced politely, and a bid placed with the keyboard alone.
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { bidder, seedAuction } from './support.ts';

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('home and auction pages pass axe', async ({ page, browser }) => {
  const auction = seedAuction(60);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Auctions' })).toBeVisible();
  await expect(page.getByRole('link', { name: auction.title })).toBeVisible();
  await expectNoSeriousViolations(page);

  const signedIn = await bidder(browser, 'axe', `/auctions/${auction.id}`);
  await expect(signedIn.getByRole('heading', { name: 'Place a bid' })).toBeVisible();
  await expectNoSeriousViolations(signedIn);
});

test('price changes are announced through a polite live region', async ({ browser }) => {
  const auction = seedAuction(60);
  const page = await bidder(browser, 'listener', `/auctions/${auction.id}`);
  const announcer = page.getByTestId('announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  await expect(announcer).toHaveAttribute('aria-atomic', 'true');
});

test('a bid can be placed with the keyboard alone', async ({ browser }) => {
  const auction = seedAuction(60);
  const page = await bidder(browser, 'keys', `/auctions/${auction.id}`);
  const input = page.getByLabel(/Your bid in dollars/);
  await expect(input).toBeVisible();
  // Tab from the top of the page until the bid input has focus.
  await page.locator('body').focus();
  for (let i = 0; i < 20 && !(await input.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('15.00');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('bid-status')).toHaveText('Your bid is the high bid.');
  await expect(page.getByTestId('current-price')).toHaveText('$15.00');
});
