/**
 * Statuspage.io draft lifecycle. Drafts live in the incidents table under
 * `SK = STATUSPAGE_DRAFT#<draft_id>` and transition through the approval gate.
 */

export interface StatusPageDraft {
  draft_id: string;
  incident_id: string;
  body: string;
  body_sha256: string;
  affected_component_ids: string[];
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'PUBLISHED' | 'REJECTED';
  created_at: string;
  approved_at?: string;
  approved_by?: string;
  published_at?: string;
}
