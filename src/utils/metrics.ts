/**
 * MetricsEmitter — IncidentResponse metrics via the OTel Metrics API.
 *
 * Exports via OTLP to the cluster collector, which remote-writes metrics to
 * Amazon Managed Prometheus; the meter provider is bootstrapped by
 * `@opentelemetry/auto-instrumentations-node/register` (NODE_OPTIONS in the
 * Dockerfile) plus OTEL_METRICS_EXPORTER=otlp wired into the pod env by the
 * chart.
 *
 * The lazy-instrument core (namespace qualification to `incident_response.*`
 * series, per-name caching, no-op degradation without a provider) is the
 * vendored `@nanohype/runtime` metrics module; this class is the app's
 * emitter surface over it. Counters → monotonic counts (e.g.
 * directory_lookup_failure_count). Histograms → distributions (e.g.
 * assembly_duration_ms) so Grafana can surface p50/p99 without
 * pre-aggregating in the app.
 *
 * All emission is non-blocking by design; the OTel SDK buffers and batches.
 * Errors surface via the SDK's own diag logger rather than blocking callers.
 */

import { createMetrics, type Metrics } from "../vendor/runtime/metrics.js";

export type MetricDimension = { name: string; value: string };

function toAttributes(dimensions: MetricDimension[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const d of dimensions) attrs[d.name] = d.value;
  return attrs;
}

export class MetricsEmitter {
  private readonly metrics: Metrics;

  // awsRegion kept in the signature for call-site compatibility with the prior
  // CloudWatch implementation; ignored here since OTLP export target is set via env.
  constructor(_awsRegion?: string) {
    void _awsRegion;
    this.metrics = createMetrics({
      meterName: "incident-response",
      namespace: "incident_response",
    });
  }

  /** Emit a distribution sample (duration, rate, etc.). Routes to a histogram. */
  gauge(
    metricName: string,
    value: number,
    _unit: unknown,
    dimensions: MetricDimension[] = [],
  ): void {
    void _unit;
    this.metrics
      .histogramInstrument(metricName, { unit: "ms" })
      .record(value, toAttributes(dimensions));
  }

  /** Increment a counter by 1. */
  increment(metricName: string, dimensions: MetricDimension[] = []): void {
    this.metrics.counter(metricName, 1, toAttributes(dimensions));
  }

  /** Record a duration in milliseconds. Routes to a histogram. */
  durationMs(metricName: string, ms: number, dimensions: MetricDimension[] = []): void {
    this.metrics.timing(metricName, ms, toAttributes(dimensions));
  }
}

/** Canonical metric names. Keep in sync with Grafana dashboard panels + alerting rules. */
export const MetricNames = {
  AssemblyDurationMs: "assembly_duration_ms",
  ApprovalGateLatencyMs: "approval_gate_latency_ms",
  DirectoryLookupFailureCount: "directory_lookup_failure_count",
  StatuspagePublishCount: "statuspage_publish_count",
  IncidentResolvedCount: "incident_resolved_count",
  PostmortemCreatedCount: "postmortem_created_count",
  HttpTimeoutCount: "http_timeout_count",
  HttpErrorCount: "http_error_count",
  CircuitOpenCount: "circuit_open_count",
  CircuitOpenRejectCount: "circuit_open_reject_count",
} as const;
