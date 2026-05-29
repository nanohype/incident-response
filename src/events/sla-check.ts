/**
 * SLA_CHECK — 48h postmortem-review SLA timer. Logs (v0.1); in v0.2 will escalate via Slack.
 */

import type { NudgeQueueMessage } from '../services/sqs-consumer.js';
import type { EventHandler } from '../services/event-registry.js';
import { logger } from '../utils/logger.js';

export function makeSlaCheckHandler(): EventHandler<NudgeQueueMessage> {
  return async (message) => {
    logger.info({ incident_id: message.incident_id }, 'Postmortem 48h SLA check fired');
  };
}
