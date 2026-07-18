/**
 * Circuit breaker — app-side instrumentation over the vendored sliding-window
 * breaker (`src/vendor/runtime/circuit-breaker.ts`, source of truth in
 * nanohype `library/runtime`). The vendored module owns the state machine
 * (closed → open → half_open, injectable `now()`, single half-open probe) and
 * deliberately leaves observability to the consumer. This wrapper wires:
 *
 *   - closed→open trips → structured warn log + `circuit_open_count` metric
 *     (via the vendored `onOpen` hook, once per trip)
 *   - fast-fail rejections while open / during an in-flight probe →
 *     `circuit_open_reject_count` metric
 *
 * Used today around WorkOS directory lookups so a degraded directory doesn't
 * cause every P1 to thrash the API and cascade timeouts. Easy to wire around
 * any other external dependency the same way.
 */

import {
  type CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  createCircuitBreaker as createVendoredCircuitBreaker,
} from "../vendor/runtime/circuit-breaker.js";
import { logger } from "./logger.js";
import { MetricNames, type MetricsEmitter } from "./metrics.js";

export type { CircuitBreaker, CircuitState };
export { CircuitOpenError };

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

export function createCircuitBreaker(opts: CircuitBreakerOpts): CircuitBreaker {
  const breaker = createVendoredCircuitBreaker({
    name: opts.name,
    failureThreshold: opts.failureThreshold,
    windowMs: opts.windowMs,
    halfOpenAfterMs: opts.halfOpenAfterMs,
    ...(opts.now ? { now: opts.now } : {}),
    onOpen: (name) => {
      logger.warn(
        { circuit: name, failure_threshold: opts.failureThreshold, window_ms: opts.windowMs },
        "Circuit opened",
      );
      opts.metrics?.increment(MetricNames.CircuitOpenCount, [{ name: "circuit", value: name }]);
    },
  });

  return {
    state: (): CircuitState => breaker.state(),
    reset: (): void => breaker.reset(),
    async exec<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return await breaker.exec(fn);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          opts.metrics?.increment(MetricNames.CircuitOpenRejectCount, [
            { name: "circuit", value: opts.name },
          ]);
        }
        throw err;
      }
    },
  };
}
