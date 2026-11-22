import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['server/test/**/*.test.ts'],
          globalSetup: ['server/test/support/global-setup.ts'],
          // One file at a time: the storm's timing assertions shouldn't depend on what
          // else happens to be hammering the same Postgres.
          fileParallelism: false,
          // Starting a Postgres container takes a while on a cold Docker.
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
      {
        // Real Stripe test mode, by hand only (spec §10): `pnpm test:live`. Skips unless
        // STRIPE_LIVE_TEST=1 and .env.local has a test-mode STRIPE_SECRET_KEY.
        test: {
          name: 'live',
          include: ['server/test/live/**/*.live.ts'],
          setupFiles: ['server/test/live/env.ts'],
          globalSetup: ['server/test/support/global-setup.ts'],
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 120_000,
        },
      },
    ],
  },
});
