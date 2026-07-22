/**
 * Webhook server — the stateless ingress Deployment's entrypoint.
 *
 * Serves three signature-verified HTTP surfaces behind the cluster ingress, all on
 * PORT (default 3001):
 *   - Grafana OnCall webhook (HMAC-SHA256) → the src/handlers/webhook-ingress.ts
 *     handler → SQS enqueue.
 *   - Slack slash commands (`POST /slack/commands`, Slack signing secret) →
 *     the CommandRegistry dispatch.
 *   - Slack Block Kit interactivity (`POST /slack/interactivity`, Slack signing
 *     secret) → approve / edit / silence / pulse. `statuspage_approve` runs the
 *     2-phase approval gate inline with the clicking human's id — a button click
 *     needs a synchronous ack, no reason to round-trip SQS.
 *
 * Slack posts interactions to a Request URL over signed HTTP, alongside the
 * Grafana OnCall HMAC path this Deployment already serves.
 */

import * as http from "node:http";
import {
  handleInteraction,
  handleSlashCommand,
  parseInteraction,
  parseSlashCommand,
  postToResponseUrl,
  type SlackInteractionDeps,
} from "../handlers/slack-interactions.js";
import { verifySlackSignature } from "../handlers/slack-signature.js";
import { handler, type WebhookResponse } from "../handlers/webhook-ingress.js";
import { stringifyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { buildCommandRegistry } from "../wiring/commands.js";
import { buildDependencies } from "../wiring/dependencies.js";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

// Slack Request URLs served by this Deployment.
const SLACK_COMMANDS_PATH = "/slack/commands";
const SLACK_INTERACTIVITY_PATH = "/slack/interactivity";

// Dependencies for the Slack surface — built once. The gate runs inline here on
// approve; drafting happens via MCP, but a human approves in Slack.
const deps = buildDependencies();
const slackDeps: SlackInteractionDeps = {
  commandRegistry: buildCommandRegistry(deps),
  approvalGate: deps.approvalGate,
  auditWriter: deps.auditWriter,
  dynamoDb: deps.dynamoDb,
  incidentsTableName: deps.incidentsTableName,
  slack: deps.slackWebClient,
  respondTo: postToResponseUrl,
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(",");
  }
  return out;
}

function writeResult(res: http.ServerResponse, result: WebhookResponse): void {
  res.statusCode = result.statusCode;
  res.setHeader("content-type", "application/json");
  res.end(result.body);
}

/**
 * Verify a Slack signing-secret signature over the raw body. Returns true if
 * the request is authentic and fresh; on failure writes a 401 and returns
 * false so the caller stops.
 */
function verifiedSlackRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
): boolean {
  const ok = verifySlackSignature({
    signingSecret: SLACK_SIGNING_SECRET,
    signature: req.headers["x-slack-signature"] as string | undefined,
    timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
    rawBody,
  });
  if (!ok) {
    res.statusCode = 401;
    res.end("invalid signature");
  }
  return ok;
}

/** Ack Slack immediately (200), then run the work and post to `response_url`. */
function ackAndDefer(res: http.ServerResponse, work: () => Promise<void>): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end("");
  void work().catch((err) => logger.error({ error: stringifyError(err) }, "slack handler error"));
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz" || req.url === "/readyz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"status":"ok"}');
    return;
  }

  // Only POST is meaningful — Grafana OnCall and Slack both POST. Reject
  // everything else cheaply.
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }

  const url = req.url ?? "";

  readBody(req)
    .then(async (body) => {
      // Slack slash commands.
      if (url.startsWith(SLACK_COMMANDS_PATH)) {
        if (!verifiedSlackRequest(req, res, body)) return;
        const command = parseSlashCommand(body);
        ackAndDefer(res, () => handleSlashCommand(slackDeps, command));
        return;
      }

      // Slack Block Kit interactivity.
      if (url.startsWith(SLACK_INTERACTIVITY_PATH)) {
        if (!verifiedSlackRequest(req, res, body)) return;
        const payload = parseInteraction(body);
        ackAndDefer(res, () => handleInteraction(slackDeps, payload));
        return;
      }

      // Grafana OnCall webhook (HMAC verified inside the handler).
      try {
        writeResult(res, await handler({ headers: flattenHeaders(req.headers), body }));
      } catch (err) {
        logger.error({ error: stringifyError(err) }, "webhook handler error");
        res.statusCode = 500;
        res.end("internal error");
      }
    })
    .catch((err: unknown) => {
      logger.error({ error: stringifyError(err) }, "webhook body read error");
      res.statusCode = 400;
      res.end("bad request");
    });
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, "webhook server listening");
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, "webhook server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
