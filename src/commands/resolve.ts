/**
 * /marshal resolve — the full resolution flow.
 *
 * Steps (all AWAITED; partial failure is logged + audited but does not silently proceed):
 *   1. Load incident record from DynamoDB
 *   2. Ask MarshalAI for postmortem sections (Bedrock; falls back to template on failure)
 *   3. Create Linear postmortem draft (@linear/sdk) with 48h SLA deadline
 *   4. Delete the nudge schedule (stop pinging the IC for status updates)
 *   5. Post pulse-rating blocks to the channel
 *   6. Mark incident RESOLVED in DynamoDB; write INCIDENT_RESOLVED + POSTMORTEM_CREATED audit events
 *
 * If any external step fails, the IC is told what worked and what didn't. No silent stubs.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CommandContext, CommandHandler } from '../services/command-registry.js';
import type { MarshalAI, PostmortemInput } from '../ai/marshal-ai.js';
import type { LinearMarshalClient } from '../clients/linear-client.js';
import type { GitHubClient } from '../clients/github-client.js';
import type { NudgeScheduler } from '../services/nudge-scheduler.js';
import type { AuditWriter } from '../utils/audit.js';
import type { MetricsEmitter } from '../utils/metrics.js';
import { MetricNames } from '../utils/metrics.js';
import { buildPulseRatingBlocks } from '../services/slack-blocks.js';
import type { IncidentRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { withTimeoutOrDefault } from '../utils/with-timeout.js';

export interface ResolveDeps {
  docClient: DynamoDBDocumentClient;
  incidentsTableName: string;
  marshalAI: MarshalAI;
  linearClient: LinearMarshalClient;
  githubClient: GitHubClient;
  nudgeScheduler: NudgeScheduler;
  auditWriter: AuditWriter;
  githubRepoNames: string[];
  metrics?: MetricsEmitter;
}

const POSTMORTEM_DURATION_FALLBACK_MINUTES = 30;

function durationMinutes(created_at: string): number {
  const minutes = Math.round((Date.now() - new Date(created_at).getTime()) / 60000);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : POSTMORTEM_DURATION_FALLBACK_MINUTES;
}

export function makeResolveHandler(deps: ResolveDeps): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    const log = logger.child({ incident_id: ctx.incidentId, command: 'resolve' });

    // Step 1: load incident
    const incidentResult = await deps.docClient.send(
      new GetCommand({
        TableName: deps.incidentsTableName,
        Key: { PK: `INCIDENT#${ctx.incidentId}`, SK: 'METADATA' },
      }),
    );
    const incident = incidentResult.Item as IncidentRecord | undefined;
    if (!incident) {
      await ctx.respond({
        text: `❌ No active incident found for this channel. If this IS an incident, Grafana OnCall hasn't finished propagating — wait 30s and retry.`,
      });
      return;
    }
    if (incident.status === 'RESOLVED') {
      await ctx.respond({
        text: `ℹ️ Incident ${ctx.incidentId} is already resolved. Postmortem: ${incident.linear_postmortem_id ?? 'not linked'}.`,
      });
      return;
    }

    await ctx.respond({ text: `🔔 Resolution started by <@${ctx.userId}>. Generating postmortem and closing the room...` });

    // Step 2: fetch recent commits for the postmortem deploy timeline (best-effort)
    const recentDeploys: string[] = [];
    for (const repo of deps.githubRepoNames) {
      const commits = await withTimeoutOrDefault(
        deps.githubClient.getRecentCommits(repo, ctx.incidentId),
        5000,
        `github.getRecentCommits:${repo}`,
        [],
        ctx.incidentId,
      );
      for (const c of commits) recentDeploys.push(`${c.timestamp} • ${c.sha} • ${c.author} • ${c.message} (${repo})`);
    }

    // Step 3: generate postmortem sections via Bedrock (MarshalAI has its own fallback template)
    const pmInput: PostmortemInput = {
      incident_id: incident.incident_id,
      title: incident.alert_payload?.alert_group?.title ?? 'P1 Incident',
      slack_channel_name: incident.slack_channel_name ?? '(unknown)',
      duration_minutes: durationMinutes(incident.created_at),
      timeline_events: [],
      participants: incident.responders.map((u) => ({ name: u, role: 'responder' })),
      metrics_summary: incident.context_snapshot
        ? `error rate ${(incident.context_snapshot.error_rate_2h.current * 100).toFixed(2)}%, p99 ${incident.context_snapshot.p99_latency_ms.current.toFixed(0)}ms`
        : 'no context snapshot captured',
      recent_deploys: recentDeploys,
      statuspage_updates: [],
    };
    const postmortemBody = await deps.marshalAI.generatePostmortemSections(pmInput, ctx.incidentId);

    // Step 4: create Linear postmortem draft
    let linearDraft: Awaited<ReturnType<LinearMarshalClient['createPostmortemDraft']>> | undefined;
    try {
      linearDraft = await deps.linearClient.createPostmortemDraft(
        incident.incident_id,
        pmInput.title,
        postmortemBody,
        ctx.userId,
        incident.slack_channel_name,
        new Date(incident.created_at),
      );
      await deps.auditWriter.write(incident.incident_id, ctx.userId, 'POSTMORTEM_CREATED', {
        linear_issue_id: linearDraft.linear_issue_id,
        linear_issue_url: linearDraft.linear_issue_url,
        sla_deadline: linearDraft.sla_deadline,
      });
      deps.metrics?.increment(MetricNames.PostmortemCreatedCount);
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 'Linear postmortem creation failed — IC must create manually');
    }

    // Step 5: stop pinging the IC
    await deps.nudgeScheduler.deleteNudge(incident.incident_id);

    // Step 6: post pulse rating for UX research
    await withTimeoutOrDefault(
      ctx.slack.chat.postMessage({
        channel: ctx.channelId,
        blocks: buildPulseRatingBlocks(incident.incident_id),
        text: '🎉 Incident resolved — how did Marshal do?',
      }),
      7500,
      'slack.chat.postMessage:pulse-rating',
      undefined,
      incident.incident_id,
    );

    // Step 7: flip incident status + audit
    await deps.docClient.send(
      new UpdateCommand({
        TableName: deps.incidentsTableName,
        Key: { PK: `INCIDENT#${incident.incident_id}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #status = :status, resolved_at = :resolved_at, updated_at = :updated_at' +
          (linearDraft ? ', linear_postmortem_id = :pm' : ''),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'RESOLVED',
          ':resolved_at': new Date().toISOString(),
          ':updated_at': new Date().toISOString(),
          ...(linearDraft && { ':pm': linearDraft.linear_issue_id }),
        },
      }),
    );
    await deps.auditWriter.write(incident.incident_id, ctx.userId, 'INCIDENT_RESOLVED', {
      resolved_at: new Date().toISOString(),
      linear_issue_id: linearDraft?.linear_issue_id,
      had_postmortem: Boolean(linearDraft),
    });
    deps.metrics?.increment(MetricNames.IncidentResolvedCount, [{ name: 'had_postmortem', value: String(Boolean(linearDraft)) }]);

    // Step 8: final public announcement in the channel BEFORE archive so
    // members have a visible record of the postmortem link. The ephemeral
    // respond() below is only visible to the IC.
    await withTimeoutOrDefault(
      ctx.slack.chat.postMessage({
        channel: ctx.channelId,
        text: linearDraft
          ? `✅ Incident resolved by <@${ctx.userId}>. Postmortem: <${linearDraft.linear_issue_url}|${linearDraft.linear_issue_id}>. This channel is being archived.`
          : `✅ Incident resolved by <@${ctx.userId}>. Linear postmortem creation failed — create manually. This channel is being archived.`,
      }),
      7500,
      'slack.chat.postMessage:resolution-announce',
      undefined,
      incident.incident_id,
    );

    // Step 9: archive the war room. Best-effort — a resolved incident whose
    // channel didn't archive is a housekeeping issue, not a correctness one.
    try {
      await ctx.slack.conversations.archive({ channel: ctx.channelId });
      await deps.auditWriter.write(incident.incident_id, ctx.userId, 'WAR_ROOM_ARCHIVED', {
        channel_id: ctx.channelId,
        archived_at: new Date().toISOString(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ channel_id: ctx.channelId, error: errMsg }, 'Failed to archive war room channel');
      await deps.auditWriter.write(incident.incident_id, ctx.userId, 'WAR_ROOM_ARCHIVE_FAILED', {
        channel_id: ctx.channelId,
        error: errMsg,
      });
    }

    await ctx.respond({
      text: linearDraft
        ? `✅ Resolved. Postmortem draft: <${linearDraft.linear_issue_url}|${linearDraft.linear_issue_id}> — SLA deadline ${linearDraft.sla_deadline}.`
        : `⚠️ Resolved, but Linear postmortem creation failed. Create one manually and link it with \`/marshal link-postmortem <url>\` (v0.2).`,
    });
  };
}
