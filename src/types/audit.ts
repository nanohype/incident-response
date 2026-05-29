/**
 * Audit log contract types.
 *
 * `AuditEventType` is the closed set of action types the audit writer
 * accepts. `AuditDetailsByType` maps each action to its typed details shape,
 * giving call sites autocompletion and catching mis-typed fields at compile
 * time. The compile-time exhaustiveness check at the bottom of this file
 * fails if a new AuditEventType is added without a details entry.
 *
 * Details fields are intentionally permissive (LooseOptional + index
 * signature) — they're documentation, not a strict contract. Runtime safety
 * comes from `scrubDetails` in src/utils/audit.ts, which redacts
 * secret-shaped keys before writing.
 */

import { GrafanaOnCallAlertPayload } from './grafana.js';

export type AuditEventType =
  | 'WAR_ROOM_CREATED'
  | 'RESPONDER_INVITED'
  | 'RESPONDER_INVITE_FAILED'
  | 'CONTEXT_SNAPSHOT_ATTACHED'
  | 'CHECKLIST_PINNED'
  | 'CHECKLIST_ITEM_UPDATED'
  | 'STATUS_UPDATE_SENT'
  | 'STATUS_REMINDER_SENT'
  | 'STATUS_REMINDER_SILENCED'
  | 'STATUSPAGE_DRAFT_CREATED'
  | 'STATUSPAGE_DRAFT_APPROVED'
  | 'STATUSPAGE_PUBLISHED'
  | 'STATUSPAGE_APPROVAL_REJECTED'
  | 'POSTMORTEM_CREATED'
  | 'IC_RATED'
  | 'INCIDENT_MITIGATED'
  | 'INCIDENT_RESOLVED'
  | 'WAR_ROOM_ARCHIVED'
  | 'WAR_ROOM_ARCHIVE_FAILED'
  | 'DIRECTORY_LOOKUP_FAILED'
  | 'ASSEMBLY_FALLBACK_INITIATED'
  | 'SLASH_COMMAND_RECEIVED';

interface AuditDetailsExtras {
  [key: string]: unknown;
}

/**
 * Make all fields permissively optional under `exactOptionalPropertyTypes`:
 * a key may be omitted, present-as-undefined, or present with the declared
 * type. Audit details are best-effort documentation, not strict contracts;
 * call sites routinely pass `field: maybeValue` where
 * `maybeValue: T | undefined`.
 */
type LooseOptional<T> = { [K in keyof T]?: T[K] | undefined };

export interface AuditDetailsByType {
  WAR_ROOM_CREATED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      channel_name: string;
      alert_payload: GrafanaOnCallAlertPayload;
      assembly_start: string;
    }>;
  RESPONDER_INVITED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      invited_user_id: string;
      email: string;
      invited_at: string;
    }>;
  RESPONDER_INVITE_FAILED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      email: string;
      error: string;
    }>;
  CONTEXT_SNAPSHOT_ATTACHED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      attached: boolean;
      snapshot_present: boolean;
      queried_at: string;
      failure_reason: string;
    }>;
  CHECKLIST_PINNED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      message_ts: string;
    }>;
  CHECKLIST_ITEM_UPDATED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      item: string;
      completed: boolean;
    }>;
  STATUS_UPDATE_SENT: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      body_sha256: string;
    }>;
  STATUS_REMINDER_SENT: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      sent_at: string;
      minutes_since_last: number;
    }>;
  STATUS_REMINDER_SILENCED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      silenced_at: string;
      silenced_by: string;
      duration_minutes: number;
    }>;
  STATUSPAGE_DRAFT_CREATED: AuditDetailsExtras &
    LooseOptional<{
      draft_id: string;
      body_sha256: string;
      body_length: number;
      affected_component_ids: string[];
    }>;
  STATUSPAGE_DRAFT_APPROVED: AuditDetailsExtras &
    LooseOptional<{
      draft_id: string;
      body_sha256: string;
      draft_body_length: number;
      approved_at: string;
    }>;
  STATUSPAGE_PUBLISHED: AuditDetailsExtras &
    LooseOptional<{
      draft_id: string;
      statuspage_incident_id: string;
      body_sha256: string;
      shortlink: string;
      published_at: string;
    }>;
  STATUSPAGE_APPROVAL_REJECTED: AuditDetailsExtras &
    LooseOptional<{
      draft_id: string;
      rejected_by: string;
      reason: string;
    }>;
  POSTMORTEM_CREATED: AuditDetailsExtras &
    LooseOptional<{
      linear_issue_id: string;
      linear_issue_url: string;
      sla_deadline: string;
    }>;
  IC_RATED: AuditDetailsExtras &
    LooseOptional<{
      rating: 1 | 2 | 3 | 4 | 5;
      rated_at: string;
    }>;
  INCIDENT_MITIGATED: AuditDetailsExtras &
    LooseOptional<{
      mitigated_at: string;
    }>;
  INCIDENT_RESOLVED: AuditDetailsExtras &
    LooseOptional<{
      resolved_at: string;
      alert_payload: GrafanaOnCallAlertPayload;
      source: string;
      linear_issue_id: string;
      had_postmortem: boolean;
      resolution_notes: string;
    }>;
  WAR_ROOM_ARCHIVED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      archived_at: string;
    }>;
  WAR_ROOM_ARCHIVE_FAILED: AuditDetailsExtras &
    LooseOptional<{
      channel_id: string;
      error: string;
    }>;
  DIRECTORY_LOOKUP_FAILED: AuditDetailsExtras &
    LooseOptional<{
      error: string;
    }>;
  ASSEMBLY_FALLBACK_INITIATED: AuditDetailsExtras &
    LooseOptional<{
      reason: string;
    }>;
  SLASH_COMMAND_RECEIVED: AuditDetailsExtras &
    LooseOptional<{
      command: string;
      args: string[];
      channel_id: string;
    }>;
}

// Compile-time check: every AuditEventType has a details shape.
type _AuditDetailsExhaustive =
  Exclude<AuditEventType, keyof AuditDetailsByType> extends never
    ? true
    : ['Missing AuditDetailsByType entry for', Exclude<AuditEventType, keyof AuditDetailsByType>];
const _auditDetailsExhaustive: _AuditDetailsExhaustive = true;
void _auditDetailsExhaustive;

export type AuditEventDetails = AuditDetailsByType[AuditEventType];

export interface AuditEvent {
  PK: string;
  SK: string;
  action_type: AuditEventType;
  incident_id: string;
  actor_user_id: string;
  timestamp: string;
  details: AuditEventDetails;
  TTL: number;
}
