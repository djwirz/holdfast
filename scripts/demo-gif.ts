// The README's GIF (spec §11.1): records two bidders against two server instances and real
// Stripe test mode (e2e/demo.spec.ts, which also checks Stripe's record of the holds), then
// puts the two recordings side by side as docs/demo.gif with ffmpeg in Docker, an image
// pinned by digest, so nothing is installed on the machine.
//
//   node scripts/demo-gif.ts      (pnpm demo:gif)
//
// Needs Docker, docker compose up (Postgres, Redis), and sk_test_/pk_test_ keys in .env.local.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const FFMPEG =
  'jrottenberg/ffmpeg:9.0.1-alpine320@sha256:2c3d71587b80173373ff52f2573ec5be9f527f2ba4fe601de6641299b1d68211';
const root = resolve(import.meta.dirname, '..');
const out = 'docs/demo.gif';

const envFile = existsSync(`${root}/.env.local`) ? readFileSync(`${root}/.env.local`, 'utf8') : '';
const has = (name: string, prefix: string) =>
  new RegExp(`^${name}=['"]?${prefix}`, 'm').test(envFile) ||
  (process.env[name]?.startsWith(prefix) ?? false);
if (!has('STRIPE_SECRET_KEY', 'sk_test_') || !has('STRIPE_PUBLISHABLE_KEY', 'pk_test_')) {
  console.error(
    'Needs test-mode STRIPE_SECRET_KEY (sk_test_) and STRIPE_PUBLISHABLE_KEY (pk_test_) in .env.local.',
  );
  process.exit(1);
}

execFileSync('pnpm', ['exec', 'playwright', 'test', '--project', 'demo'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DEMO_GIF: '1' },
});

const { paths } = JSON.parse(readFileSync(`${root}/test-results/demo/videos.json`, 'utf8')) as {
  paths: string[];
};
const [a, b] = paths.map((p) => relative(root, p));
if (!a || !b) throw new Error('expected two recordings');

// Side by side with a thin gap, 10 frames a second, one shared palette.
const filter = [
  '[0:v]setpts=PTS-STARTPTS,pad=iw+8:ih:0:0:color=white[a]',
  '[1:v]setpts=PTS-STARTPTS[b]',
  '[a][b]hstack=inputs=2:shortest=1,fps=10,scale=960:-1:flags=lanczos,split[s0][s1]',
  '[s0]palettegen=max_colors=96:stats_mode=diff[p]',
  '[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
].join(';');
execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '--user',
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    '-v',
    `${root}:/work`,
    '-w',
    '/work',
    FFMPEG,
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    a,
    '-i',
    b,
    '-filter_complex',
    filter,
    '-loop',
    '0',
    out,
  ],
  { cwd: root, stdio: 'inherit' },
);
console.log(`${out}: ${(statSync(`${root}/${out}`).size / 1_000_000).toFixed(1)} MB`);
