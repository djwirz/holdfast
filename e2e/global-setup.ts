// Before the run: the database is migrated (the web servers are already starting).
import { execFileSync } from 'node:child_process';
import { serverEnv } from '../playwright.config.ts';

export default function globalSetup(): void {
  execFileSync('pnpm', ['--filter', '@holdfast/server', 'db:migrate'], {
    env: { ...process.env, ...serverEnv },
    stdio: 'inherit',
  });
}
