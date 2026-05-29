/**
 * Unit tests for MetricsEmitter — validates OTel counter/histogram recording.
 *
 * Uses an in-memory metric reader so we can introspect the recorded data points
 * without standing up a real OTLP pipeline.
 */

import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

import { MetricsEmitter, MetricNames } from '../../src/utils/metrics.js';

describe('MetricsEmitter', () => {
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
    const datapoints: Array<{ name: string; kind: 'counter' | 'histogram'; value: number; attrs: Record<string, string> }> = [];
    for (const batch of batches) {
      for (const scope of batch.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const dp of metric.dataPoints) {
            const value = dp.value as number | { sum: number };
            if (typeof value === 'number') {
              datapoints.push({ name: metric.descriptor.name, kind: 'counter', value, attrs: dp.attributes as Record<string, string> });
            } else {
              datapoints.push({
                name: metric.descriptor.name,
                kind: 'histogram',
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

  it('METRICS-001: gauge records to histogram with given value', async () => {
    emitter.gauge(MetricNames.AssemblyDurationMs, 4200, 'Milliseconds');
    const dps = await collect();
    const hist = dps.find((d) => d.name === 'assembly_duration_ms');
    expect(hist).toBeDefined();
    expect(hist!.kind).toBe('histogram');
    expect(hist!.value).toBe(4200);
  });

  it('METRICS-002: increment adds 1 to counter', async () => {
    emitter.increment(MetricNames.DirectoryLookupFailureCount);
    emitter.increment(MetricNames.DirectoryLookupFailureCount);
    const dps = await collect();
    const counter = dps.find((d) => d.name === 'directory_lookup_failure_count');
    expect(counter).toBeDefined();
    expect(counter!.kind).toBe('counter');
    expect(counter!.value).toBe(2);
  });

  it('METRICS-003: durationMs records histogram sample in ms', async () => {
    emitter.durationMs(MetricNames.ApprovalGateLatencyMs, 87);
    const dps = await collect();
    const hist = dps.find((d) => d.name === 'approval_gate_latency_ms');
    expect(hist).toBeDefined();
    expect(hist!.kind).toBe('histogram');
    expect(hist!.value).toBe(87);
  });

  it('METRICS-004: dimensions flow through as attributes', async () => {
    emitter.increment(MetricNames.StatuspagePublishCount, [{ name: 'outcome', value: 'published' }]);
    const dps = await collect();
    const counter = dps.find((d) => d.name === 'statuspage_publish_count');
    expect(counter!.attrs).toEqual({ outcome: 'published' });
  });

  it('METRICS-005: no-dimension emit yields empty attribute map', async () => {
    emitter.increment(MetricNames.IncidentResolvedCount);
    const dps = await collect();
    const counter = dps.find((d) => d.name === 'incident_resolved_count');
    expect(counter!.attrs).toEqual({});
  });

  it('METRICS-006: separate dimension sets produce separate data points', async () => {
    emitter.increment(MetricNames.StatuspagePublishCount, [{ name: 'outcome', value: 'published' }]);
    emitter.increment(MetricNames.StatuspagePublishCount, [{ name: 'outcome', value: 'failed' }]);
    const dps = (await collect()).filter((d) => d.name === 'statuspage_publish_count');
    expect(dps).toHaveLength(2);
    expect(dps.map((d) => d.attrs['outcome']).sort()).toEqual(['failed', 'published']);
  });
});
