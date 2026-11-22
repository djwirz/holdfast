import { defineRailway, github, postgres, project, redis, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: 'us-west2' });
  Postgres.networking = { privateNetworkEndpoint: 'postgres' };
  const Redis = redis('Redis', { region: 'us-west2' });
  Redis.deploy = {
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: 'redis' };
  const redisVolume = volume('redis-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 5000,
  });
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 5000,
  });
  // The app (ADR 0007): two replicas of the Docker image, deployed from main once CI passes.
  // Variables stay unmanaged: secrets live in Railway, never in this file.
  const holdfast = service('holdfast', {
    source: github('djwirz/holdfast', {
      branch: 'main',
      checkSuites: true,
      upstreamUrl: 'https://github.com/djwirz/holdfast',
    }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      // Migrations, then the idempotent demo seed; a failure stops the deploy.
      preDeployCommand: ['node server/src/predeploy.ts'],
      healthcheckPath: '/api/healthz',
      healthcheckTimeout: 60,
      // Railway restarts on failure by default; this caps the retries.
      restartPolicyMaxRetries: 5,
      // Time for open SSE streams to end before a replica stops; clients reconnect.
      drainingSeconds: 10,
    },
    replicas: { 'us-west2': 2 },
  });

  return project('perceptive-reflection', {
    variables: { managed: false },
    resources: [Postgres, holdfast, Redis, redisVolume, postgresVolume],
  });
});
