/**
 * Unit tests for withTimeout and withTimeoutOrDefault.
 */

import { withTimeout, withTimeoutOrDefault, TimeoutError } from '../../src/utils/with-timeout.js';

describe('withTimeout', () => {
  it('TO-001: resolves with inner value when inner resolves before deadline', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('TO-002: rejects with TimeoutError when inner does not settle in time', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(slow, 50, 'slow-op')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TO-003: propagates inner rejection unchanged', async () => {
    const rejecting = Promise.reject(new Error('inner boom'));
    await expect(withTimeout(rejecting, 1000, 'test')).rejects.toThrow('inner boom');
  });

  it('TO-004: TimeoutError message includes label and ms', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await withTimeout(slow, 25, 'my-op');
      fail('expected rejection');
    } catch (err) {
      expect((err as Error).message).toBe('my-op timed out after 25ms');
    }
  });
});

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
