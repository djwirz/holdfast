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
    ],
  },
});
