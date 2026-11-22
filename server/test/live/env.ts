// Loads .env.local for the live suite, so the Stripe key never has to be on a command line.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../../.env.local');
if (existsSync(file)) process.loadEnvFile(file);
