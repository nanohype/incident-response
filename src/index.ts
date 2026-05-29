/**
 * Marshal incident processor — long-running ECS Fargate entrypoint.
 * Wires dependencies, registers command + event handlers, starts Slack socket-mode + SQS consumer.
 */

import * as http from 'http';
import { App, LogLevel } from '@slack/bolt';

import { logger } from './utils/logger.js';
import { requireEnv } from './utils/env.js';
import { buildDependencies } from './wiring/dependencies.js';
import { buildCommandRegistry } from './wiring/commands.js';
import { buildIncidentEventRegistry, buildNudgeEventRegistry } from './wiring/events.js';
import { registerSlackActions } from './actions/register-slack-actions.js';
import { SqsConsumer } from './services/sqs-consumer.js';
import { SlashCommandTextSchema, SlashCommandArgsSchema } from './services/command-registry.js';
import { resolveIncidentByChannel } from './utils/incident-lookup.js';

// Subcommands that require an active war-room context. `help` does not — it
// should work anywhere in the workspace.
const CHANNEL_SCOPED_COMMANDS = new Set(['status', 'checklist', 'silence', 'resolve']);

requireEnv([
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'GRAFANA_ONCALL_TOKEN',
  'GRAFANA_CLOUD_TOKEN',
  'GRAFANA_CLOUD_ORG_ID',
  'STATUSPAGE_API_KEY',
  'STATUSPAGE_PAGE_ID',
  'LINEAR_API_KEY',
  'LINEAR_PROJECT_ID',
  'LINEAR_TEAM_ID',
  'WORKOS_API_KEY',
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
const commandRegistry = buildCommandRegistry(deps);
const incidentEvents = buildIncidentEventRegistry(deps);
const nudgeEvents = buildNudgeEventRegistry(deps);

const app = new App({
  token: process.env['SLACK_BOT_TOKEN']!,
  signingSecret: process.env['SLACK_SIGNING_SECRET']!,
  socketMode: true,
  appToken: process.env['SLACK_APP_TOKEN']!,
  logLevel: LogLevel.WARN,
  port: 3001,
});

app.command('/marshal', async ({ command, ack, respond, client }) => {
  await ack();
  const textParse = SlashCommandTextSchema.safeParse(command.text);
  if (!textParse.success) {
    await respond({ text: '❌ Command text too long. Keep it under 500 characters.' });
    return;
  }
  const tokens = textParse.data.trim().split(/\s+/);
  const argsParse = SlashCommandArgsSchema.safeParse(tokens.slice(1));
  if (!argsParse.success) {
    await respond({ text: '❌ Too many or oversized arguments. Keep it to 10 tokens, 100 chars each.' });
    return;
  }
  const subCommand = tokens[0] ?? '';
  const args = argsParse.data;
  await deps.auditWriter.write(command.channel_id, command.user_id, 'SLASH_COMMAND_RECEIVED', {
    command: subCommand,
    args,
    channel_id: command.channel_id,
  });

  // Resolve the Slack channel back to the canonical incident_id via the
  // slack-channel-index GSI. Channel-scoped commands require this; `help`
  // and anything unknown can run with the channel_id fallback so the
  // dispatcher still reaches the handler and produces the right reply.
  let resolvedIncidentId = command.channel_id;
  if (CHANNEL_SCOPED_COMMANDS.has(subCommand.toLowerCase())) {
    try {
      const incident = await resolveIncidentByChannel(deps.dynamoDb, deps.incidentsTableName, command.channel_id);
      if (incident) {
        resolvedIncidentId = incident.incident_id;
      } else {
        await respond({ text: 'No active incident found for this channel. Start one via Grafana OnCall.' });
        return;
      }
    } catch (err) {
      logger.error(
        { channel_id: command.channel_id, error: err instanceof Error ? err.message : String(err) },
        'Failed to resolve incident by channel',
      );
      await respond({ text: '❌ Internal error resolving incident for this channel. Check logs.' });
      return;
    }
  }

  await commandRegistry.dispatch({
    subCommand,
    args,
    incidentId: resolvedIncidentId,
    userId: command.user_id,
    channelId: command.channel_id,
    rawCommand: command,
    slack: client,
    respond,
  });
});

registerSlackActions(app, { approvalGate: deps.approvalGate, auditWriter: deps.auditWriter });

const sqsConsumer = new SqsConsumer(
  process.env['INCIDENT_EVENTS_QUEUE_URL']!,
  process.env['NUDGE_EVENTS_QUEUE_URL']!,
  (m) => incidentEvents.dispatch(m),
  (m) => nudgeEvents.dispatch(m),
);

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'marshal-processor' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(3001, () => {
  logger.info('Health check server listening on :3001');
});

async function main(): Promise<void> {
  await app.start();
  sqsConsumer.start();
  logger.info(
    {
      mode: 'socket',
      commands: commandRegistry.registeredCommands(),
      incident_events: incidentEvents.registeredTypes(),
      nudge_events: nudgeEvents.registeredTypes(),
    },
    'Marshal processor started',
  );
}

main().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal startup error');
  process.exit(1);
});

// Graceful shutdown with a bounded drain. ECS waits `stopTimeout` (default
// 30s, see infra/lib/marshal-stack.ts) after SIGTERM before SIGKILL. We give
// ourselves 25s inside that window to stop the SQS poll loop, finish the
// in-flight handler, and tell Bolt goodbye. A single wedged handler must not
// block a rolling deploy — the hard timeout ensures process.exit(0) fires no
// matter what.
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
      await app.stop();
      healthServer.close();
      logger.info('Drain complete');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Drain failed');
      process.exit(1);
    }
  })();
});
