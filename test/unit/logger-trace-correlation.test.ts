/**
 * Verifies the logger stamps trace_id + span_id into JSON output when an OTel
 * span is active. This is what lets Grafana jump from a Tempo waterfall to the
 * matching Loki log line with one click.
 */

import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { logger } from '../../src/utils/logger.js';

describe('logger trace correlation', () => {
  let provider: BasicTracerProvider;
  let ctxMgr: AsyncHooksContextManager;
  let stdoutSpy: jest.SpyInstance;

  beforeAll(() => {
    ctxMgr = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(ctxMgr);
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    ctxMgr.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function lastWrittenLine(): Record<string, unknown> {
    const call = stdoutSpy.mock.calls.at(-1);
    expect(call).toBeDefined();
    return JSON.parse((call![0] as string).trim()) as Record<string, unknown>;
  }

  it('LOG-TRACE-001: stamps trace_id + span_id when a span is active', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('with-active-span');
    context.with(trace.setSpan(context.active(), span), () => {
      logger.info({ incident_id: 'inc-1' }, 'assembly step');
    });
    span.end();

    const entry = lastWrittenLine();
    expect(entry['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(entry['span_id']).toMatch(/^[0-9a-f]{16}$/);
    expect(entry['trace_id']).toBe(span.spanContext().traceId);
    expect(entry['incident_id']).toBe('inc-1');
  });

  it('LOG-TRACE-002: omits trace_id + span_id when no span is active', () => {
    logger.info({ incident_id: 'inc-2' }, 'no span here');
    const entry = lastWrittenLine();
    expect(entry).not.toHaveProperty('trace_id');
    expect(entry).not.toHaveProperty('span_id');
    expect(entry['incident_id']).toBe('inc-2');
  });

  it('LOG-TRACE-003: trace fields propagate through logger.child()', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('with-child');
    context.with(trace.setSpan(context.active(), span), () => {
      const child = logger.child({ incident_id: 'inc-3' });
      child.info('step');
    });
    span.end();

    const entry = lastWrittenLine();
    expect(entry['trace_id']).toBe(span.spanContext().traceId);
    expect(entry['incident_id']).toBe('inc-3');
    expect(entry['message']).toBe('step');
  });
});
