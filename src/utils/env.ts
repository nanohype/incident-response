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
 * One place rather than four inlined reads, and deliberately without a default.
 * The region decides which account partition every DynamoDB, SQS, Secrets
 * Manager and Scheduler call lands in, and this service has no basis for
 * guessing it: the app is forkable (see docs/forking-for-a-new-client.md), so a
 * baked-in region is this estate's constraint shipped to someone who does not
 * share it. The deployment supplies it — chart/values.yaml sets AWS_REGION for
 * both Deployments — and a deploy that forgets fails at boot with this message
 * rather than silently addressing a region nobody chose.
 *
 * Throwing is the loud half of the same contract `requireEnv` enforces for the
 * other required variables. It is a throw rather than a requireEnv entry
 * because webhook-ingress constructs its three clients at module load, which
 * runs before any entrypoint statement could check.
 */
// An empty AWS_REGION is treated as unset. `??` would let "" through, and every
// SDK client in the process would then be constructed against region "", which
// fails at the first call with an error that names the SDK rather than the
// misconfiguration.
export function awsRegion(): string {
  const region = process.env.AWS_REGION;
  if (!region) {
    throw new Error(
      "AWS_REGION is not set. Every AWS client in this service needs it and there is no safe default — set it on the Deployment (chart/values.yaml sets it for both) or export it locally.",
    );
  }
  return region;
}
