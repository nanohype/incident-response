/**
 * War Room Assembler — P1 alert → assembled war room (≤5 min target).
 * Parallel: directory group (WorkOS) + Grafana OnCall escalation chain + Grafana Cloud snapshot + GitHub.
 * Directory failure → explicit IC error, DIRECTORY_LOOKUP_FAILED audit event, zero fabricated invites.
 *
 * Slack I/O is funnelled through SlackAdapter so the timeout/fail-mode discipline
 * cannot be bypassed — domain code never holds a WebClient handle.
 */

import * as crypto from 'crypto';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { WorkOSClient } from '../clients/workos-client.js';
import { GrafanaOnCallClient } from '../clients/grafana-oncall-client.js';
import { GrafanaCloudClient } from '../clients/grafana-cloud-client.js';
import { AuditWriter } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { MetricsEmitter, MetricNames } from '../utils/metrics.js';
import { GrafanaOnCallAlertPayload, GrafanaContextSnapshot, IncidentRecord } from '../types/index.js';
import { buildChecklistBlocks, buildContextSnapshotBlocks } from './slack-blocks.js';
import { NudgeScheduler } from './nudge-scheduler.js';
import { withSpan } from '../utils/tracing.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';

// Slack call deadlines. Channel create is critical (assembly depends on it).
// Everything else is non-critical — budget < channel-create so a wedge doesn't cascade.
const SLACK_CHANNEL_CREATE_TIMEOUT_MS = 15000;
const SLACK_NON_CRITICAL_TIMEOUT_MS = 7500;
const SLACK_INVITE_TIMEOUT_MS = 7500;

const CHECKLIST_ITEMS = [
  'War room assembled',
  'IC confirmed',
  'Responders joined',
  'Initial severity assessed',
  'Customer impact identified',
  'Status page draft created',
  'Status page approved and published',
  'Incident mitigated',
  'All-clear confirmed',
  'Postmortem draft created',
  'Postmortem reviewed and published',
];

/**
 * Slack channel name for a war room. Always unique even when two incidents
 * share a prefix (real alerts with adjacent numeric IDs, or drills — every
 * drill ID starts with `drill-` so `substring(0,6)` would collide for every
 * pair on the same day, producing `name_taken` from conversations.create).
 *
 * Format: `marshal-p1-YYYYMMDD-<id-prefix>-<nonce>` where:
 *   - id-prefix is 12 chars of the sanitized incident_id (human-readable)
 *   - nonce is 6 hex chars of cryptographic randomness (~16M entropy)
 * The incident_id is the source of truth; the channel is looked up via the
 * slack-channel-index GSI, so operators never need to decode the nonce.
 * Slack channel name cap is 80 chars — this format stays well under.
 */
function channelName(id: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeId = id
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase()
    .slice(0, 12);
  const nonce = crypto.randomBytes(3).toString('hex');
  return `marshal-p1-${date}-${safeId}-${nonce}`;
}

export class WarRoomAssembler {
  constructor(
    private readonly slack: SlackAdapter,
    private readonly docClient: DynamoDBDocumentClient,
    private readonly incidentsTableName: string,
    private readonly directoryClient: WorkOSClient,
    private readonly grafanaOnCallClient: GrafanaOnCallClient,
    private readonly grafanaCloudClient: GrafanaCloudClient,
    private readonly auditWriter: AuditWriter,
    private readonly nudgeScheduler: NudgeScheduler,
    _githubOrgSlug: string,
    private readonly metrics?: MetricsEmitter,
  ) {
    void _githubOrgSlug;
  }

