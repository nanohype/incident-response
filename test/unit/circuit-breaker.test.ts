/**
 * Circuit breaker — unit tests.
 *
 * Asserts the closed → open → half_open → closed lifecycle, threshold
 * counting within the rolling window, and that a failed half-open probe
 * re-opens the circuit immediately.
 */

import { createCircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker.js';

function makeClock(start: number) {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

const FAIL = (): Promise<never> => Promise.reject(new Error('boom'));
const OK = (): Promise<string> => Promise.resolve('ok');

describe('createCircuitBreaker', () => {
  it('CB-001: stays closed when failures stay below threshold', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    expect(cb.state()).toBe('closed');
  });

  it('CB-002: opens once threshold is reached within the window', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    expect(cb.state()).toBe('open');
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('CB-003: prunes failures outside the rolling window', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    clock.advance(2000); // older failures fall outside windowMs
    await expect(cb.exec(FAIL)).rejects.toThrow();
    expect(cb.state()).toBe('closed');
  });

  it('CB-004: transitions to half_open after halfOpenAfterMs and closes on success', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    expect(cb.state()).toBe('open');
    clock.advance(500);
    expect(cb.state()).toBe('half_open');
    await expect(cb.exec(OK)).resolves.toBe('ok');
    expect(cb.state()).toBe('closed');
  });

  it('CB-005: re-opens immediately if the half_open probe fails', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    clock.advance(500);
    expect(cb.state()).toBe('half_open');
    await expect(cb.exec(FAIL)).rejects.toThrow('boom');
    expect(cb.state()).toBe('open');
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('CB-006: reset() force-closes regardless of failure history', async () => {
    const clock = makeClock(0);
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    expect(cb.state()).toBe('open');
    cb.reset();
    expect(cb.state()).toBe('closed');
    await expect(cb.exec(OK)).resolves.toBe('ok');
  });

  it('CB-007: emits circuit_open and circuit_open_reject metrics', async () => {
    const clock = makeClock(0);
    const increment = jest.fn();
    const metrics = { increment } as unknown as import('../../src/utils/metrics.js').MetricsEmitter;
    const cb = createCircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      windowMs: 1000,
      halfOpenAfterMs: 500,
      now: clock.now,
      metrics,
    });
    await expect(cb.exec(FAIL)).rejects.toThrow();
    await expect(cb.exec(FAIL)).rejects.toThrow();
    expect(increment).toHaveBeenCalledWith('circuit_open_count', [{ name: 'circuit', value: 'test' }]);
    await expect(cb.exec(OK)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(increment).toHaveBeenCalledWith('circuit_open_reject_count', [{ name: 'circuit', value: 'test' }]);
  });
});
