/**
 * withTimeout — race a promise against a deadline.
 * Non-critical Slack calls use this so a wedged API can't stall war-room assembly.
 */

import { logger } from './logger.js';

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with TimeoutError if `promise` does not settle within `ms`.
 * The underlying promise is NOT cancelled (JS limitation) — the caller just stops waiting.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a non-critical operation with a timeout; swallow failure as a warn-log and return fallback.
 * Used in war-room assembly for ops like pinning the checklist — if Slack wedges, assembly continues.
 */
export async function withTimeoutOrDefault<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  fallback: T,
  incidentId?: string,
): Promise<T> {
  try {
    return await withTimeout(promise, ms, label);
  } catch (err) {
    logger.warn(
      { incident_id: incidentId, label, timeout_ms: ms, error: err instanceof Error ? err.message : String(err) },
      `Non-critical op failed or timed out — continuing with fallback`,
    );
    return fallback;
  }
}