  async assemble(alert: GrafanaOnCallAlertPayload): Promise<IncidentRecord> {
    const incidentId = alert.alert_group_id;
    const log = logger.child({ incident_id: incidentId });
    log.info('Starting war room assembly');
    const start = Date.now();

    return withSpan('war_room.assemble', async (rootSpan) => {
      await this.updateIncidentStatus(incidentId, 'ROOM_ASSEMBLING');

      // Step 1: Create Slack private channel (critical — no room, no assembly)
      const channel = await withSpan('assemble.create_channel', () =>
        this.slack.createPrivateChannel(channelName(incidentId), {
          timeoutMs: SLACK_CHANNEL_CREATE_TIMEOUT_MS,
          label: 'slack.conversations.create',
        }),
      );
      rootSpan.setAttribute('slack.channel.id', channel.id);

      await this.auditWriter.write(incidentId, 'MARSHAL', 'WAR_ROOM_CREATED', {
        channel_id: channel.id,
        channel_name: channel.name,
        alert_payload: alert,
        assembly_start: new Date(start).toISOString(),
      });

      // Step 2: Parallel queries — responder directory + Grafana Cloud context snapshot.
      const [responderResult, contextResult] = await Promise.allSettled([
        withSpan('assemble.resolve_responders', () => this.resolveResponderEmails(alert, incidentId)),
        withSpan('assemble.context_snapshot', () => this.grafanaCloudClient.getContextSnapshot(alert.team_name, incidentId)),
      ]);

      let contextSnapshot: GrafanaContextSnapshot | undefined;
      if (contextResult.status === 'fulfilled') contextSnapshot = contextResult.value;
      else
        log.warn(
          { error: contextResult.reason instanceof Error ? contextResult.reason.message : String(contextResult.reason) },
          'Grafana Cloud context failed — proceeding without snapshot',
        );

      // Step 3: Invite responders (or fallback if the directory lookup failed)
      let invitedUserIds: string[] = [];
      let directoryFallback = false;

      if (responderResult.status === 'fulfilled') {
        invitedUserIds = await withSpan(
          'assemble.invite_responders',
          () => this.inviteResponders(channel.id, responderResult.value, incidentId),
          { responder_count: responderResult.value.length },
        );
      } else {
        directoryFallback = true;
        this.metrics?.increment(MetricNames.DirectoryLookupFailureCount);
        await this.auditWriter.write(incidentId, 'MARSHAL', 'DIRECTORY_LOOKUP_FAILED', {
          error: responderResult.reason instanceof Error ? responderResult.reason.message : String(responderResult.reason),
        });
        await this.auditWriter.write(incidentId, 'MARSHAL', 'ASSEMBLY_FALLBACK_INITIATED', { reason: 'Directory group lookup failed' });
      }

      // Step 4: Post context snapshot (non-critical; continue even if Slack is slow).
      // Audit event always written so the IC can tell whether the snapshot landed.
      const contextPostResult = await withSpan('assemble.post_context', () =>
        this.slack.postMessageNonCritical(
          {
            channel: channel.id,
            blocks: buildContextSnapshotBlocks(alert, contextSnapshot),
            text: `🚨 P1 Incident: ${alert.alert_group.title} | War room assembled`,
          },
          {
            timeoutMs: SLACK_NON_CRITICAL_TIMEOUT_MS,
            label: 'slack.chat.postMessage:context',
            incidentId,
          },
        ),
      );
      const contextAttached = !!contextPostResult?.ok;
      await this.auditWriter.write(incidentId, 'MARSHAL', 'CONTEXT_SNAPSHOT_ATTACHED', {
        channel_id: channel.id,
        attached: contextAttached,
        snapshot_present: contextSnapshot !== undefined,
        ...(contextSnapshot && { queried_at: contextSnapshot.queried_at }),
        ...(!contextAttached && { failure_reason: 'slack_post_failed_or_timed_out' }),
      });

      if (directoryFallback) {
        await this.slack.postMessageNonCritical(
          {
            channel: channel.id,
            text: '⚠️ *Responder auto-invite failed* — directory group lookup returned an error. Use `/marshal invite @user` to manually add responders.',
          },
          { timeoutMs: SLACK_NON_CRITICAL_TIMEOUT_MS, label: 'slack.chat.postMessage:directory-fallback', incidentId },
        );
      }

      // Step 5: Post + pin checklist (non-critical)
      const checklistMsg = await withSpan('assemble.pin_checklist', async () => {
        const msg = await this.slack.postMessageNonCritical(
          { channel: channel.id, blocks: buildChecklistBlocks(incidentId, CHECKLIST_ITEMS), text: '📋 Incident Checklist' },
          { timeoutMs: SLACK_NON_CRITICAL_TIMEOUT_MS, label: 'slack.chat.postMessage:checklist', incidentId },
        );
        if (msg?.ok && msg.ts) {
          await this.slack.pinMessage(channel.id, msg.ts, {
            timeoutMs: SLACK_NON_CRITICAL_TIMEOUT_MS,
            label: 'slack.pins.add',
            incidentId,
          });
          await this.auditWriter.write(incidentId, 'MARSHAL', 'CHECKLIST_PINNED', { channel_id: channel.id, message_ts: msg.ts });
        }
        return msg;
      });

      // Step 6: Schedule 15-min nudge
      await withSpan('assemble.schedule_nudge', () => this.nudgeScheduler.scheduleNudge(incidentId, channel.id));

      const incidentRecord: IncidentRecord = {
        incident_id: incidentId,
        status: 'ROOM_ASSEMBLED',
        severity: 'P1',
        alert_payload: alert,
        slack_channel_id: channel.id,
        slack_channel_name: channel.name,
        responders: invitedUserIds,
        ...(contextSnapshot && { context_snapshot: contextSnapshot }),
        ...(checklistMsg?.ts && { checklist_message_ts: checklistMsg.ts }),
        created_at: new Date(start).toISOString(),
        updated_at: new Date().toISOString(),
        correlation_id: incidentId,
      };

      await this.saveIncidentRecord(incidentRecord);
      const durationMs = Date.now() - start;
      this.metrics?.durationMs(MetricNames.AssemblyDurationMs, durationMs, [
        { name: 'directory_fallback', value: String(directoryFallback) },
      ]);
      rootSpan.setAttribute('incident.id', incidentId);
      rootSpan.setAttribute('team.id', alert.team_id);
      rootSpan.setAttribute('directory_fallback', directoryFallback);
      rootSpan.setAttribute('responder_count', invitedUserIds.length);
      rootSpan.setAttribute('assembly_duration_ms', durationMs);
      log.info(
        {
          channel_id: channel.id,
          responder_count: invitedUserIds.length,
          assembly_duration_ms: durationMs,
          directory_fallback: directoryFallback,
          context_attached: contextAttached,
        },
        'War room assembled',
      );
      return incidentRecord;
    });
  }

