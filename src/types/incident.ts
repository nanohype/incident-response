/**
 * Incident aggregate — state machine, persisted record shape, and IC pulse
 * rating. Read-model projection over the audit log; write access is
 * centralised in WarRoomAssembler + the command handlers.
 */

import { GrafanaOnCallAlertPayload, GrafanaContextSnapshot } from './grafana.js';

export type IncidentStatus =
  | 'ALERT_RECEIVED'
  | 'ROOM_ASSEMBLING'
  | 'ASSEMBLY_FAILED'
  | 'IC_MANUAL_ASSEMBLY'
  | 'ROOM_ASSEMBLED'
  | 'ACTIVE'
  | 'MITIGATED'
  | 'RESOLVED';

export type IncidentSeverity = 'P1' | 'P2' | 'P3';

export interface IncidentRecord {
  incident_id: string; // = Grafana OnCall alert_group_id
  status: IncidentStatus;
  severity: IncidentSeverity;
  alert_payload: GrafanaOnCallAlertPayload;
  slack_channel_id?: string;
  slack_channel_name?: string;
  ic_user_id?: string;
  responders: string[]; // Slack user IDs
  context_snapshot?: GrafanaContextSnapshot;
  checklist_message_ts?: string;
  statuspage_incident_id?: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
  ic_rating?: 1 | 2 | 3 | 4 | 5;
  linear_postmortem_id?: string;
  correlation_id: string; // = incident_id, threads all events
}

export interface ICPulseRating {
  incident_id: string;
  user_id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  timestamp: string;
}
