/**
 * Unit tests for withTimeoutOrDefault — the app-side fallback flavour.
 * withTimeout itself is the vendored resilience module's contract, tested
 * upstream in nanohype/library/runtime/src/resilience.test.ts (and exercised
 * here transitively — the timeout path below rides on it).
 */

import { withTimeoutOrDefault } from '../../src/utils/with-timeout.js';

describe('withTimeoutOrDefault', () => {
  it('TOD-001: returns inner value when inner resolves in time', async () => {
    const result = await withTimeoutOrDefault(Promise.resolve('ok'), 1000, 'test', 'fallback');
    expect(result).toBe('ok');
  });

  it('TOD-002: returns fallback when inner times out', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    const result = await withTimeoutOrDefault(slow, 25, 'slow-op', 'fallback');
    expect(result).toBe('fallback');
  });

  it('TOD-003: returns fallback when inner rejects', async () => {
    const rejecting = Promise.reject<string>(new Error('inner boom'));
    const result = await withTimeoutOrDefault(rejecting, 1000, 'test', 'fallback');
    expect(result).toBe('fallback');
  });
});
