/**
 * Postmortem draft — created in Linear at `/marshal resolve` time. The draft
 * is the system-of-record link; Marshal only stores the issue ID/URL + SLA
 * deadline on the incident record.
 */

export interface PostmortemDraft {
  incident_id: string;
  linear_issue_id: string;
  linear_issue_url: string;
  title: string;
  created_at: string;
  sla_deadline: string;
}
