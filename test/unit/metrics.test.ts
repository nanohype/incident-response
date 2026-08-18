/**
 * Unit tests for MetricsEmitter — validates OTel counter/histogram recording.
 *
 * Uses an in-memory metric reader so we can introspect the recorded data points
 * without standing up a real OTLP pipeline.
 */

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import { MetricNames, MetricsEmitter } from "../../src/utils/metrics.js";

describe("MetricsEmitter", () => {
  // setGlobalMeterProvider is a one-shot across the process — set once in beforeAll.
  // Per-test isolation happens via a per-test emitter + exporter.reset().
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;
  let emitter: MetricsEmitter;

  beforeAll(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    emitter = new MetricsEmitter();
  });

  async function collect() {
    await reader.forceFlush();
    const batches = exporter.getMetrics();
    const datapoints: Array<{
      name: string;
      kind: "counter" | "histogram";
      value: number;
      attrs: Record<string, string>;
    }> = [];
    for (const batch of batches) {
      for (const scope of batch.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const dp of metric.dataPoints) {
            const value = dp.value as number | { sum: number };
            if (typeof value === "number") {
              datapoints.push({
                name: metric.descriptor.name,
                kind: "counter",
                value,
                attrs: dp.attributes as Record<string, string>,
              });
            } else {
              datapoints.push({
                name: metric.descriptor.name,
                kind: "histogram",
                value: value.sum,
                attrs: dp.attributes as Record<string, string>,
              });
            }
          }
        }
      }
    }
    return datapoints;
  }

  it("METRICS-001: gauge records to histogram with given value", async () => {
    emitter.gauge(MetricNames.AssemblyDuration, 4200, "Milliseconds");
    const dps = await collect();
    const hist = dps.find((d) => d.name === "incident_response.assembly_duration_seconds");
    expect(hist).toBeDefined();
    expect(hist!.kind).toBe("histogram");
    expect(hist!.value).toBe(4200);
  });

  it("METRICS-002: increment adds 1 to counter", async () => {
    emitter.increment(MetricNames.DirectoryLookupFailureCount);
    emitter.increment(MetricNames.DirectoryLookupFailureCount);
    const dps = await collect();
    const counter = dps.find((d) => d.name === "incident_response.directory_lookup_failure_count");
    expect(counter).toBeDefined();
    expect(counter!.kind).toBe("counter");
    expect(counter!.value).toBe(2);
  });

  it("METRICS-003: duration records histogram sample in seconds", async () => {
    emitter.duration(MetricNames.ApprovalGateLatency, 0.087);
    const dps = await collect();
    const hist = dps.find((d) => d.name === "incident_response.approval_gate_latency_seconds");
    expect(hist).toBeDefined();
    expect(hist!.kind).toBe("histogram");
    expect(hist!.value).toBe(0.087);
  });

  it("METRICS-004: dimensions flow through as attributes", async () => {
    emitter.increment(MetricNames.StatuspagePublishCount, [
      { name: "outcome", value: "published" },
    ]);
    const dps = await collect();
    const counter = dps.find((d) => d.name === "incident_response.statuspage_publish_count");
    expect(counter!.attrs).toEqual({ outcome: "published" });
  });

  it("METRICS-005: no-dimension emit yields empty attribute map", async () => {
    emitter.increment(MetricNames.IncidentResolvedCount);
    const dps = await collect();
    const counter = dps.find((d) => d.name === "incident_response.incident_resolved_count");
    expect(counter!.attrs).toEqual({});
  });

  it("METRICS-006: separate dimension sets produce separate data points", async () => {
    emitter.increment(MetricNames.StatuspagePublishCount, [
      { name: "outcome", value: "published" },
    ]);
    emitter.increment(MetricNames.StatuspagePublishCount, [{ name: "outcome", value: "failed" }]);
    const dps = (await collect()).filter(
      (d) => d.name === "incident_response.statuspage_publish_count",
    );
    expect(dps).toHaveLength(2);
    expect(dps.map((d) => d.attrs.outcome).sort()).toEqual(["failed", "published"]);
  });

  it("METRICS-007: count adds the given amount rather than 1", async () => {
    // The distinction that makes token metering possible: a call is one event
    // but hundreds of tokens, and counting events cannot be turned into spend.
    emitter.count(MetricNames.ModelInputTokens, 1200);
    emitter.count(MetricNames.ModelInputTokens, 300);
    const dps = await collect();
    const c = dps.find((d) => d.name === "incident_response.model_input_tokens");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("counter");
    expect(c!.value).toBe(1500);
  });

  it("METRICS-008: count drops NaN rather than poisoning the series", async () => {
    // One NaN makes every downstream sum and rate over this series NaN, so it
    // is refused at the emitter rather than recorded.
    emitter.count(MetricNames.ModelOutputTokens, Number.NaN);
    const dps = await collect();
    expect(dps.find((d) => d.name === "incident_response.model_output_tokens")).toBeUndefined();
  });

  it("METRICS-009: count drops negatives, which a monotonic counter cannot hold", async () => {
    emitter.count(MetricNames.ModelOutputTokens, -5);
    const dps = await collect();
    expect(dps.find((d) => d.name === "incident_response.model_output_tokens")).toBeUndefined();
  });

  it("METRICS-010: count records a legitimate zero", async () => {
    // Zero is not absent: a fully cached call really did read zero fresh input
    // tokens, and suppressing it would hide the cache working.
    emitter.count(MetricNames.ModelCacheWriteTokens, 0);
    const dps = await collect();
    const c = dps.find((d) => d.name === "incident_response.model_cache_write_tokens");
    expect(c).toBeDefined();
    expect(c!.value).toBe(0);
  });
});
