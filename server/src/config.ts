// The server's settings, read once at startup and checked, so a missing or malformed
// variable stops the process instead of surfacing mid-request. Never logged: some are secrets.
import { z } from 'zod';

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    /** The browser origin state-changing requests must come from (spec §9). */
    APP_ORIGIN: z.url(),
    /** Keys bidder aliases; at least 32 characters. */
    SESSION_SECRET: z.string().min(32),
    STRIPE_SECRET_KEY: z
      .string()
      .startsWith('sk_test_', 'must be a test-mode key')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    STRIPE_PUBLISHABLE_KEY: z
      .string()
      .startsWith('pk_test_', 'must be a test-mode key')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    DEV_SIGN_IN: flag,
    /** The built page to serve from the server itself (production); unset locally. */
    WEB_DIST: z.string().min(1).optional(),
    /** The shared Stripe fake (payments/fake-server.ts) for multi-instance local runs and load. */
    FAKE_PAYMENTS_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Background loop intervals; production polls a little less (two replicas each poll). */
    /** Bids per bidder per 10 seconds (spec §9); the load test raises it to measure ordering, not limits. */
    BID_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
    /** Sign-ins per IP per minute (spec §9); the load test signs every bidder in from one IP. */
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
    OUTBOX_INTERVAL_MS: z.coerce.number().int().min(10).default(100),
    LIFECYCLE_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
    // Reopen each demo auction in rounds so the live demo always has one open (spec §13 Q4).
    DEMO_ROUNDS: flag,
  })
  .refine((c) => !c.DEV_SIGN_IN || c.NODE_ENV !== 'production', {
    message: 'DEV_SIGN_IN is only allowed in development and test',
    path: ['DEV_SIGN_IN'],
  })
  .refine((c) => !c.FAKE_PAYMENTS_URL || c.NODE_ENV !== 'production', {
    message: 'the Stripe fake is for development, tests and load only',
    path: ['FAKE_PAYMENTS_URL'],
  })
  // Session cookies are Secure only on https, so production must be served over it.
  .refine((c) => c.NODE_ENV !== 'production' || c.APP_ORIGIN.startsWith('https://'), {
    message: 'must be https:// in production',
    path: ['APP_ORIGIN'],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Name the variables, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
