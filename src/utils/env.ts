/**
 * Environment validation. Fail-fast on missing required variables.
 */

import { logger } from './logger.js';

export function requireEnv(vars: readonly string[]): void {
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length === 0) return;
  for (const v of missing) logger.error({ missing_env: v }, `Required env not set: ${v}`);
  process.exit(1);
}
