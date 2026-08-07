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

import * as crypto from "node:crypto";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { StatuspageClient, StatuspageIncident } from "../clients/statuspage-client.js";
import type { StatusPageDraft } from "../types/index.js";
import type { AuditWriter } from "../utils/audit.js";
import { stringifyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { DurationBuckets, MetricNames, type MetricsEmitter } from "../utils/metrics.js";

export class StatuspageApprovalGate {
  constructor(
    private readonly docClient: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly auditWriter: AuditWriter,
    private readonly statuspageClient: StatuspageClient,
    private readonly metrics?: MetricsEmitter,
  ) {}

  async createDraft(
    incidentId: string,
    draftBody: string,
    affectedComponentIds: string[],
    createdBy: string,
  ): Promise<StatusPageDraft> {
    const draftId = `draft-${incidentId}-${Date.now()}`;
    const body_sha256 = crypto.createHash("sha256").update(draftBody, "utf8").digest("hex");
    const draft: StatusPageDraft = {
      draft_id: draftId,
      incident_id: incidentId,
      body: draftBody,
      body_sha256,
      affected_component_ids: affectedComponentIds,
      status: "PENDING_APPROVAL",
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
    await this.auditWriter.write(incidentId, createdBy, "STATUSPAGE_DRAFT_CREATED", {
      draft_id: draftId,
      body_sha256,
      body_length: draftBody.length,
      affected_component_ids: affectedComponentIds,
    });
    logger.info({ incident_id: incidentId, draft_id: draftId }, "Status page draft created");
    return draft;
  }

  async approveAndPublish(
    incidentId: string,
    draftId: string,
    approvingUserId: string,
  ): Promise<{ statuspage_incident_id: string; shortlink: string }> {
    const start = Date.now();
    logger.info(
      { incident_id: incidentId, draft_id: draftId, approving_user: approvingUserId },
      "IC approving status page draft",
    );

    // Step 1: Load + validate draft
    const draftResult = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
      }),
    );
    const draft = draftResult.Item as StatusPageDraft | undefined;
    if (!draft) throw new Error(`Draft ${draftId} not found for incident ${incidentId}`);
    if (draft.status !== "PENDING_APPROVAL")
      throw new Error(
        `Draft ${draftId} is not in PENDING_APPROVAL status (current: ${draft.status})`,
      );

    // Step 2: Write approval to audit log — AWAITED
    const { body_sha256 } = await this.auditWriter.writeStatuspageApproval(
      incidentId,
      approvingUserId,
      draft.body,
      draftId,
    );

    // Step 3: Verify approval record (ConsistentRead:true) — AWAITED
    await this.auditWriter.verifyApprovalBeforePublish(incidentId);

    // Step 4: Publish to Statuspage.io — AWAITED
    let statuspageIncident: StatuspageIncident;
    try {
      statuspageIncident = await this.statuspageClient.createIncident(
        `Service Disruption — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
        draft.body,
        draft.affected_component_ids,
        incidentId,
      );
    } catch (publishError) {
      logger.error(
        { incident_id: incidentId, draft_id: draftId, error: stringifyError(publishError) },
        "Statuspage.io publish failed after approval",
      );
      this.metrics?.increment(MetricNames.StatuspagePublishCount, [
        { name: "outcome", value: "failed" },
      ]);
      throw new Error(
        `Statuspage.io publish failed after IC approval. Retry by clicking Approve & Publish again. Error: ${stringifyError(publishError)}`,
        { cause: publishError },
      );
    }

    // Step 5: Write STATUSPAGE_PUBLISHED — AWAITED
    await this.auditWriter.write(incidentId, approvingUserId, "STATUSPAGE_PUBLISHED", {
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
        UpdateExpression:
          "SET #status = :status, approved_at = :approved_at, approved_by = :approved_by, published_at = :published_at",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "PUBLISHED",
          ":approved_at": new Date().toISOString(),
          ":approved_by": approvingUserId,
          ":published_at": new Date().toISOString(),
        },
      }),
    );

    this.metrics?.increment(MetricNames.StatuspagePublishCount, [
      { name: "outcome", value: "published" },
    ]);
    this.metrics?.duration(
      MetricNames.ApprovalGateLatency,
      (Date.now() - start) / 1000,
      [],
      DurationBuckets.approvalGate,
    );
    logger.info(
      {
        incident_id: incidentId,
        draft_id: draftId,
        statuspage_incident_id: statuspageIncident.id,
        approving_user: approvingUserId,
      },
      "Status page published with IC approval",
    );
    return {
      statuspage_incident_id: statuspageIncident.id,
      shortlink: statuspageIncident.shortlink,
    };
  }

  /**
   * Load a draft for editing. Returns undefined when it does not exist, so the
   * caller can say so rather than opening a modal over nothing.
   */
  async getDraft(incidentId: string, draftId: string): Promise<StatusPageDraft | undefined> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
      }),
    );
    return result.Item as StatusPageDraft | undefined;
  }

  /**
   * Replace a pending draft's body with the IC's edit, keeping it in
   * PENDING_APPROVAL so it still requires the deliberate Approve & Publish click.
   *
   * `body_sha256` is recomputed here, and that is the whole point of routing the
   * edit through the gate rather than writing the item directly.
   * `approveAndPublish` hashes what it publishes and
   * `verifyApprovalBeforePublish` matches it against the approval record — so a
   * draft whose body changed without its hash following would either publish
   * text nobody approved or fail the pre-publish check. The revision is its own
   * awaited audit event carrying both hashes, so the ledger shows what the human
   * changed, not just that something changed.
   *
   * A conditional update on the status enforces the same invariant the approve
   * path asserts: an already-approved or rejected draft is immutable.
   */
  async reviseDraft(
    incidentId: string,
    draftId: string,
    newBody: string,
    revisingUserId: string,
  ): Promise<{ body_sha256: string; previous_body_sha256: string }> {
    const existing = await this.getDraft(incidentId, draftId);
    if (!existing) throw new Error(`Draft ${draftId} not found for incident ${incidentId}`);
    if (existing.status !== "PENDING_APPROVAL")
      throw new Error(
        `Draft ${draftId} is not in PENDING_APPROVAL status (current: ${existing.status})`,
      );

    const body_sha256 = crypto.createHash("sha256").update(newBody, "utf8").digest("hex");

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
        UpdateExpression: "SET #body = :body, body_sha256 = :hash",
        // Re-asserted at write time, not just read time: two ICs editing the same
        // draft while a third approves must not overwrite approved text.
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#body": "body", "#status": "status" },
        ExpressionAttributeValues: {
          ":body": newBody,
          ":hash": body_sha256,
          ":pending": "PENDING_APPROVAL",
        },
      }),
    );

    await this.auditWriter.write(incidentId, revisingUserId, "STATUSPAGE_DRAFT_REVISED", {
      draft_id: draftId,
      body_sha256,
      previous_body_sha256: existing.body_sha256,
      body_length: newBody.length,
    });

    logger.info(
      { incident_id: incidentId, draft_id: draftId, revising_user: revisingUserId },
      "Status page draft revised by IC",
    );
    return { body_sha256, previous_body_sha256: existing.body_sha256 };
  }

  async rejectDraft(incidentId: string, draftId: string, rejectingUserId: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `INCIDENT#${incidentId}`, SK: `STATUSPAGE_DRAFT#${draftId}` },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": "REJECTED" },
      }),
    );
    await this.auditWriter.write(incidentId, rejectingUserId, "STATUSPAGE_APPROVAL_REJECTED", {
      draft_id: draftId,
    });
  }
}
