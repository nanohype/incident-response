/**
 * STATUS_UPDATE_NUDGE — EventBridge Scheduler fires every 15 min; post a gentle nudge to the IC.
 */

import type { WebClient } from '@slack/web-api';
import type { NudgeQueueMessage } from '../services/sqs-consumer.js';
import type { EventHandler } from '../services/event-registry.js';
import type { AuditWriter } from '../utils/audit.js';
import { buildNudgeBlocks } from '../services/slack-blocks.js';
import { withTimeoutOrDefault } from '../utils/with-timeout.js';
import { logger } from '../utils/logger.js';

export function makeStatusUpdateNudgeHandler(deps: { slack: WebClient; auditWriter: AuditWriter }): EventHandler<NudgeQueueMessage> {
  return async (message) => {
    if (!message.channel_id) {
      logger.warn({ incident_id: message.incident_id }, 'Nudge event missing channel_id — dropping');
      return;
    }
    await withTimeoutOrDefault(
      deps.slack.chat.postMessage({
        channel: message.channel_id,
        blocks: buildNudgeBlocks(),
        text: '🕒 15-minute status update due',
      }),
      7500,
      'slack.chat.postMessage:nudge',
      undefined,
      message.incident_id,
    );
    await deps.auditWriter.write(message.incident_id, 'MARSHAL', 'STATUS_REMINDER_SENT', {
      channel_id: message.channel_id,
      sent_at: new Date().toISOString(),
    });
  };
}
