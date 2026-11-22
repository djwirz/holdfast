// After every deploy (and by hand: SMOKE_URL=https://… pnpm test:smoke). No sign-in, since
// production has none to stub: it checks what a visitor gets, through the real edge, TLS
// and both replicas.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.skip(!process.env['SMOKE_URL'], 'set SMOKE_URL to the deployed origin');

test('the API is healthy, with Redis connected and no dev sign-in', async ({ request }) => {
  const health = await request.get('/api/healthz');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ ok: true, redis: 'ready' });
  const config = (await (await request.get('/api/config')).json()) as { devSignIn: boolean };
  expect(config.devSignIn).toBe(false);
});

test('a visitor sees a live auction, streaming, with no serious accessibility problems', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Auctions' })).toBeVisible();
  const live = page.getByRole('listitem').filter({ hasText: /open/ }).first();
  await expect(live).toBeVisible();
  await live.getByRole('link').click();

  // "Live" means the SSE snapshot arrived through the host's edge and TLS.
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('current-price')).toBeVisible();

  // A page route loaded directly (not through the app) gets the app shell too.
  await page.reload();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
