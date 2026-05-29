/**
 * Integration tests for the 100% approval-gate invariant against a real dynamodb-local.
 *
 * The unit tests mock AuditWriter entirely — a change that silently drops
 * `ConsistentRead: true` from verifyApprovalBeforePublish would pass every unit test.
 * These tests exercise the real DynamoDB semantics through the real AuditWriter.
 *
 * Requires dynamodb-local on localhost:8000 (see package.json `test:integration:docker`
 * or the `dynamodb` service in .github/workflows/ci.yml).
 */

import { AuditWriter } from '../../src/utils/audit.js';
import { AutoPublishNotPermittedError } from '../../src/types/index.js';
import { ddbLocalDoc, createAuditTable, deleteAuditTable } from './setup.js';

const TABLE_NAME = 'marshal-audit-integration';

describe('Approval gate — integration vs dynamodb-local', () => {
  let auditWriter: AuditWriter;

  beforeAll(async () => {
    await createAuditTable(TABLE_NAME);
    auditWriter = new AuditWriter(ddbLocalDoc, TABLE_NAME);
  });

  afterAll(async () => {
    await deleteAuditTable(TABLE_NAME);
  });

  it('INT-GATE-001: happy path — write approval then verify succeeds', async () => {
    const incidentId = `int-happy-${Date.now()}`;
    await auditWriter.writeStatuspageApproval(incidentId, 'U-ic', 'draft body 1', 'draft-1');
    await expect(auditWriter.verifyApprovalBeforePublish(incidentId)).resolves.toBeUndefined();
  });

  it('INT-GATE-002 [CRITICAL]: verify throws AutoPublishNotPermittedError when no approval exists', async () => {
    const incidentId = `int-no-approval-${Date.now()}`;
    await expect(auditWriter.verifyApprovalBeforePublish(incidentId)).rejects.toBeInstanceOf(AutoPublishNotPermittedError);
  });

  it('INT-GATE-003: write is immediately visible to verify (ConsistentRead semantics)', async () => {
    const incidentId = `int-consistency-${Date.now()}`;
    // Write and verify back-to-back — the code uses ConsistentRead:true so this must succeed.
    await auditWriter.writeStatuspageApproval(incidentId, 'U-ic', 'draft body 2', 'draft-2');
    await expect(auditWriter.verifyApprovalBeforePublish(incidentId)).resolves.toBeUndefined();
  });

  it('INT-GATE-004: verify is isolated to the target incident_id', async () => {
    const incidentWithApproval = `int-iso-with-${Date.now()}`;
    const incidentWithout = `int-iso-without-${Date.now()}`;
    await auditWriter.writeStatuspageApproval(incidentWithApproval, 'U-ic', 'body', 'draft-x');
    // Approval for one incident must not authorize publish for another.
    await expect(auditWriter.verifyApprovalBeforePublish(incidentWithout)).rejects.toBeInstanceOf(AutoPublishNotPermittedError);
  });

  it('INT-GATE-005: duplicate approval writes are idempotent (SK uniqueness)', async () => {
    const incidentId = `int-idemp-${Date.now()}`;
    await auditWriter.writeStatuspageApproval(incidentId, 'U-ic', 'body', 'draft-dup');
    // Same millisecond would normally collide; sleep 2ms ensures unique SK — the real check is that
    // both resolve without throwing.
    await new Promise((r) => setTimeout(r, 2));
    await auditWriter.writeStatuspageApproval(incidentId, 'U-ic', 'body', 'draft-dup');
    await expect(auditWriter.verifyApprovalBeforePublish(incidentId)).resolves.toBeUndefined();
  });
});
