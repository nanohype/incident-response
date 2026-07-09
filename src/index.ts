/**
 * incident-response processor — the singleton worker Deployment's entrypoint.
 *
 * Runs as a single-replica Kubernetes Deployment (Recreate strategy): the SQS
 * consumer + war-room assembler + nudge scheduler are stateful single-writer
 * work, and the streamable-HTTP MCP server (the tunnel target) rides alongside
 * them. It wires dependencies, registers the SQS event handlers, starts the SQS
 * consumer, the MCP server, and a health server for k8s probes.
 *
 * The Slack surface lives elsewhere: slash commands + Block Kit interactivity
 * are signature-verified HTTP on the webhook Deployment (see
 * src/handlers/slack-interactions.ts).
 */

import * as http from 'http';

import { logger } from './utils/logger.js';
import { requireEnv } from './utils/env.js';
import { config } from './config/index.js';
import { buildDependencies } from './wiring/dependencies.js';
import { buildIncidentEventRegistry, buildNudgeEventRegistry } from './wiring/events.js';
import { SqsConsumer } from './services/sqs-consumer.js';
import { createMcpHttpServer } from './mcp/server.js';
import { stringifyError } from './utils/errors.js';

requireEnv([
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'GRAFANA_ONCALL_TOKEN',
  'GRAFANA_CLOUD_TOKEN',
  'GRAFANA_CLOUD_ORG_ID',
  'STATUSPAGE_API_KEY',
  'STATUSPAGE_PAGE_ID',
  'LINEAR_API_KEY',
  'LINEAR_PROJECT_ID',
  'LINEAR_TEAM_ID',
  'WORKOS_API_KEY',
  'WORKOS_DIRECTORY_ID',
  'INCIDENTS_TABLE_NAME',
  'AUDIT_TABLE_NAME',
  'INCIDENT_EVENTS_QUEUE_URL',
  'NUDGE_EVENTS_QUEUE_URL',
  'NUDGE_EVENTS_QUEUE_ARN',
  'SLA_CHECK_QUEUE_URL',
  'SCHEDULER_ROLE_ARN',
  'SCHEDULER_GROUP_NAME',
  'AWS_REGION',
]);

const deps = buildDependencies();
const incidentEvents = buildIncidentEventRegistry(deps);
const nudgeEvents = buildNudgeEventRegistry(deps);

const sqsConsumer = new SqsConsumer(
  process.env['INCIDENT_EVENTS_QUEUE_URL']!,
  process.env['NUDGE_EVENTS_QUEUE_URL']!,
  (m) => incidentEvents.dispatch(m),
  (m) => nudgeEvents.dispatch(m),
);

// The read + draft MCP pull surface. Draft-only: `createDraft` is reachable,
// approve/publish/resolve are not — those stay human-attributed on the Slack
// signed-HTTP surface (see src/handlers/slack-interactions.ts).
const mcpServer = createMcpHttpServer({
  docClient: deps.dynamoDb,
  incidentsTableName: deps.incidentsTableName,
  auditTableName: process.env['AUDIT_TABLE_NAME']!,
  approvalGate: deps.approvalGate,
  incidentResponseAI: deps.incidentResponseAI,
  draftActorId: config.MCP_ACTOR_ID,
});

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'incident-response-processor' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(3001, () => {
  logger.info('Health check server listening on :3001');
});

async function main(): Promise<void> {
  await mcpServer.listen(config.MCP_PORT);
  sqsConsumer.start();
  logger.info(
    {
      mcp_port: config.MCP_PORT,
      incident_events: incidentEvents.registeredTypes(),
      nudge_events: nudgeEvents.registeredTypes(),
    },
    'incident-response processor started',
  );
}

main().catch((err) => {
  logger.error({ error: stringifyError(err) }, 'Fatal startup error');
  process.exit(1);
});

// Graceful shutdown with a bounded drain. Kubernetes sends SIGTERM, waits
// `terminationGracePeriodSeconds` (60s on the processor Deployment), then
// SIGKILLs. We give ourselves 25s inside that window to stop the SQS poll loop,
// finish the in-flight handler, and close the MCP + health servers. A single
// wedged handler must not block a rolling deploy — the hard timeout ensures
// process.exit fires no matter what.
const SHUTDOWN_DRAIN_MS = 25_000;
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — draining');
  const forceExit = setTimeout(() => {
    logger.warn({ drain_ms: SHUTDOWN_DRAIN_MS }, 'Drain deadline exceeded — force-exiting');
    process.exit(1);
  }, SHUTDOWN_DRAIN_MS);
  // Give this timer zero keep-alive weight so a quick, clean shutdown isn't
  // held open for the full drain window just because the timer is pending.
  forceExit.unref();

  void (async () => {
    try {
      sqsConsumer.stop();
      await mcpServer.close();
      healthServer.close();
      logger.info('Drain complete');
      process.exit(0);
    } catch (err) {
      logger.error({ error: stringifyError(err) }, 'Drain failed');
      process.exit(1);
    }
  })();
});
