/**
 * Unit tests for AuditWriter — 100% branch coverage required (security-critical).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import * as crypto from 'crypto';

import { AuditWriter, stringifyError, scrubDetails } from '../../src/utils/audit.js';
import { AutoPublishNotPermittedError } from '../../src/types/index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('AuditWriter', () => {
  let auditWriter: AuditWriter;
  const TABLE_NAME = 'marshal-audit-test';
  const INCIDENT_ID = 'test-incident-001';
  const ACTOR = 'MARSHAL';

  beforeEach(() => {
    ddbMock.reset();
    auditWriter = new AuditWriter(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' })), TABLE_NAME);
  });

  describe('write()', () => {
    it('AUDIT-001: writes item to DynamoDB with correct structure', async () => {
      ddbMock.on(PutCommand).resolves({});
      await auditWriter.write(INCIDENT_ID, ACTOR, 'WAR_ROOM_CREATED', { channel_id: 'C123' });
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: TABLE_NAME,
        Item: expect.objectContaining({
          PK: `INCIDENT#${INCIDENT_ID}`,
          action_type: 'WAR_ROOM_CREATED',
          actor_user_id: ACTOR,
          incident_id: INCIDENT_ID,
          details: { channel_id: 'C123' },
        }),
      });
    });

    it('AUDIT-002: is idempotent on ConditionalCheckFailedException', async () => {
      const err = new Error('ConditionalCheckFailedException');
      err.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejectsOnce(err);
      await expect(auditWriter.write(INCIDENT_ID, ACTOR, 'WAR_ROOM_CREATED', {})).resolves.toBeUndefined();
    });

    it('AUDIT-003: throws on non-idempotency DynamoDB failure', async () => {
      ddbMock.on(PutCommand).rejects(new Error('DynamoDB unavailable'));
      await expect(auditWriter.write(INCIDENT_ID, ACTOR, 'WAR_ROOM_CREATED', {})).rejects.toThrow('DynamoDB unavailable');
    });
  });

  describe('stringifyError()', () => {
    it('AUDIT-ERR-001: Error instances return err.message', () => {
      expect(stringifyError(new Error('boom'))).toBe('boom');
    });
    it('AUDIT-ERR-002: non-Error values return String(err)', () => {
      expect(stringifyError('plain string')).toBe('plain string');
      expect(stringifyError(42)).toBe('42');
      expect(stringifyError({ foo: 'bar' })).toBe('[object Object]');
      expect(stringifyError(null)).toBe('null');
      expect(stringifyError(undefined)).toBe('undefined');
    });
  });

  describe('writeStatuspageApproval()', () => {
    it('AUDIT-004: writes SHA256 of draft body', async () => {
      ddbMock.on(PutCommand).resolves({});
      const draftBody = 'We are investigating an issue affecting some customers.';
      const expectedSha = crypto.createHash('sha256').update(draftBody, 'utf8').digest('hex');
      const result = await auditWriter.writeStatuspageApproval(INCIDENT_ID, 'user-123', draftBody, 'draft-001');
      expect(result.body_sha256).toBe(expectedSha);
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: TABLE_NAME,
        Item: expect.objectContaining({
          action_type: 'STATUSPAGE_DRAFT_APPROVED',
          details: expect.objectContaining({ body_sha256: expectedSha, draft_id: 'draft-001' }),
        }),
      });
    });
  });

  describe('verifyApprovalBeforePublish()', () => {
    it('AUDIT-005: throws AutoPublishNotPermittedError when no approval event', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
      await expect(auditWriter.verifyApprovalBeforePublish(INCIDENT_ID)).rejects.toThrow(AutoPublishNotPermittedError);
    });

    it('AUDIT-006: uses ConsistentRead: true', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ action_type: 'STATUSPAGE_DRAFT_APPROVED' }] });
      await auditWriter.verifyApprovalBeforePublish(INCIDENT_ID);
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0]!.args[0]!.input.ConsistentRead).toBe(true);
    });

    it('AUDIT-007: does not throw when approval event exists', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ action_type: 'STATUSPAGE_DRAFT_APPROVED' }], Count: 1 });
      await expect(auditWriter.verifyApprovalBeforePublish(INCIDENT_ID)).resolves.toBeUndefined();
    });
  });

  describe('auditApprovalGateViolations()', () => {
    it('AUDIT-008: returns empty array when all published events have approval events', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [{ incident_id: INCIDENT_ID, action_type: 'STATUSPAGE_PUBLISHED' }] })
        .resolvesOnce({ Items: [{ action_type: 'STATUSPAGE_DRAFT_APPROVED' }], Count: 1 });
      const violations = await auditWriter.auditApprovalGateViolations();
      expect(violations).toHaveLength(0);
    });

    it('AUDIT-009: returns violations when published events lack approval', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [{ incident_id: INCIDENT_ID, action_type: 'STATUSPAGE_PUBLISHED' }] })
        .resolvesOnce({ Items: [], Count: 0 });
      const violations = await auditWriter.auditApprovalGateViolations();
      expect(violations).toHaveLength(1);
    });

    it('AUDIT-010: returns empty array when QueryCommand returns no Items field', async () => {
      ddbMock.on(QueryCommand).resolves({});
      const violations = await auditWriter.auditApprovalGateViolations();
      expect(violations).toHaveLength(0);
    });

    it('AUDIT-011: treats undefined inner Items as "lacking approval"', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [{ incident_id: INCIDENT_ID, action_type: 'STATUSPAGE_PUBLISHED' }] })
        .resolvesOnce({});
      const violations = await auditWriter.auditApprovalGateViolations();
      expect(violations).toHaveLength(1);
    });
  });

  describe('scrubDetails()', () => {
    it('AUDIT-SCRUB-001: pass-through for primitives, null, undefined', () => {
      expect(scrubDetails('hello')).toBe('hello');
      expect(scrubDetails(42)).toBe(42);
      expect(scrubDetails(true)).toBe(true);
      expect(scrubDetails(null)).toBe(null);
      expect(scrubDetails(undefined)).toBe(undefined);
    });

    it('AUDIT-SCRUB-002: redacts secret-shaped keys at the top level', () => {
      expect(scrubDetails({ token: 'xoxb-abc', email: 'a@b.com' })).toEqual({
        token: '[REDACTED]',
        email: 'a@b.com',
      });
      expect(scrubDetails({ api_key: 'sk_live', user: 'u1' })).toEqual({
        api_key: '[REDACTED]',
        user: 'u1',
      });
      expect(scrubDetails({ Authorization: 'Bearer xyz' })).toEqual({ Authorization: '[REDACTED]' });
    });

    it('AUDIT-SCRUB-003: walks nested objects and arrays', () => {
      const input = {
        actor: { email: 'a@b.com', sessionId: 'abc' },
        events: [
          { name: 'e1', password: 'p' },
          { name: 'e2', private_key: 'k' },
        ],
        meta: { nested: { bearer_token: 't' } },
      };
      expect(scrubDetails(input)).toEqual({
        actor: { email: 'a@b.com', sessionId: '[REDACTED]' },
        events: [
          { name: 'e1', password: '[REDACTED]' },
          { name: 'e2', private_key: '[REDACTED]' },
        ],
        meta: { nested: { bearer_token: '[REDACTED]' } },
      });
    });

    it('AUDIT-SCRUB-004: leaves non-secret keys (e.g. body_sha256) untouched', () => {
      expect(scrubDetails({ body_sha256: 'abc123', digest: 'def' })).toEqual({
        body_sha256: 'abc123',
        digest: 'def',
      });
    });

    it('AUDIT-SCRUB-004b: redacts bare-word secret keys (key, auth, cookie, signature, hmac)', () => {
      expect(scrubDetails({ key: 'raw', other: 'ok' })).toEqual({ key: '[REDACTED]', other: 'ok' });
      expect(scrubDetails({ auth: 'Bearer ...' })).toEqual({ auth: '[REDACTED]' });
      expect(scrubDetails({ cookie: 'session=...' })).toEqual({ cookie: '[REDACTED]' });
      expect(scrubDetails({ signature: 'abc', xSignatureHex: 'def' })).toEqual({
        signature: '[REDACTED]',
        xSignatureHex: '[REDACTED]',
      });
      expect(scrubDetails({ hmac_secret: 'v', webhookHmac: 'v' })).toEqual({
        hmac_secret: '[REDACTED]',
        webhookHmac: '[REDACTED]',
      });
      // Allow-listed look-alikes: `key_id`, `keyId` are identifiers, not the secret itself —
      // the substring pattern does not match them, and neither does the exact-word pattern.
      expect(scrubDetails({ key_id: 'abc', keyId: 'def', error_code: 'E1' })).toEqual({
        key_id: 'abc',
        keyId: 'def',
        error_code: 'E1',
      });
    });

    it('AUDIT-SCRUB-005: AuditWriter.write applies scrub before persisting', async () => {
      ddbMock.on(PutCommand).resolves({});
      await auditWriter.write(INCIDENT_ID, ACTOR, 'WAR_ROOM_CREATED', {
        channel_id: 'C123',
        // Hypothetical accidental secret leak — must be redacted
        bearer_token: 'xoxb-leaked',
      });
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: TABLE_NAME,
        Item: expect.objectContaining({
          details: { channel_id: 'C123', bearer_token: '[REDACTED]' },
        }),
      });
    });
  });
});