  private async resolveResponderEmails(alert: GrafanaOnCallAlertPayload, incidentId: string): Promise<string[]> {
    const emails = new Set<string>();
    const chain = await this.grafanaOnCallClient.getEscalationChainForIntegration(alert.integration_id);
    if (chain) {
      for (const e of this.grafanaOnCallClient.extractEmailsFromChain(chain)) emails.add(e);
    }
    const directoryGroupId = process.env['WORKOS_TEAM_GROUP_MAP']
      ? ((JSON.parse(process.env['WORKOS_TEAM_GROUP_MAP']) as Record<string, string>)[alert.team_id] ?? '')
      : '';
    if (directoryGroupId) {
      const users = await this.directoryClient.getUsersInGroup(directoryGroupId, incidentId);
      for (const u of users) emails.add(u.email.toLowerCase());
    }
    return Array.from(emails);
  }

  private async inviteResponders(channelId: string, emails: string[], incidentId: string): Promise<string[]> {
    const invited: string[] = [];
    for (const email of emails) {
      try {
        const user = await this.slack.lookupUserByEmail(email, {
          timeoutMs: SLACK_INVITE_TIMEOUT_MS,
          label: 'slack.users.lookupByEmail',
        });
        if (!user) continue;
        await this.slack.inviteToChannel(channelId, user.id, {
          timeoutMs: SLACK_INVITE_TIMEOUT_MS,
          label: 'slack.conversations.invite',
        });
        invited.push(user.id);
        await this.auditWriter.write(incidentId, 'MARSHAL', 'RESPONDER_INVITED', {
          channel_id: channelId,
          invited_user_id: user.id,
          email,
          invited_at: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn(
          { incident_id: incidentId, email, error: err instanceof Error ? err.message : String(err) },
          'Failed to invite responder',
        );
        await this.auditWriter.write(incidentId, 'MARSHAL', 'RESPONDER_INVITE_FAILED', {
          channel_id: channelId,
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return invited;
  }

  private async updateIncidentStatus(incidentId: string, status: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.incidentsTableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :status, updated_at = :updated_at',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':updated_at': new Date().toISOString() },
      }),
    );
  }

  private async saveIncidentRecord(record: IncidentRecord): Promise<void> {
    await this.docClient.send(
      new PutCommand({
        TableName: this.incidentsTableName,
        Item: { PK: `INCIDENT#${record.incident_id}`, SK: 'METADATA', ...record, TTL: Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60 },
      }),
    );
  }
}
