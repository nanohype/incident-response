/**
 * SQS event registries — keeps index.ts thin.
 */

import { EventRegistry } from '../services/event-registry.js';
import type { IncidentQueueMessage, NudgeQueueMessage } from '../services/sqs-consumer.js';
import { makeAlertReceivedHandler } from '../events/alert-received.js';
import { makeAlertResolvedHandler } from '../events/alert-resolved.js';
import { makeStatusUpdateNudgeHandler } from '../events/status-update-nudge.js';
import { makeSlaCheckHandler } from '../events/sla-check.js';
import type { Dependencies } from './dependencies.js';

export function buildIncidentEventRegistry(deps: Dependencies): EventRegistry<IncidentQueueMessage> {
  return new EventRegistry<IncidentQueueMessage>('incident')
    .on('ALERT_RECEIVED', makeAlertReceivedHandler(deps.warRoomAssembler))
    .on('ALERT_RESOLVED', makeAlertResolvedHandler(deps.auditWriter));
}

export function buildNudgeEventRegistry(deps: Dependencies): EventRegistry<NudgeQueueMessage> {
  return new EventRegistry<NudgeQueueMessage>('nudge')
    .on('STATUS_UPDATE_NUDGE', makeStatusUpdateNudgeHandler({ slack: deps.slackWebClient, auditWriter: deps.auditWriter }))
    .on('SLA_CHECK', makeSlaCheckHandler());
}
