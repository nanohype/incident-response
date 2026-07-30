/**
 * Zod-validated environment configuration.
 *
 * Values with sane defaults live here so they are overridable per
 * environment without a code change. Required, no-default env vars
 * (tokens, table names, queue URLs) are asserted at startup by
 * `requireEnv` in src/index.ts — this module never exits a healthy
 * process over an optional value.
 */

import { z } from "zod";
import { logger } from "../utils/logger.js";

const ConfigSchema = z.object({
  // Bedrock model IDs — cross-region inference profiles. Bare foundation-model
  // IDs return "on-demand throughput isn't supported". Sonnet drafts status
  // pages + postmortem narrative; Haiku classifies IC messages.
  // The Platform's ModelGateway. Every model call goes here: the gateway holds
  // the AWS identity, applies each route's guardrail, and records the request.
  // The app holds no model credential.
  MODEL_GATEWAY_ENDPOINT: z
    .string()
    .url()
    // .url() alone accepts `host:8080` as a URL whose scheme is `host:`, which
    // the Messages client would only fail on at request time.
    .refine((v) => /^https?:\/\//.test(v), {
      message: "MODEL_GATEWAY_ENDPOINT must be an http(s) URL",
    }),
  // Route names on that gateway, not model ids. The ModelGateway CR maps each to
  // a concrete Bedrock model, so pinning a snapshot or moving to another
  // inference profile is a CR edit rather than an app config change.
  MODEL_ROUTE: z.string().min(1).default("default"),
  MODEL_ROUTE_LIGHT: z.string().min(1).default("light"),
  // MCP streamable-HTTP port — the read + draft pull surface the mcp-tunnel
  // routes to. Default 3002 to avoid colliding with the processor health
  // server and webhook server (both on 3001). Locked to the mcp-tunnel
  // namespace by the chart NetworkPolicy.
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  // Identity recorded as the CREATOR of an MCP-drafted Statuspage update. The
  // draft is only ever PENDING_APPROVAL — the human who clicks Approve &
  // Publish in Slack is the compliance-critical approver, and their id is what
  // threads into the publish audit trail. Claude Tag does not (yet) forward the
  // invoking human's identity to a custom-connector tool call, so the draft's
  // `createdBy` is this fixed service actor, never an LLM-supplied value.
  MCP_ACTOR_ID: z.string().min(1).default("claude-tag-mcp"),
});

function loadConfig(): z.infer<typeof ConfigSchema> {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, "Invalid configuration");
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof ConfigSchema>;
