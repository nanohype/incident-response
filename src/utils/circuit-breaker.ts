/**
 * Circuit breaker — protect external dependencies from retry storms.
 *
 * Wraps a slow/failing dependency. After `failureThreshold` failures within
 * `windowMs`, the circuit opens — subsequent calls reject immediately with
 * `CircuitOpenError` until `halfOpenAfterMs` has passed. The first call after
 * that probes; success closes the circuit, failure re-opens it.
 *
 * Used today around WorkOS directory lookups so a degraded directory doesn't
 * cause every P1 to thrash the API and cascade timeouts. Easy to wire around
 * any other external dependency the same way.
 */

import { logger } from './logger.js';
import { MetricNames, type MetricsEmitter } from './metrics.js';

export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError';
  constructor(public readonly circuit: string) {
    super(`Circuit "${circuit}" is open — request rejected without dispatch`);
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOpts {
  /** Identifier used in logs + metrics. */
  name: string;
  /** Open the circuit after this many failures within `windowMs`. */
  failureThreshold: number;
  /** Rolling window for counting failures (ms). */
  windowMs: number;
  /** How long the circuit stays open before allowing one probe call (ms). */
  halfOpenAfterMs: number;
  /** Optional metrics sink so circuit transitions surface in dashboards. */
  metrics?: MetricsEmitter;
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CircuitBreaker {
  exec<T>(fn: () => Promise<T>): Promise<T>;
  state(): CircuitState;
  /** Force-close (operator override). Clears failure history. */
  reset(): void;
}

export function createCircuitBreaker(opts: CircuitBreakerOpts): CircuitBreaker {
  const now = opts.now ?? Date.now;
  let state: CircuitState = 'closed';
  let failures: number[] = [];
  let openedAt = 0;

  function pruneOldFailures(t: number): void {
    const cutoff = t - opts.windowMs;
    failures = failures.filter((f) => f >= cutoff);
  }

  function open(t: number): void {
    state = 'open';
    openedAt = t;
    logger.warn({ circuit: opts.name, failure_count: failures.length, window_ms: opts.windowMs }, 'Circuit opened');
    opts.metrics?.increment(MetricNames.CircuitOpenCount, [{ name: 'circuit', value: opts.name }]);
  }

  function close(): void {
    state = 'closed';
    failures = [];
    logger.info({ circuit: opts.name }, 'Circuit closed');
  }

  function transitionToHalfOpenIfDue(t: number): void {
    if (state === 'open' && t - openedAt >= opts.halfOpenAfterMs) {
      state = 'half_open';
      logger.info({ circuit: opts.name }, 'Circuit half-open — probing next call');
    }
  }

  return {
    state(): CircuitState {
      transitionToHalfOpenIfDue(now());
      return state;
    },

    reset(): void {
      close();
    },

    async exec<T>(fn: () => Promise<T>): Promise<T> {
      const t = now();
      transitionToHalfOpenIfDue(t);

      if (state === 'open') {
        opts.metrics?.increment(MetricNames.CircuitOpenRejectCount, [{ name: 'circuit', value: opts.name }]);
        throw new CircuitOpenError(opts.name);
      }

      try {
        const result = await fn();
        if (state === 'half_open') close();
        return result;
      } catch (err) {
        if (state === 'half_open') {
          // Probe failed — re-open immediately, do not count toward threshold.
          open(t);
          throw err;
        }
        const failureTime = now();
        failures.push(failureTime);
        pruneOldFailures(failureTime);
        if (failures.length >= opts.failureThreshold) {
          open(failureTime);
        }
        throw err;
      }
    },
  };
}
