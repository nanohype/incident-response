/**
 * OTel tracing helpers.
 *
 * Auto-instrumentation (loaded via --require @opentelemetry/auto-instrumentations-node/register
 * at process start, see Dockerfile) traces http/fetch/aws-sdk automatically. This module adds:
 *   - `withSpan` wrapper for business-logic milestones (named spans with exception + error
 *     status recorded automatically)
 *   - SQS-attribute <-> W3C-context helpers so traces cross the Lambda → SQS → ECS hop
 *
 * The tracer name identifies this instrumentation library in Grafana Cloud Tempo.
 */

import { context, propagation, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { MessageAttributeValue as SqsMessageAttributeValue } from '@aws-sdk/client-sqs';

const TRACER_NAME = 'marshal';

export const tracer = trace.getTracer(TRACER_NAME);

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Inject the active trace context into an SQS MessageAttributes map.
 * Call at the send site so downstream consumers can continue the trace.
 */
export function injectSqsTraceAttributes(
  baseAttributes: Record<string, SqsMessageAttributeValue> = {},
): Record<string, SqsMessageAttributeValue> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const out: Record<string, SqsMessageAttributeValue> = { ...baseAttributes };
  for (const [key, value] of Object.entries(carrier)) {
    if (value) out[key] = { DataType: 'String', StringValue: value };
  }
  return out;
}

/**
 * Extract trace context from an SQS MessageAttributes map into an OTel context.
 * Returns the parent context that callers should `context.with(parent, handler)` through.
 */
export function extractSqsTraceContext(
  messageAttributes: Record<string, SqsMessageAttributeValue> | undefined,
): ReturnType<typeof propagation.extract> {
  const carrier: Record<string, string> = {};
  if (messageAttributes) {
    for (const [key, value] of Object.entries(messageAttributes)) {
      if (value?.StringValue) carrier[key] = value.StringValue;
    }
  }
  return propagation.extract(context.active(), carrier);
}

export { context, trace };
