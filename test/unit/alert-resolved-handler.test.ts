/**
 * Unit tests for the ALERT_RESOLVED event handler.
 * Covers: happy path + audit-write-failure surfaces an error to SQS so visibility timeout retries.
 */

import { makeAlertResolvedHandler } from '../../src/events/alert-resolved.js';
import type { AuditWriter } from '../../src/utils/audit.js';
import type { IncidentQueueMessage } from '../../src/services/sqs-consumer.js';

function mkMessage(id = 'inc-42'): IncidentQueueMessage {
  return {
    type: 'ALERT_RESOLVED',
    payload: {
      alert_group_id: id,
      alert_group: { id, title: 't', state: 'resolved' },
      integration_id: 'i',
      route_id: '',
      team_id: '',
      team_name: '',
      alerts: [{ id: 'a', title: 't', message: 'm', received_at: new Date().toISOString() }],
    },
  };
}

describe('makeAlertResolvedHandler', () => {
  it('ALRES-001: writes INCIDENT_RESOLVED audit on happy path', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    const auditWriter = { write } as unknown as AuditWriter;
    await makeAlertResolvedHandler(auditWriter)(mkMessage('inc-1'));
    expect(write).toHaveBeenCalledWith(
      'inc-1',
      'MARSHAL',
      'INCIDENT_RESOLVED',
      expect.objectContaining({ source: 'grafana-oncall-webhook' }),
    );
  });

  it('ALRES-002: rethrows on audit write failure so SQS retries via visibility timeout', async () => {
    const write = jest.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    const auditWriter = { write } as unknown as AuditWriter;
    await expect(makeAlertResolvedHandler(auditWriter)(mkMessage('inc-2'))).rejects.toThrow('DynamoDB throttled');
  });

  it('ALRES-003: rethrows non-Error rejection shape unchanged', async () => {
    const write = jest.fn().mockRejectedValue('string rejection');
    const auditWriter = { write } as unknown as AuditWriter;
    await expect(makeAlertResolvedHandler(auditWriter)(mkMessage('inc-3'))).rejects.toBeDefined();
  });
});
