import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const base = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  APP_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'a'.repeat(32),
};

describe('loadConfig', () => {
  it('accepts a minimal development config, with the fake for payments', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ NODE_ENV: 'development', PORT: 3000, DEV_SIGN_IN: false });
    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('refuses dev sign-in in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEV_SIGN_IN: '1' })).toThrow(
      /DEV_SIGN_IN/,
    );
    expect(loadConfig({ ...base, DEV_SIGN_IN: '1' }).DEV_SIGN_IN).toBe(true);
  });

  it('refuses a live Stripe key without echoing it', () => {
    const attempt = () => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_nope' });
    expect(attempt).toThrow(/STRIPE_SECRET_KEY: must be a test-mode key/);
    expect(attempt).not.toThrow(/nope/);
  });

  it('names missing variables', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*SESSION_SECRET/);
  });

  it('wants a session secret of at least 32 characters', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
