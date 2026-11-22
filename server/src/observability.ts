// Spans, metrics and trace context for the app code (spec §8). Everything here goes through
// @opentelemetry/api, which is a no-op until telemetry.ts starts the SDK: tests, CI and local
// runs without a collector pay nothing.
import {
  type Attributes,
  type Context,
  type Span,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('holdfast');
const meter = metrics.getMeter('holdfast');

/** Runs fn in a new span, ending it however fn ends. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  parent?: Context,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * The active trace context as a W3C traceparent, for carrying a trace across a boundary that
 * isn't a request: an outbox row, a Redis message. Null when nothing is being traced.
 */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'] ?? null;
}

/** The context a carried traceparent continues; the active context if there's none. */
export function contextFrom(traceparent: unknown): Context {
  if (typeof traceparent !== 'string' || traceparent === '') return context.active();
  return propagation.extract(context.active(), { traceparent });
}

// The metrics in spec §8. Names follow Prometheus once Grafana converts them: a counter
// gains _total, units become suffixes.
export const bidOutcomes = meter.createCounter('holdfast.bids', {
  description: 'Bids by final outcome (accepted, lost_race, rejected) and reason',
});
export const holdDuration = meter.createHistogram('holdfast.hold.duration', {
  description: 'Time to place a card hold (authorize)',
  unit: 'ms',
});
export const lockWait = meter.createHistogram('holdfast.lock.wait', {
  description: "Time waiting for the auction row lock in a bid's decision",
  unit: 'ms',
});

/** Gauges set by the sampler (sampler.ts); read by Grafana's alert rules. */
export const gauges = {
  outboxLag: meter.createGauge('holdfast.outbox.lag', {
    description: 'Age of the oldest outbox row that is due and not done',
    unit: 's',
  }),
  outboxFailed: meter.createGauge('holdfast.outbox.failed', {
    description: 'Outbox rows that gave up (failed_at set), by kind',
  }),
  pendingStale: meter.createGauge('holdfast.bids.pending_stale', {
    description: 'Bids pending longer than the reconciler threshold',
  }),
  unsettled: meter.createGauge('holdfast.auctions.unsettled', {
    description: 'Auctions closed more than 10 minutes ago and still not settled',
  }),
  orphanedHolds: meter.createGauge('holdfast.holds.orphaned', {
    description: 'Live holds at the payment provider with no live bid behind them (the alarm)',
  }),
};
