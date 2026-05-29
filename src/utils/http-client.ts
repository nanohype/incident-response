/**
 * Base HTTP client — 5s timeout hard cap, retry-with-jitter max 2 attempts.
 * All external Marshal clients use this. Fast-fail preferred over silent retry loops.
 */

import { ExternalClientTimeoutError } from '../types/index.js';
import { logger } from './logger.js';
import { MetricNames, type MetricsEmitter } from './metrics.js';

// Module-scoped metrics sink so per-call sites don't have to plumb a
// MetricsEmitter through every client constructor. Wired once from the
// composition root (wiring/dependencies.ts → setHttpClientMetrics).
let metricsSink: MetricsEmitter | undefined;

export function setHttpClientMetrics(emitter: MetricsEmitter | undefined): void {
  metricsSink = emitter;
}

export interface HttpClientOptions {
  clientName: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number; // Hard capped at 5000ms
  maxRetries?: number; // Hard capped at 2
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  noRetry?: boolean;
}

export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  latency_ms: number;
  /** Response headers (lowercased keys). Populated for paginated APIs that use Link headers. */
  headers: Record<string, string>;
}

function jitteredDelay(attempt: number): number {
  const base = 100,
    cap = 1000;
  return Math.random() * Math.min(cap, base * Math.pow(2, attempt));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export class HttpClient {
  private readonly clientName: string;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: HttpClientOptions) {
    this.clientName = opts.clientName;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.timeoutMs = Math.min(opts.timeoutMs ?? 5000, 5000); // Hard cap
    this.maxRetries = Math.min(opts.maxRetries ?? 2, 2); // Hard cap
  }

  async request<T>(opts: HttpRequestOptions): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${opts.path}`;
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.defaultHeaders, ...opts.headers };
    let attempt = 0,
      lastError: Error | null = null;

    while (attempt <= (opts.noRetry ? 0 : this.maxRetries)) {
      const start = Date.now();
      if (attempt > 0) await new Promise((r) => setTimeout(r, jitteredDelay(attempt)));

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
          const init: RequestInit = { method, headers, signal: controller.signal };
          if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
          response = await fetch(url, init);
        } finally {
          clearTimeout(timer);
        }

        const latency_ms = Date.now() - start;
        logger.debug(
          { client: this.clientName, method, path: opts.path, status: response.status, latency_ms, attempt },
          'HTTP request completed',
        );

        let data: T;
        const ct = response.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          try {
            data = (await response.json()) as T;
          } catch {
            data = null as T;
          }
        } else {
          data = (await response.text()) as unknown as T;
        }

        if (!response.ok && isRetryableStatus(response.status) && !opts.noRetry && attempt < this.maxRetries) {
          attempt++;
          lastError = new Error(`${this.clientName} HTTP ${response.status}`);
          continue;
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        return { ok: response.ok, status: response.status, data, latency_ms, headers: responseHeaders };
      } catch (err: unknown) {
        const latency_ms = Date.now() - start;
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        if (isTimeout) {
          lastError = new ExternalClientTimeoutError(this.clientName, this.timeoutMs);
          logger.warn(
            { client: this.clientName, method, path: opts.path, timeout_ms: this.timeoutMs, attempt, latency_ms },
            'External client timeout',
          );
          metricsSink?.increment(MetricNames.HttpTimeoutCount, [
            { name: 'client', value: this.clientName },
            { name: 'method', value: method },
          ]);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn(
            { client: this.clientName, method, path: opts.path, error: lastError.message, attempt, latency_ms },
            'External client error',
          );
          metricsSink?.increment(MetricNames.HttpErrorCount, [
            { name: 'client', value: this.clientName },
            { name: 'method', value: method },
          ]);
        }
        if (attempt >= this.maxRetries || opts.noRetry) throw lastError;
        attempt++;
      }
    }
    throw lastError ?? new Error(`${this.clientName}: request failed after ${this.maxRetries} attempts`);
  }

  async get<T>(path: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    const opts: HttpRequestOptions = { method: 'GET', path };
    if (headers) opts.headers = headers;
    return this.request<T>(opts);
  }
  async post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    const opts: HttpRequestOptions = { method: 'POST', path, body };
    if (headers) opts.headers = headers;
    return this.request<T>(opts);
  }
  async put<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    const opts: HttpRequestOptions = { method: 'PUT', path, body };
    if (headers) opts.headers = headers;
    return this.request<T>(opts);
  }
}
