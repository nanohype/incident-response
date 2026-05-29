/**
 * Structured JSON logger for Marshal.
 * Correlation IDs thread through all log entries keyed by incident_id.
 * When an OTel span is active, trace_id + span_id are stamped so Grafana's
 * Tempo → Loki correlation jump works one-click.
 */

import { trace } from '@opentelemetry/api';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  incident_id?: string;
  correlation_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLevel(): LogLevel {
  const level = process.env['LOG_LEVEL'] as LogLevel | undefined;
  if (level && LOG_LEVELS[level] !== undefined) return level;
  return 'info';
}

function traceFields(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

function log(level: LogLevel, context: Record<string, unknown> | string, message?: string): void {
  const configuredLevel = getCurrentLevel();
  if (LOG_LEVELS[level] < LOG_LEVELS[configuredLevel]) return;

  const trc = traceFields();
  let entry: LogEntry;
  if (typeof context === 'string') {
    entry = { level, timestamp: new Date().toISOString(), message: context, ...trc };
  } else {
    entry = { level, timestamp: new Date().toISOString(), message: message ?? '', ...trc, ...context };
  }

  const output = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  debug: (context: Record<string, unknown> | string, message?: string) => log('debug', context, message),
  info: (context: Record<string, unknown> | string, message?: string) => log('info', context, message),
  warn: (context: Record<string, unknown> | string, message?: string) => log('warn', context, message),
  error: (context: Record<string, unknown> | string, message?: string) => log('error', context, message),
  child: (base: Record<string, unknown>) => ({
    debug: (context: Record<string, unknown> | string, message?: string) => {
      const ctx = typeof context === 'string' ? { ...base } : { ...base, ...context };
      log('debug', ctx, typeof context === 'string' ? context : message);
    },
    info: (context: Record<string, unknown> | string, message?: string) => {
      const ctx = typeof context === 'string' ? { ...base } : { ...base, ...context };
      log('info', ctx, typeof context === 'string' ? context : message);
    },
    warn: (context: Record<string, unknown> | string, message?: string) => {
      const ctx = typeof context === 'string' ? { ...base } : { ...base, ...context };
      log('warn', ctx, typeof context === 'string' ? context : message);
    },
    error: (context: Record<string, unknown> | string, message?: string) => {
      const ctx = typeof context === 'string' ? { ...base } : { ...base, ...context };
      log('error', ctx, typeof context === 'string' ? context : message);
    },
  }),
};
