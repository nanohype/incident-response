/**
 * ALERT_RESOLVED — Grafana OnCall reports the alert cleared; record it.
 * The IC still owns running /marshal resolve to produce a postmortem.
 */

import type { IncidentQueueMessage } from '../services/sqs-consumer.js';
import type { EventHandler } from '../services/event-registry.js';
import type { AuditWriter } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

export function makeAlertResolvedHandler(auditWriter: AuditWriter): EventHandler<IncidentQueueMessage> {
  return async (message) => {
    const incidentId = message.payload.alert_group_id;
    try {
      await auditWriter.write(incidentId, 'MARSHAL', 'INCIDENT_RESOLVED', {
        resolved_at: new Date().toISOString(),
        alert_payload: message.payload,
        source: 'grafana-oncall-webhook',
      });
    } catch (err) {
      // SQS will retry via visibility timeout; bounded by maxReceiveCount=3 → DLQ.
      logger.error(
        { incident_id: incidentId, error: err instanceof Error ? err.message : String(err) },
        'INCIDENT_RESOLVED audit write failed — SQS retry (DLQ after 3 attempts)',
      );
      throw err;
    }
  };
}
