/**
 * Circuit breaker — wiring tests for the app-side instrumentation.
 *
 * The state machine itself (sliding window, half-open probe, reset) is the
 * vendored module's contract, tested upstream in
 * nanohype/library/runtime/src/circuit-breaker.test.ts. What this suite owns
 * is the app wrapper: metric emission on trips and fast-fail rejections,
 * and that state/reset/exec delegate to the vendored breaker.
 */

import { CircuitOpenError, createCircuitBreaker } from "../../src/utils/circuit-breaker.js";

function makeClock(start: number) {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

const FAIL = (): Promise<never> => Promise.reject(new Error("boom"));
const OK = (): Promise<string> => Promise.resolve("ok");

describe("createCircuitBreaker (instrumented wrapper)", () => {
  it("CB-WIRE-001: delegates the lifecycle — trips at threshold, half-open probe closes on success", async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow("boom");
    expect(cb.state()).toBe("closed");
    await expect(cb.exec(FAIL)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
    clock.advance(500);
    // Vendored semantics: state() is a pure read — the open→half_open
    // transition happens on the next exec after the cooldown, not on read.
    expect(cb.state()).toBe("open");
    await expect(cb.exec(OK)).resolves.toBe("ok");
    expect(cb.state()).toBe("closed");
  });

  it("CB-WIRE-002: emits circuit_open_count once per trip and circuit_open_reject_count per fast-fail", async () => {
    const clock = makeClock(0);
    const increment = vi.fn();
    const metrics = { increment } as unknown as import("../../src/utils/metrics.js").MetricsEmitter;
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
      metrics,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    expect(increment).toHaveBeenCalledWith("circuit_open_count", [
      { name: "circuit", value: "test" },
    ]);
    expect(increment).toHaveBeenCalledTimes(1);
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(increment).toHaveBeenCalledWith("circuit_open_reject_count", [
      { name: "circuit", value: "test" },
    ]);
    expect(increment).toHaveBeenCalledTimes(3); // 1 trip + 2 rejects
  });

  it("CB-WIRE-003: ordinary failures do NOT emit the reject metric", async () => {
    const clock = makeClock(0);
    const increment = vi.fn();
    const metrics = { increment } as unknown as import("../../src/utils/metrics.js").MetricsEmitter;
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 5,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
      metrics,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow("boom");
    expect(increment).not.toHaveBeenCalled();
  });

  it("CB-WIRE-004: works without a metrics sink and without an injected clock", async () => {
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 1,
      windowMs: 1000,
      halfOpenAfterMs: 500,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow("boom");
    expect(cb.state()).toBe("open");
    cb.reset();
    expect(cb.state()).toBe("closed");
    await expect(cb.exec(OK)).resolves.toBe("ok");
  });
});
