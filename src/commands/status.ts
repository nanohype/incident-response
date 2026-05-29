/**
 * /marshal status — report current incident status.
 * /marshal status draft — generate a Bedrock-backed status-page draft for IC approval.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CommandContext, CommandHandler } from '../services/command-registry.js';
import type { MarshalAI } from '../ai/marshal-ai.js';
import type { StatuspageApprovalGate } from '../services/statuspage-approval-gate.js';
import { buildStatusPageApprovalBlocks } from '../services/slack-blocks.js';
import type { IncidentRecord, GrafanaOnCallAlertPayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface StatusDeps {
  docClient: DynamoDBDocumentClient;
  incidentsTableName: string;
  marshalAI: MarshalAI;
  approvalGate: StatuspageApprovalGate;
}

async function loadIncident(deps: StatusDeps, incidentId: string): Promise<IncidentRecord | undefined> {
  const result = await deps.docClient.send(
    new GetCommand({
      TableName: deps.incidentsTableName,
      Key: { PK: `INCIDENT#${incidentId}`, SK: 'METADATA' },
    }),
  );
  return result.Item as IncidentRecord | undefined;
}

export function makeStatusHandler(deps: StatusDeps): CommandHandler {
  return async (ctx: CommandContext): Promise<void> => {
    if (ctx.args[0] === 'draft') {
      try {
        const incident = await loadIncident(deps, ctx.incidentId);
        const alert: GrafanaOnCallAlertPayload = incident?.alert_payload ?? {
          alert_group_id: ctx.incidentId,
          alert_group: { id: ctx.incidentId, title: 'Service Disruption', state: 'firing' },
          integration_id: '',
          route_id: '',
          team_id: '',
          team_name: 'Engineering',
          alerts: [{ id: '', title: 'Service Disruption', message: '', received_at: new Date().toISOString() }],
        };
        const draftBody = await deps.marshalAI.generateStatusDraft(alert, incident?.context_snapshot, undefined, ctx.incidentId);
        const storedDraft = await deps.approvalGate.createDraft(ctx.incidentId, draftBody, [], ctx.userId);
        await ctx.slack.chat.postMessage({
          channel: ctx.channelId,
          blocks: buildStatusPageApprovalBlocks(ctx.incidentId, storedDraft.draft_id, draftBody),
          text: '📡 Status page draft ready for IC approval',
        });
      } catch (err) {
        logger.error(
          { incident_id: ctx.incidentId, error: err instanceof Error ? err.message : String(err) },
          'Failed to generate status draft',
        );
        await ctx.respond({ text: '❌ Failed to generate status draft. Check logs; retry with `/marshal status draft`.' });
      }
      return;
    }

    const incident = await loadIncident(deps, ctx.incidentId);
    if (!incident) {
      await ctx.respond({ text: 'No active incident found for this channel. Start one via Grafana OnCall.' });
      return;
    }
    await ctx.respond({
      text: `*Incident ${incident.incident_id}* — status: \`${incident.status}\`, severity: \`${incident.severity}\`, responders: ${incident.responders.length}.`,
    });
  };
}
