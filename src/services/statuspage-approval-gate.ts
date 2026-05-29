/**
 * StatuspageApprovalGate — 100% approval gate invariant.
 *
 * ONLY code path that may call StatuspageClient.createIncident().
 * Enforced at TWO levels:
 *   1. Application: IC must click “Approve & Publish” in Slack
 *   2. Database: verifyApprovalBeforePublish() checks audit log (ConsistentRead:true) before publish
 *
 * NO auto-publish. NO escape hatch. NO silent mode. Ever.
 */

import * as crypto from 'crypto';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { StatuspageClient } from '../clients/statuspage-client.js';
import { AuditWriter } from '../utils/audit.js';
import { StatusPageDraft } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { MetricsEmitter, MetricNames } from '../utils/metrics.js';

export class StatuspageApprovalGate {
  constructor(
    private readonly docClient: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly auditWriter: AuditWriter,
    private readonly statuspageClient: StatuspageClient,
    private readonly metrics?: MetricsEmitter,
  ) {}

  async createDraft(incidentId: string, draftBody: string, affectedComponentIds: string[], createdBy: string): Promise<StatusPageDraft> {
    const draftId = `draft-${incidentId}-${Date.now()}`;
    const body_sha256 = crypto.createHash('sha256').update(draftBody, 'utf8').digest('hex');
    const draft: StatusPageDraft = {
      draft_id: draftId,
      incident_id: incidentId,
      body: draftBody,
      body_sha256,
      affected_component_ids: affectedComponentIds,
      status: 'PENDING_APPROVAL',
      created_at: new Date().toISOString(),
    };
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `INCIDENT#${incidentId}`,
          SK: `STATUSPAGE_DRAFT#${draftId}`,
          ...draft,
          TTL: Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60,
        },
      }),
    );
    await this.auditWriter.write(incidentId, createdBy, 'STATUSPAGE_DRAFT_CREATED', {
      draft_id: draftId,
      body_sha256,
      body_length: draftBody.length,
      affected_component_ids: affectedComponentIds,
    });
    logger.info({ incident_id: incidentId, draft_id: draftId }, 'Status page draft created');
    return draft;
  }

  async approveAndPublish(
    incidentId: string,
    draftId: string,
    approvingUserId: string,
  ): Promise<{ statuspage_incident_id: string; shortlink: string }> {
    const start = Date.now();
    logger.info({ incident_id: incidentId, draft_id: draftId, approving_user: approvingUserId }, 'IC approving status page draft');

    // Step 1: Load + validate draft
    const draftResult = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
      }),
    );
    const draft = draftResult.Item as StatusPageDraft | undefined;
    if (!draft) throw new Error(`Draft ${draftId} not found for incident ${incidentId}`);
    if (draft.status !== 'PENDING_APPROVAL')
      throw new Error(`Draft ${draftId} is not in PENDING_APPROVAL status (current: ${draft.status})`);

    // Step 2: Write approval to audit log — AWAITED
    const { body_sha256 } = await this.auditWriter.writeStatuspageApproval(incidentId, approvingUserId, draft.body, draftId);

    // Step 3: Verify approval record (ConsistentRead:true) — AWAITED
    await this.auditWriter.verifyApprovalBeforePublish(incidentId);

    // Step 4: Publish to Statuspage.io — AWAITED
    let statuspageIncident;
    try {
      statuspageIncident = await this.statuspageClient.createIncident(
        `Service Disruption — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        draft.body,
        draft.affected_component_ids,
        incidentId,
      );
    } catch (publishError) {
      logger.error(
        { incident_id: incidentId, draft_id: draftId, error: publishError instanceof Error ? publishError.message : String(publishError) },
        'Statuspage.io publish failed after approval',
      );
      this.metrics?.increment(MetricNames.StatuspagePublishCount, [{ name: 'outcome', value: 'failed' }]);
      throw new Error(
        `Statuspage.io publish failed after IC approval. Retry by clicking Approve & Publish again. Error: ${publishError instanceof Error ? publishError.message : String(publishError)}`,
      );
    }

    // Step 5: Write STATUSPAGE_PUBLISHED — AWAITED
    await this.auditWriter.write(incidentId, approvingUserId, 'STATUSPAGE_PUBLISHED', {
      draft_id: draftId,
      body_sha256,
      statuspage_incident_id: statuspageIncident.id,
      shortlink: statuspageIncident.shortlink,
      published_at: new Date().toISOString(),
    });

    // Step 6: Update draft status
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
        UpdateExpression: 'SET #status = :status, approved_at = :approved_at, approved_by = :approved_by, published_at = :published_at',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'PUBLISHED',
          ':approved_at': new Date().toISOString(),
          ':approved_by': approvingUserId,
          ':published_at': new Date().toISOString(),
        },
      }),
    );

    this.metrics?.increment(MetricNames.StatuspagePublishCount, [{ name: 'outcome', value: 'published' }]);
    this.metrics?.durationMs(MetricNames.ApprovalGateLatencyMs, Date.now() - start);
    logger.info(
      { incident_id: incidentId, draft_id: draftId, statuspage_incident_id: statuspageIncident.id, approving_user: approvingUserId },
      'Status page published with IC approval',
    );
    return { statuspage_incident_id: statuspageIncident.id, shortlink: statuspageIncident.shortlink };
  }

  async rejectDraft(incidentId: string, draftId: string, rejectingUserId: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'REJECTED' },
      }),
    );
    await this.auditWriter.write(incidentId, rejectingUserId, 'STATUSPAGE_APPROVAL_REJECTED', { draft_id: draftId });
  }
}
