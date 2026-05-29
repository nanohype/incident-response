/**
 * Audit log writer for Marshal.
 *
 * CRITICAL INVARIANT: All audit writes are AWAITED — never fire-and-forget.
 * The audit log IS the incident record of ground truth.
 * STATUSPAGE_PUBLISHED MUST always be preceded by STATUSPAGE_DRAFT_APPROVED.
 *
 * Two safety nets layered on `details`:
 *  1. Type-level: `write<K>(action_type: K, details: AuditDetailsByType[K])`
 *     forces call sites to use the per-event-type shape declared in
 *     `types/index.ts:AuditDetailsByType`. New code gets autocomplete +
 *     compile errors for unknown fields.
 *  2. Runtime: `scrubDetails` redacts any value whose key matches common
 *     secret patterns (token, password, api_key, ...). Defends against a
 *     careless `details: { ...rest }` spread that pulls a credential into
 *     the 366-day audit log.
 */

import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AuditEvent, AuditEventType, AuditDetailsByType, AutoPublishNotPermittedError } from '../types/index.js';
import { logger } from './logger.js';
import * as crypto from 'crypto';

function computeTTL(): number {
  return Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60;
}

export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Credential-shaped field names. Two-tier matching:
//   - SUBSTRING: catches compounds like `bearer_token`, `api-key`,
//     `awsSecretAccessKey`, `webhook_hmac`, `xSignatureHex`.
//   - EXACT: catches bare terms (`key`, `auth`, `cookie`) that are too
//     generic to substring-match without false positives (e.g. `error_code`
//     contains `code` — we don't want to redact an error code).
const SECRET_KEY_PATTERN_SUBSTRING =
  /token|secret|password|passphrase|api[_-]?key|bearer|authorization|credential|private[_-]?key|access[_-]?key|session[_-]?id|signature|hmac/i;
const SECRET_KEY_PATTERN_EXACT = /^(?:key|auth|cookie)$/i;

function isSecretKey(name: string): boolean {
  return SECRET_KEY_PATTERN_SUBSTRING.test(name) || SECRET_KEY_PATTERN_EXACT.test(name);
}

const REDACTED = '[REDACTED]';

/**
 * Defensively redact any value whose key looks credential-shaped.
 * Walks the object tree once. Arrays are mapped; primitives passed through.
 *
 * Allow-listed keys: `body_sha256` and similar hash fingerprints stay
 * (they're already non-reversible). The pattern doesn't match `sha256`,
 * `digest`, or `fingerprint` so this is implicit.
 */
export function scrubDetails<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubDetails(v)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubDetails(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export class AuditWriter {
  constructor(
    private readonly docClient: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async write<K extends AuditEventType>(
    incident_id: string,
    actor_user_id: string,
    action_type: K,
    details: AuditDetailsByType[K],
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const timestamp_ms = Date.now();
    const safeDetails = scrubDetails(details);
    const event: AuditEvent = {
      PK: `INCIDENT#${incident_id}`,
      SK: `AUDIT#${timestamp_ms}#${action_type}`,
      action_type,
      incident_id,
      actor_user_id,
      timestamp,
      details: safeDetails,
      TTL: computeTTL(),
    };
    await this.docClient
      .send(
        new PutCommand({
          TableName: this.tableName,
          Item: event,
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      )
      .catch((err) => {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          logger.debug({ incident_id, action_type }, 'Audit event already exists (idempotent write)');
          return;
        }
        logger.error({ incident_id, action_type, error: stringifyError(err) }, 'CRITICAL: Audit write failed');
        throw err;
      });
    logger.info({ incident_id, action_type, actor_user_id }, 'Audit event written');
  }

  async writeStatuspageApproval(
    incident_id: string,
    approver_user_id: string,
    draft_body: string,
    draft_id: string,
  ): Promise<{ body_sha256: string }> {
    const body_sha256 = crypto.createHash('sha256').update(draft_body, 'utf8').digest('hex');
    await this.write(incident_id, approver_user_id, 'STATUSPAGE_DRAFT_APPROVED', {
      draft_id,
      body_sha256,
      draft_body_length: draft_body.length,
      approved_at: new Date().toISOString(),
    });
    return { body_sha256 };
  }

  async verifyApprovalBeforePublish(incident_id: string): Promise<void> {
    // No Limit: DynamoDB applies Limit BEFORE FilterExpression. A Limit=1
    // here would return the earliest audit event by timestamp (e.g.
    // WAR_ROOM_CREATED) and then filter it out, yielding an empty Items
    // array even when STATUSPAGE_DRAFT_APPROVED exists. The per-incident
    // audit trail is bounded (tens of events) so scanning all of them
    // under ConsistentRead is trivial.
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk_prefix)',
        FilterExpression: 'action_type = :action_type',
        ExpressionAttributeValues: {
          ':pk': `INCIDENT#${incident_id}`,
          ':sk_prefix': 'AUDIT#',
          ':action_type': 'STATUSPAGE_DRAFT_APPROVED',
        },
        ConsistentRead: true, // SECURITY: strongly consistent — approval write MUST be visible before publish
      }),
    );
    if (!result.Items || result.Items.length === 0) {
      logger.error({ incident_id }, 'CRITICAL SECURITY VIOLATION: Statuspage publish without approval in audit log');
      throw new AutoPublishNotPermittedError(incident_id);
    }
    logger.info({ incident_id }, 'Approval verified in audit log — proceeding with Statuspage publish');
  }

  async auditApprovalGateViolations(): Promise<AuditEvent[]> {
    const publishedResult = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'published-without-approval-index',
        KeyConditionExpression: 'action_type = :action_type',
        ExpressionAttributeValues: { ':action_type': 'STATUSPAGE_PUBLISHED' },
      }),
    );
    const violations: AuditEvent[] = [];
    for (const published of publishedResult.Items ?? []) {
      const inc_id = published['incident_id'] as string;
      // Same Limit+Filter ordering hazard as verifyApprovalBeforePublish: DDB
      // applies Limit before FilterExpression, so Limit=1 here can falsely
      // report a violation when the approval exists but isn't the earliest
      // audit event for the incident.
      const approvedResult = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk_prefix)',
          FilterExpression: 'action_type = :action_type',
          ExpressionAttributeValues: {
            ':pk': `INCIDENT#${inc_id}`,
            ':sk_prefix': 'AUDIT#',
            ':action_type': 'STATUSPAGE_DRAFT_APPROVED',
          },
        }),
      );
      if (!approvedResult.Items || approvedResult.Items.length === 0) {
        violations.push(published as AuditEvent);
      }
    }
    return violations;
  }
}
