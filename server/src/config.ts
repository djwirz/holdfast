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
    /** Background loop intervals; production polls a little less (two replicas each poll). */
    OUTBOX_INTERVAL_MS: z.coerce.number().int().min(10).default(100),
    LIFECYCLE_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  })
  .refine((c) => !c.DEV_SIGN_IN || c.NODE_ENV !== 'production', {
    message: 'DEV_SIGN_IN is only allowed in development and test',
    path: ['DEV_SIGN_IN'],
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
