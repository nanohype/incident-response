/**
 * Slack interactive action bindings.
 * Registers approve/edit/silence/pulse-rating handlers on the Slack Bolt App.
 * Kept out of src/index.ts so wiring stays thin.
 */

import type { App } from '@slack/bolt';
import type { AuditWriter } from '../utils/audit.js';
import type { StatuspageApprovalGate } from '../services/statuspage-approval-gate.js';
import { logger } from '../utils/logger.js';

export function registerSlackActions(app: App, deps: { approvalGate: StatuspageApprovalGate; auditWriter: AuditWriter }): void {
  app.action('statuspage_approve', async ({ action, ack, body, respond }) => {
    await ack();
    const { incident_id, draft_id } = JSON.parse((action as { value: string }).value) as { incident_id: string; draft_id: string };
    const userId = body.user.id;
    try {
      const result = await deps.approvalGate.approveAndPublish(incident_id, draft_id, userId);
      await respond({
        text: `✅ Status page published by <@${userId}>. <${result.shortlink}|View on status page>`,
        replace_original: true,
      });
    } catch (err) {
      logger.error({ incident_id, draft_id, error: err instanceof Error ? err.message : String(err) }, 'Status page approval failed');
      await respond({
        text: `❌ Failed to publish status page: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`,
      });
    }
  });

  app.action('statuspage_edit', async ({ action, ack, body, client }) => {
    await ack();
    const { incident_id, draft_id } = JSON.parse((action as { value: string }).value) as { incident_id: string; draft_id: string };
    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        callback_id: `statuspage_edit_submit:${incident_id}:${draft_id}`,
        title: { type: 'plain_text', text: 'Edit Status Page Draft' },
        submit: { type: 'plain_text', text: 'Save & Re-Review' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'draft_body',
            element: { type: 'plain_text_input', action_id: 'draft_body_input', multiline: true, initial_value: 'Edit draft here...' },
            label: { type: 'plain_text', text: 'Status Page Message' },
          },
        ],
      },
    });
  });

  app.action('silence_reminders', async ({ ack, body }) => {
    await ack();
    const channelId = (body as { channel?: { id?: string } }).channel?.id ?? '';
    logger.info({ channel_id: channelId, user_id: body.user.id }, 'IC silenced reminders via button');
  });

  for (const rating of [1, 2, 3, 4, 5] as const) {
    app.action(`pulse_rate_${rating}`, async ({ action, ack, body, respond }) => {
      await ack();
      const { incident_id } = JSON.parse((action as { value: string }).value) as { incident_id: string };
      await deps.auditWriter.write(incident_id, body.user.id, 'IC_RATED', { rating, rated_at: new Date().toISOString() });
      await respond({ text: `${'\u2b50'.repeat(rating)} Thank you! Your rating has been recorded.`, replace_original: true });
      logger.info({ incident_id, user_id: body.user.id, rating }, 'IC pulse rating recorded');
    });
  }
}
