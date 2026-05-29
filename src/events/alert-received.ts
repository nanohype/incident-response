/**
 * ALERT_RECEIVED — P1 alert arrived, assemble the war room.
 */

import type { WarRoomAssembler } from '../services/war-room-assembler.js';
import type { IncidentQueueMessage } from '../services/sqs-consumer.js';
import type { EventHandler } from '../services/event-registry.js';
import { logger } from '../utils/logger.js';

export function makeAlertReceivedHandler(warRoomAssembler: WarRoomAssembler): EventHandler<IncidentQueueMessage> {
  return async (message) => {
    const incidentId = message.payload.alert_group_id;
    try {
      const incident = await warRoomAssembler.assemble(message.payload);
      logger.info({ incident_id: incidentId, channel_id: incident.slack_channel_id }, 'War room assembly complete');
    } catch (err) {
      logger.error({ incident_id: incidentId, error: err instanceof Error ? err.message : String(err) }, 'War room assembly failed');
      throw err;
    }
  };
}
