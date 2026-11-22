// OpenTelemetry (spec §8), loaded before anything else: node --import ./src/telemetry.ts.
// Traces and metrics go to the OTLP endpoint in the standard OTEL_* variables (Grafana
// Cloud in production, ADR 0007's host). With no endpoint set it does nothing at all, so
// tests, CI and local development don't need a collector.
import { hostname } from 'node:os';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

if (endpoint) {
  // ESM modules can only be instrumented through Node's module hooks, registered before
  // they're imported: that's why this file loads first and imports the SDK dynamically.
  // In-thread hooks (module.registerHooks), not the deprecated module.register.
  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { PgInstrumentation },
    { IORedisInstrumentation },
    { PinoInstrumentation },
    { FastifyOtelInstrumentation },
    { resourceFromAttributes },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/exporter-metrics-otlp-proto'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@opentelemetry/instrumentation-pino'),
    import('@fastify/otel'),
    import('@opentelemetry/resources'),
  ]);

  const sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'holdfast',
    resource: resourceFromAttributes({
      // Which replica: Railway names each one; locally, host and port tell them apart.
      'service.instance.id':
        process.env['RAILWAY_REPLICA_ID'] ?? `${hostname()}:${process.env['PORT'] ?? '3000'}`,
    }),
    // OTEL_TRACES_EXPORTER=console (the standard variable) prints spans instead, for checking
    // instrumentation locally; the SDK only reads it when no exporter is passed.
    ...(process.env['OTEL_TRACES_EXPORTER'] ? {} : { traceExporter: new OTLPTraceExporter() }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 30_000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // Health checks and SSE heartbeats would drown out the bids.
        ignoreIncomingRequestHook: (req) => req.url === '/api/healthz',
      }),
      // Only inside a traced operation. The background loops poll Postgres several times a
      // second on every replica; tracing each poll would be gigabytes a day of nothing,
      // past Grafana's free tier. They get spans when they do work (outbox, close job).
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      new PinoInstrumentation(),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();

  const shutdown = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
