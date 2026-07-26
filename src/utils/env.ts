/**
 * Environment validation. Fail-fast on missing required variables.
 */

import { logger } from "./logger.js";

export function requireEnv(vars: readonly string[]): void {
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length === 0) return;
  for (const v of missing) logger.error({ missing_env: v }, `Required env not set: ${v}`);
  process.exit(1);
}

/**
 * The AWS region every SDK client in this service is constructed with.
 *
 * Inlined as `process.env.AWS_REGION ?? "us-west-2"` at four sites, which is one
 * duplication and one testability problem. The fallback arm is reachable only
 * when AWS_REGION is unset, and whether it is unset depends on the environment
 * the suite runs in — CI exports it, a developer shell usually does not — so at
 * a module-level client construction exactly one of the two arms is taken per
 * run and the other can never be covered. Here both are, from one place.
 */
// An empty AWS_REGION is treated as unset. `??` would let "" through, and every
// SDK client in the process would then be constructed against region "", which
// fails at the first call with an error that names the SDK rather than the
// misconfiguration.
export function awsRegion(): string {
  return process.env.AWS_REGION || "us-west-2";
}
