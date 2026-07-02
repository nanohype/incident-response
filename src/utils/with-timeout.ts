/**
 * Deadline helpers. `withTimeout` (throws `TimeoutError` on deadline) comes
 * from the vendored resilience module (`src/vendor/runtime/resilience.ts`,
 * source of truth in nanohype `library/runtime`) and is re-exported so call
 * sites keep one import path. `withTimeoutOrDefault` is the app-side flavour:
 * swallow the failure as a warn log and return a fallback — used around
 * non-critical Slack calls so a wedged API can't stall war-room assembly.
 */

import { logger } from './logger.js';
import { stringifyError } from './errors.js';
import { withTimeout } from '../vendor/runtime/resilience.js';

export { withTimeout, TimeoutError } from '../vendor/runtime/resilience.js';

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
      { incident_id: incidentId, label, timeout_ms: ms, error: stringifyError(err) },
      `Non-critical op failed or timed out — continuing with fallback`,
    );
    return fallback;
  }
}
