/**
 * Unit tests for StatuspageApprovalGate — 100% branch coverage required.
 * THE MOST CRITICAL TESTS IN THE CODEBASE.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { StatuspageApprovalGate } from '../../src/services/statuspage-approval-gate.js';
import { AuditWriter } from '../../src/utils/audit.js';
import { StatuspageClient } from '../../src/clients/statuspage-client.js';
import { AutoPublishNotPermittedError } from '../../src/types/index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('StatuspageApprovalGate — SECURITY CRITICAL', () => {
  const TABLE_NAME = 'marshal-incidents-test';
  const INCIDENT_ID = 'test-incident-001';
  const DRAFT_ID = 'draft-001';
  const USER_ID = 'U-ic-001';
  const DRAFT_BODY = 'We are investigating an issue affecting some customers.';

  let gate: StatuspageApprovalGate;
  let mockAuditWriter: jest.Mocked<AuditWriter>;
  let mockStatuspageClient: jest.Mocked<StatuspageClient>;

  beforeEach(() => {
    ddbMock.reset();
    mockAuditWriter = {
      write: jest.fn().mockResolvedValue(undefined),
      writeStatuspageApproval: jest.fn().mockResolvedValue({ body_sha256: 'abc123' }),
      verifyApprovalBeforePublish: jest.fn().mockResolvedValue(undefined),
      auditApprovalGateViolations: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AuditWriter>;

    mockStatuspageClient = {
      listComponents: jest.fn(),
      createIncident: jest.fn().mockResolvedValue({
        id: 'sp-incident-001',
        shortlink: 'https://status.example.com/incidents/sp-001',
        name: 'Incident',
        status: 'investigating',
        body: DRAFT_BODY,
        created_at: new Date().toISOString(),
        page_id: 'page-001',
      }),
      updateIncident: jest.fn(),
    } as unknown as jest.Mocked<StatuspageClient>;

    gate = new StatuspageApprovalGate(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' })),
      TABLE_NAME,
      mockAuditWriter,
      mockStatuspageClient,
    );
  });

  describe('createDraft()', () => {
    it('GATE-001: stores draft with PENDING_APPROVAL status and writes audit event', async () => {
      ddbMock.on(PutCommand).resolves({});
      const draft = await gate.createDraft(INCIDENT_ID, DRAFT_BODY, ['comp-001'], USER_ID);
      expect(draft.status).toBe('PENDING_APPROVAL');
      expect(draft.incident_id).toBe(INCIDENT_ID);
      expect(draft.body).toBe(DRAFT_BODY);
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        'STATUSPAGE_DRAFT_CREATED',
        expect.objectContaining({ body_sha256: draft.body_sha256 }),
      );
    });
  });

  describe('approveAndPublish()', () => {
    const mockDraftItem = {
      draft_id: DRAFT_ID,
      incident_id: INCIDENT_ID,
      body: DRAFT_BODY,
      body_sha256: 'abc123',
      affected_component_ids: ['comp-001'],
      status: 'PENDING_APPROVAL',
      created_at: new Date().toISOString(),
    };

    it('GATE-002: happy path — writes approval, verifies, calls Statuspage, writes published event', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      ddbMock.on(UpdateCommand).resolves({});
      const result = await gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID);
      expect(mockAuditWriter.writeStatuspageApproval).toHaveBeenCalled();
      expect(mockAuditWriter.verifyApprovalBeforePublish).toHaveBeenCalled();
      expect(mockStatuspageClient.createIncident).toHaveBeenCalled();
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        'STATUSPAGE_PUBLISHED',
        expect.objectContaining({ statuspage_incident_id: 'sp-incident-001' }),
      );
      expect(result.statuspage_incident_id).toBe('sp-incident-001');
    });

    it('GATE-003 [CRITICAL]: Statuspage API failure → PUBLISHED event NOT written', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockStatuspageClient.createIncident.mockRejectedValue(new Error('Statuspage.io 503'));
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(/Statuspage\.io publish failed/);
      expect(mockAuditWriter.write).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'STATUSPAGE_PUBLISHED',
        expect.anything(),
      );
    });

    it('GATE-003b: non-Error publish exception stringifies into error message', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockStatuspageClient.createIncident.mockRejectedValue('not an Error instance');
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(/not an Error instance/);
      expect(mockAuditWriter.write).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'STATUSPAGE_PUBLISHED',
        expect.anything(),
      );
    });

    it('GATE-004 [CRITICAL]: audit write failure → Statuspage NEVER called', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockAuditWriter.writeStatuspageApproval.mockRejectedValue(new Error('DynamoDB down'));
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow();
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it('GATE-004b [CRITICAL]: verifyApproval failure → Statuspage NEVER called', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockAuditWriter.verifyApprovalBeforePublish.mockRejectedValue(new AutoPublishNotPermittedError(INCIDENT_ID));
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(AutoPublishNotPermittedError);
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it('GATE-005: throws if draft does not exist', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(`Draft ${DRAFT_ID} not found`);
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it('GATE-006: throws if draft is already PUBLISHED', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...mockDraftItem, status: 'PUBLISHED' } });
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(/not in PENDING_APPROVAL/);
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });
  });

  describe('rejectDraft()', () => {
    it('GATE-007: updates draft status to REJECTED and writes audit event', async () => {
      ddbMock.on(UpdateCommand).resolves({});
      await gate.rejectDraft(INCIDENT_ID, DRAFT_ID, USER_ID);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.args[0]!.input.ExpressionAttributeValues).toMatchObject({ ':status': 'REJECTED' });
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        'STATUSPAGE_APPROVAL_REJECTED',
        expect.objectContaining({ draft_id: DRAFT_ID }),
      );
    });
  });
});
