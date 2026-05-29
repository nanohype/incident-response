/**
 * Unit tests for the OTel tracing helpers.
 * Validates span lifecycle + SQS MessageAttributes <-> W3C context round-trip.
 */

import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { extractSqsTraceContext, injectSqsTraceAttributes, withSpan } from '../../src/utils/tracing.js';

describe('tracing helpers', () => {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;
  let contextManager: AsyncHooksContextManager;

  beforeAll(() => {
    contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterAll(async () => {
    contextManager.disable();
    await provider.shutdown();
  });
  beforeEach(() => {
    exporter.reset();
  });

  describe('withSpan', () => {
    it('TRACE-001: ends span and records OK status on success', async () => {
      const result = await withSpan('test.op', async () => 'done', { key: 'v' });
      expect(result).toBe('done');
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('test.op');
      expect(spans[0]!.attributes['key']).toBe('v');
      expect(spans[0]!.status.code).toBe(1); // OK
    });

    it('TRACE-002: records exception + ERROR status, then rethrows', async () => {
      await expect(
        withSpan('test.fail', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(2); // ERROR
      expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('TRACE-003: handles non-Error throws', async () => {
      await expect(
        withSpan('test.throw-string', async () => {
          throw 'oops';
        }),
      ).rejects.toBe('oops');
      const spans = exporter.getFinishedSpans();
      expect(spans[0]!.status.code).toBe(2);
    });
  });

  describe('SQS trace propagation', () => {
    it('SQS-PROP-001: inject produces traceparent in MessageAttributes', async () => {
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('producer');
      const attrs = context.with(trace.setSpan(context.active(), span), () => injectSqsTraceAttributes());
      span.end();

      expect(attrs['traceparent']).toBeDefined();
      expect(attrs['traceparent']!.DataType).toBe('String');
      expect(attrs['traceparent']!.StringValue).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });

    it('SQS-PROP-002: extract returns context that child spans parent to', async () => {
      const tracer = trace.getTracer('test');
      const producerSpan = tracer.startSpan('producer');
      const producerSpanCtx = producerSpan.spanContext();
      const attrs = context.with(trace.setSpan(context.active(), producerSpan), () => injectSqsTraceAttributes());
      producerSpan.end();

      const parentCtx = extractSqsTraceContext(attrs);
      await context.with(parentCtx, async () => {
        await withSpan('consumer.handle', async () => {});
      });

      const spans = exporter.getFinishedSpans();
      const consumerSpan = spans.find((s) => s.name === 'consumer.handle');
      expect(consumerSpan).toBeDefined();
      expect(consumerSpan!.spanContext().traceId).toBe(producerSpanCtx.traceId);
    });

    it('SQS-PROP-003: extract from undefined attributes returns a context that yields a root span', async () => {
      const parentCtx = extractSqsTraceContext(undefined);
      await context.with(parentCtx, async () => {
        await withSpan('root.op', async () => {});
      });
      const spans = exporter.getFinishedSpans();
      const rootSpan = spans.find((s) => s.name === 'root.op');
      expect(rootSpan).toBeDefined();
      // No parent — parentSpanId is undefined on root spans
      expect(rootSpan!.parentSpanContext?.spanId).toBeUndefined();
    });

    it('SQS-PROP-004: preserves existing MessageAttributes when injecting', () => {
      const existing = { custom: { DataType: 'String' as const, StringValue: 'value' } };
      const attrs = injectSqsTraceAttributes(existing);
      expect(attrs['custom']).toEqual(existing.custom);
    });
  });
});
