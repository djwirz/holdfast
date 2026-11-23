// End-to-end tests (spec §10). The default run, in CI and locally, uses the Stripe fake:
// two bidders, a bid war, the close, and accessibility. `pnpm test:e2e:stripe` instead runs
// the card-setup flow against real Stripe test mode with the keys in .env.local.
// `pnpm test:smoke` checks an already-running deploy at SMOKE_URL and starts nothing.
import { defineConfig, devices } from '@playwright/test';

const stripe = process.env['E2E_STRIPE'] === '1' || process.env['DEMO_GIF'] === '1';
const smokeUrl = process.env['SMOKE_URL'];
const WEB = smokeUrl ?? 'http://localhost:4173';

// The server's settings for the run. Values already in the environment win over
// .env.local, so the fake is forced by blanking the key unless this is the Stripe run.
const serverEnv: Record<string, string> = {
  NODE_ENV: 'development',
  APP_ORIGIN: WEB,
  DEV_SIGN_IN: '1',
  SESSION_SECRET: process.env['SESSION_SECRET'] ?? 'e2e-only-not-a-secret-000000000000000',
  DATABASE_URL:
    process.env['DATABASE_URL'] ?? 'postgres://holdfast:holdfast@localhost:5432/holdfast',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  ...(stripe ? {} : { STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '' }),
};

export default defineConfig({
  testDir: 'e2e',
  ...(smokeUrl ? {} : { globalSetup: './e2e/global-setup.ts' }),
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'e2e',
      testIgnore: /(stripe|smoke|demo)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'smoke',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e-stripe',
      testMatch: /stripe\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // By hand: pnpm demo:gif records the README's GIF (real Stripe test mode).
      name: 'demo',
      testMatch: /demo\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: smokeUrl
    ? []
    : [
        {
          // Two instances behind the round-robin proxy on :3000, as in development.
          command: 'pnpm --filter @holdfast/server dev',
          url: 'http://localhost:3000/api/healthz',
          env: { ...serverEnv, PORT: '3000' },
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command:
            'pnpm --filter @holdfast/web build && pnpm --filter @holdfast/web exec vite preview --port 4173 --strictPort',
          url: WEB,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});

export { serverEnv };
