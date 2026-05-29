/**
 * MetricsEmitter — Marshal metrics via the OTel Metrics API.
 *
 * Exports via OTLP to the ADOT collector sidecar (ECS) or the in-handler
 * NodeSDK started by `src/handlers/webhook-otel-init.ts` (Lambda), both of
 * which forward to Grafana Cloud Mimir. The ECS-side meter provider is
 * bootstrapped by `@opentelemetry/auto-instrumentations-node/register` (see
 * Dockerfile NODE_OPTIONS) plus the OTEL_METRICS_EXPORTER=otlp env var wired
 * in the CDK stack; the Lambda-side provider is started programmatically so
 * the Grafana Cloud basic-auth credential stays inside Secrets Manager
 * instead of being baked into the function's environment map.
 *
 * Counters → monotonic counts (e.g. directory_lookup_failure_count).
 * Histograms → distributions (e.g. assembly_duration_ms) so Mimir/Grafana can
 * surface p50/p99 without pre-aggregating in the app.
 *
 * All emission is non-blocking by design; the OTel SDK buffers and batches.
 * Errors surface via the SDK's own diag logger rather than blocking callers.
 */

import { Counter, Histogram, metrics as otelMetrics } from '@opentelemetry/api';

const METER_NAME = 'marshal';

export type MetricDimension = { name: string; value: string };

function toAttributes(dimensions: MetricDimension[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const d of dimensions) attrs[d.name] = d.value;
  return attrs;
}

export class MetricsEmitter {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  // awsRegion kept in the signature for call-site compatibility with the prior
  // CloudWatch implementation; ignored here since OTLP export target is set via env.
  constructor(_awsRegion?: string) {
    void _awsRegion;
  }

  /** Emit a distribution sample (duration, rate, etc.). Routes to a histogram. */
  gauge(metricName: string, value: number, _unit: unknown, dimensions: MetricDimension[] = []): void {
    void _unit;
    this.getHistogram(metricName).record(value, toAttributes(dimensions));
  }

  /** Increment a counter by 1. */
  increment(metricName: string, dimensions: MetricDimension[] = []): void {
    this.getCounter(metricName).add(1, toAttributes(dimensions));
  }

  /** Record a duration in milliseconds. Routes to a histogram. */
  durationMs(metricName: string, ms: number, dimensions: MetricDimension[] = []): void {
    this.getHistogram(metricName).record(ms, toAttributes(dimensions));
  }

  private getCounter(name: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = otelMetrics.getMeter(METER_NAME).createCounter(name);
      this.counters.set(name, c);
    }
    return c;
  }

  private getHistogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = otelMetrics.getMeter(METER_NAME).createHistogram(name, { unit: 'ms' });
      this.histograms.set(name, h);
    }
    return h;
  }
}

/** Canonical metric names. Keep in sync with Grafana dashboard panels + alerting rules. */
export const MetricNames = {
  AssemblyDurationMs: 'assembly_duration_ms',
  ApprovalGateLatencyMs: 'approval_gate_latency_ms',
  DirectoryLookupFailureCount: 'directory_lookup_failure_count',
  StatuspagePublishCount: 'statuspage_publish_count',
  IncidentResolvedCount: 'incident_resolved_count',
  PostmortemCreatedCount: 'postmortem_created_count',
  HttpTimeoutCount: 'http_timeout_count',
  HttpErrorCount: 'http_error_count',
  CircuitOpenCount: 'circuit_open_count',
  CircuitOpenRejectCount: 'circuit_open_reject_count',
} as const;
