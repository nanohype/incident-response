/**
 * Slack Block Kit message builders for Marshal.
 * Typed, composable blocks for war-room messages.
 */

import type { Block, KnownBlock } from '@slack/types';
import { GrafanaOnCallAlertPayload, GrafanaContextSnapshot } from '../types/index.js';

export function buildChecklistBlocks(incidentId: string, items: string[], completedItems: Set<string> = new Set()): (KnownBlock | Block)[] {
  const checklistText = items.map((item) => `${completedItems.has(item) ? '✅' : '⬜'} ${item}`).join('\n');
  return [
    { type: 'header', text: { type: 'plain_text', text: '📋 Incident Checklist', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: checklistText } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident ID: \`${incidentId}\` | Use \`/marshal checklist\` to refresh` }] },
  ];
}

export function buildContextSnapshotBlocks(alert: GrafanaOnCallAlertPayload, snapshot?: GrafanaContextSnapshot): (KnownBlock | Block)[] {
  const blocks: (KnownBlock | Block)[] = [
    { type: 'header', text: { type: 'plain_text', text: `🚨 P1: ${alert.alert_group.title}`, emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Team:*\n${alert.team_name}` },
        { type: 'mrkdwn', text: `*Incident ID:*\n\`${alert.alert_group_id}\`` },
        { type: 'mrkdwn', text: `*Integration:*\n\`${alert.integration_id}\`` },
        { type: 'mrkdwn', text: `*Fired at:*\n${new Date().toISOString()}` },
      ],
    },
  ];

  if (alert.alerts[0])
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Alert Message:*\n${alert.alerts[0].message.substring(0, 300)}` } });

  if (snapshot) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📊 Grafana Cloud Context (last 2h)*' } },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Error Rate:*\n${(snapshot.error_rate_2h.current * 100).toFixed(2)}% (baseline: ${(snapshot.error_rate_2h.baseline * 100).toFixed(2)}%)`,
          },
          {
            type: 'mrkdwn',
            text: `*p99 Latency:*\n${snapshot.p99_latency_ms.current.toFixed(0)}ms (baseline: ${snapshot.p99_latency_ms.baseline.toFixed(0)}ms)`,
          },
          { type: 'mrkdwn', text: `*Error Budget Burn Rate:*\n${snapshot.error_budget_burn_rate.toFixed(1)}x` },
          {
            type: 'mrkdwn',
            text: snapshot.error_rate_2h.series_url
              ? `*Dashboard:*\n<${snapshot.error_rate_2h.series_url}|Open in Grafana>`
              : '*Dashboard:*\n_Not available_',
          },
        ],
      },
    );
    if (snapshot.log_excerpts.length > 0)
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recent Error Logs:*\n\`\`\`${snapshot.log_excerpts.slice(0, 3).join('\n').substring(0, 800)}\`\`\``,
        },
      });
    if (snapshot.sample_trace_ids.length > 0)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Sample Trace IDs:*\n${snapshot.sample_trace_ids.map((id) => `\`${id}\``).join(' ')}` },
      });
    if (snapshot.datasource_errors?.length)
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⚠️ Some Grafana queries failed: ${snapshot.datasource_errors.join('; ')}` }],
      });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '⚠️ _Grafana Cloud context unavailable — queries failed or timed out. Check Grafana manually._' },
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Available commands:* `/marshal status` `/marshal status draft` `/marshal resolve` `/marshal checklist` `/marshal silence` `/marshal help`',
      },
    },
  );
  return blocks;
}

export function buildStatusPageApprovalBlocks(incidentId: string, draftId: string, draftBody: string): (KnownBlock | Block)[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: '📡 Status Page Draft — Pending IC Approval', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft message for customer status page:*\n\n${draftBody}\n\n⚠️ *This message will only reach customers after your explicit approval.*`,
      },
    },
    {
      type: 'actions',
      block_id: `statuspage_approval:${incidentId}:${draftId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Publish', emoji: true },
          style: 'primary',
          action_id: 'statuspage_approve',
          value: JSON.stringify({ incident_id: incidentId, draft_id: draftId }),
          confirm: {
            title: { type: 'plain_text', text: 'Publish to Status Page?' },
            text: { type: 'mrkdwn', text: 'This will publish the message to the customer-facing status page. Are you sure?' },
            confirm: { type: 'plain_text', text: 'Yes, Publish' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit Draft', emoji: true },
          action_id: 'statuspage_edit',
          value: JSON.stringify({ incident_id: incidentId, draft_id: draftId }),
        },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '🔒 All approval actions are audit-logged with your user ID and timestamp.' }] },
  ];
}

export function buildNudgeBlocks(lastUpdateTime?: string): (KnownBlock | Block)[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🕒 *15-minute status update due.*${lastUpdateTime ? ` No update posted since ${lastUpdateTime}.` : ''} Post a quick status so the room is current.`,
      },
    },
    {
      type: 'actions',
      block_id: 'nudge_silence',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔕 Silence reminders', emoji: true },
          action_id: 'silence_reminders',
          style: 'danger',
        },
      ],
    },
  ];
}

export function buildPulseRatingBlocks(incidentId: string): (KnownBlock | Block)[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '🎉 *Incident resolved.* How well did Marshal help you think clearly?' } },
    {
      type: 'actions',
      block_id: `pulse_rating:${incidentId}`,
      elements: [1, 2, 3, 4, 5].map((r) => ({
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '⭐'.repeat(r), emoji: true },
        action_id: `pulse_rate_${r}`,
        value: JSON.stringify({ incident_id: incidentId, rating: r }),
      })),
    },
  ];
}
