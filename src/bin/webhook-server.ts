/**
 * Webhook server — the stateless ingress Deployment's entrypoint.
 *
 * Serves three signature-verified HTTP surfaces behind ingress-nginx, all on
 * PORT (default 3001):
 *   - Grafana OnCall webhook (HMAC-SHA256) → the Lambda-shaped
 *     src/handlers/webhook-ingress.ts handler → SQS enqueue.
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

import * as http from 'http';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { handler } from '../handlers/webhook-ingress.js';
import { verifySlackSignature } from '../handlers/slack-signature.js';
import {
  handleSlashCommand,
  handleInteraction,
  parseSlashCommand,
  parseInteraction,
  postToResponseUrl,
  type SlackInteractionDeps,
} from '../handlers/slack-interactions.js';
import { buildDependencies } from '../wiring/dependencies.js';
import { buildCommandRegistry } from '../wiring/commands.js';
import { logger } from '../utils/logger.js';
import { stringifyError } from '../utils/errors.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '3001', 10);
const SLACK_SIGNING_SECRET = process.env['SLACK_SIGNING_SECRET'] ?? '';

// Slack Request URLs served by this Deployment.
const SLACK_COMMANDS_PATH = '/slack/commands';
const SLACK_INTERACTIVITY_PATH = '/slack/interactivity';

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
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(',');
  }
  return out;
}

function buildLambdaEvent(req: http.IncomingMessage, body: string): APIGatewayProxyEventV2 {
  const path = req.url ?? '/';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: flattenHeaders(req.headers),
    requestContext: {
      accountId: 'k8s',
      apiId: 'k8s-webhook',
      domainName: req.headers.host ?? 'k8s-webhook.local',
      domainPrefix: 'k8s-webhook',
      http: {
        method: req.method ?? 'POST',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: req.socket.remoteAddress ?? '0.0.0.0',
        userAgent: req.headers['user-agent'] ?? '',
      },
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

function writeResult(res: http.ServerResponse, result: APIGatewayProxyResultV2): void {
  // The Lambda handler returns either a string (treated as 200 body) or an
  // APIGatewayProxyStructuredResultV2 object with statusCode/headers/body.
  if (typeof result === 'string') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(result);
    return;
  }
  res.statusCode = result.statusCode ?? 200;
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    res.setHeader(k, String(v));
  }
  res.end(result.body ?? '');
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
    signature: req.headers['x-slack-signature'] as string | undefined,
    timestamp: req.headers['x-slack-request-timestamp'] as string | undefined,
    rawBody,
  });
  if (!ok) {
    res.statusCode = 401;
    res.end('invalid signature');
  }
  return ok;
}

/** Ack Slack immediately (200), then run the work and post to `response_url`. */
function ackAndDefer(res: http.ServerResponse, work: () => Promise<void>): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end('');
  void work().catch((err) => logger.error({ error: stringifyError(err) }, 'slack handler error'));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz' || req.url === '/readyz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
    return;
  }

  // Only POST is meaningful — Grafana OnCall and Slack both POST. Reject
  // everything else cheaply.
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  const url = req.url ?? '';

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
      const event = buildLambdaEvent(req, body);
      try {
        const result = (await (
          handler as (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>
        )(event)) as APIGatewayProxyResultV2;
        writeResult(res, result);
      } catch (err) {
        logger.error({ error: stringifyError(err) }, 'webhook handler error');
        res.statusCode = 500;
        res.end('internal error');
      }
    })
    .catch((err: unknown) => {
      logger.error({ error: stringifyError(err) }, 'webhook body read error');
      res.statusCode = 400;
      res.end('bad request');
    });
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'webhook server listening');
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'webhook server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
