// Local stand-in for production's two instances (spec §11): starts the server twice and
// puts a round-robin proxy in front, so every bid and every SSE stream can land on a
// different instance than the last, and fan-out through Redis is exercised by hand.
import { spawn } from 'node:child_process';
import { request as httpRequest, createServer } from 'node:http';
import { resolve } from 'node:path';

const PROXY_PORT = Number(process.env['PORT'] ?? 3000);
const INSTANCES = [PROXY_PORT + 1, PROXY_PORT + 2];
const serverDir = resolve(import.meta.dirname, '../..');

// One Stripe fake for both instances (payments/fake-server.ts); used when no test key is set.
const FAKE_PORT = Number(process.env['FAKE_PORT'] ?? 4010);
const fake = spawn(process.execPath, ['src/payments/fake-server.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    FAKE_PORT: String(FAKE_PORT),
    FAKE_LATENCY_MS: process.env['FAKE_LATENCY_MS'] ?? '150-500',
  },
  stdio: 'inherit',
});

const children = INSTANCES.map((port) =>
  spawn(process.execPath, ['--env-file-if-exists=../.env.local', 'src/main.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      FAKE_PAYMENTS_URL:
        process.env['FAKE_PAYMENTS_URL'] ?? `http://127.0.0.1:${String(FAKE_PORT)}`,
    },
    stdio: 'inherit',
  }),
);

let next = 0;
const proxy = createServer((req, res) => {
  const port = INSTANCES[next++ % INSTANCES.length] ?? PROXY_PORT + 1;
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { ...up.headers, 'x-holdfast-instance': String(port) });
      up.pipe(res); // streams SSE through without buffering
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_gateway', message: `instance :${String(port)} is down` }));
  });
  req.pipe(upstream);
});
proxy.listen(PROXY_PORT, () => {
  console.log(`proxy :${String(PROXY_PORT)} → instances ${INSTANCES.map(String).join(', ')}`);
});

const stop = () => {
  proxy.close();
  for (const child of [...children, fake]) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
