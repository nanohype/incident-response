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
 * Read a required variable, throwing rather than substituting a guess.
 *
 * For values read after `requireEnv` has already run: the throw is the
 * invariant stated in code rather than asserted with `!`, which typechecks
 * identically whether or not anything actually guarantees it.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — it has no safe default.`);
  return value;
}

/**
 * The environment both Deployments need, because both build the whole
 * dependency graph: the webhook serves the slash commands, and `/resolve`
 * reaches Bedrock, Linear, GitHub and the scheduler exactly as the processor
 * does. A list per entrypoint drifted once already — the processor validated
 * these and the webhook validated nothing — so there is one list and each
 * entrypoint names what it adds.
 */
export const REQUIRED_ENV_SHARED = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "GRAFANA_ONCALL_TOKEN",
  "GRAFANA_CLOUD_TOKEN",
  "GRAFANA_CLOUD_ORG_ID",
  "STATUSPAGE_API_KEY",
  "STATUSPAGE_PAGE_ID",
  "LINEAR_API_KEY",
  "LINEAR_PROJECT_ID",
  "LINEAR_TEAM_ID",
  "WORKOS_API_KEY",
  "WORKOS_DIRECTORY_ID",
  "INCIDENTS_TABLE_NAME",
  "AUDIT_TABLE_NAME",
  "INCIDENT_EVENTS_QUEUE_URL",
  "NUDGE_EVENTS_QUEUE_URL",
  "NUDGE_EVENTS_QUEUE_ARN",
  "SLA_CHECK_QUEUE_URL",
  "SCHEDULER_ROLE_ARN",
  "SCHEDULER_GROUP_NAME",
  "AWS_REGION",
] as const;

/**
 * The webhook Deployment additionally verifies the Grafana OnCall HMAC, and
 * fetches that signing secret through its own pod grant rather than the
 * chart's ExternalSecret — so it needs the secret's id where the processor
 * does not.
 */
export const REQUIRED_ENV_WEBHOOK = [
  ...REQUIRED_ENV_SHARED,
  "GRAFANA_ONCALL_HMAC_SECRET_ID",
] as const;

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
