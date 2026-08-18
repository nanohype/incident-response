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
 * assembly_duration_seconds) so Grafana can surface p50/p99 without
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

  /**
   * Add an arbitrary amount to a counter.
   *
   * Distinct from `increment` because token counts are quantities, not events:
   * a single model call contributes hundreds of input tokens, and counting the
   * call rather than the tokens gives a rate that cannot be turned into spend.
   * Non-finite and negative values are dropped rather than recorded — a
   * monotonic counter cannot represent them, and a NaN poisons the series for
   * every query that touches it.
   */
  count(metricName: string, value: number, dimensions: MetricDimension[] = []): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.metrics.counter(metricName, value, toAttributes(dimensions));
  }

  /**
   * Record a duration in SECONDS. Routes to a histogram with unit `s`.
   *
   * `boundaries` is not optional in practice for anything that can run longer
   * than ten seconds: OTel's default bucket edges top out at 10000, which is
   * fine as milliseconds and wrong as seconds, and `histogram_quantile` cannot
   * return a value above the highest finite edge. Assembly's alert threshold sat
   * 30x past that edge and was false for every possible input.
   */
  duration(
    metricName: string,
    seconds: number,
    dimensions: MetricDimension[] = [],
    boundaries?: readonly number[],
  ): void {
    this.metrics.duration(
      metricName,
      seconds,
      toAttributes(dimensions),
      boundaries ? { boundaries: [...boundaries] } : undefined,
    );
  }
}

/**
 * Bucket edges per duration instrument, in seconds.
 *
 * Chosen from each instrument's stated target, not from the observed
 * distribution — there is none yet. Assembly's runbook target is p50 <= 300s and
 * p95 <= 480s, so the edges bracket both and extend past the 300s alert
 * threshold; without an edge above it the alert cannot fire whatever the real
 * latency is. Approval-gate latency is two DynamoDB round trips, so it is
 * sub-second shaped.
 */
export const DurationBuckets = {
  assembly: [30, 60, 120, 240, 300, 480, 600, 900],
  approvalGate: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
} as const;

/** Canonical metric names. Keep in sync with Grafana dashboard panels + alerting rules. */
export const MetricNames = {
  AssemblyDuration: "assembly_duration_seconds",
  ApprovalGateLatency: "approval_gate_latency_seconds",
  DirectoryLookupFailureCount: "directory_lookup_failure_count",
  StatuspagePublishCount: "statuspage_publish_count",
  IncidentResolvedCount: "incident_resolved_count",
  PostmortemCreatedCount: "postmortem_created_count",
  HttpTimeoutCount: "http_timeout_count",
  HttpErrorCount: "http_error_count",
  CircuitOpenCount: "circuit_open_count",
  CircuitOpenRejectCount: "circuit_open_reject_count",

  // Model usage, dimensioned by ModelGateway route (`default` / `light`) and
  // outcome. The BudgetPolicy kill-switch is a platform-layer ceiling on the
  // whole tenant; these are the per-request attribution under it, which is what
  // answers "which route spent it" rather than only "the tenant spent it".
  // Separate cache series because a cache read is an order of magnitude cheaper
  // than a fresh input token, so summing them would misstate cost.
  ModelInvocationCount: "model_invocation_count",
  ModelInputTokens: "model_input_tokens",
  ModelOutputTokens: "model_output_tokens",
  ModelCacheReadTokens: "model_cache_read_tokens",
  ModelCacheWriteTokens: "model_cache_write_tokens",
} as const;
