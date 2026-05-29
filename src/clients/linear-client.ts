/**
 * Linear API client for postmortem draft creation.
 * Uses @linear/sdk to create issues in the configured Incidents project.
 */

import { LinearClient } from '@linear/sdk';
import { PostmortemDraft } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { withTimeout } from '../utils/with-timeout.js';

// `@linear/sdk` does not expose a request-level timeout. Without an external
// deadline a hung Linear endpoint would wedge `/marshal resolve` past the SQS
// visibility timeout (300s) and burn a retry cycle. 8s covers Linear's
// typical worst-case latency (median ~400ms, p99 ~3s) with headroom.
const LINEAR_CALL_TIMEOUT_MS = 8000;

export class LinearMarshalClient {
  private readonly client: LinearClient;
  private readonly projectId: string;

  private readonly teamId: string;

  constructor(apiKey: string, projectId: string, teamId: string) {
    this.client = new LinearClient({ apiKey });
    this.projectId = projectId;
    this.teamId = teamId;
  }

  async createPostmortemDraft(
    incidentId: string,
    title: string,
    markdownContent: string,
    icUserId: string | undefined,
    _slackChannelName: string | undefined,
    incidentDate: Date,
  ): Promise<PostmortemDraft> {
    const issueTitle = `[P1 Postmortem] ${title} — ${incidentDate.toISOString().slice(0, 10)}`;
    logger.info({ incident_id: incidentId, title: issueTitle }, 'Creating postmortem draft in Linear');

    try {
      const labelsResult = await Promise.allSettled([this.findOrCreateLabel('postmortem'), this.findOrCreateLabel('p1')]);
      const labelIds: string[] = [];
      for (const r of labelsResult) {
        if (r.status === 'fulfilled' && r.value) labelIds.push(r.value);
      }

      let assigneeId: string | undefined;
      if (icUserId) {
        const viewer = await withTimeout(this.client.viewer, LINEAR_CALL_TIMEOUT_MS, 'linear.viewer');
        assigneeId = viewer.id;
      }

      const issuePayload = await withTimeout(
        this.client.createIssue({
          title: issueTitle,
          description: markdownContent,
          teamId: this.teamId,
          projectId: this.projectId,
          ...(labelIds.length > 0 && { labelIds }),
          ...(assigneeId && { assigneeId }),
        }),
        LINEAR_CALL_TIMEOUT_MS,
        'linear.createIssue',
      );

      if (!issuePayload.issue) throw new Error('Linear createIssue returned no issue field');
      const issue = await withTimeout(issuePayload.issue, LINEAR_CALL_TIMEOUT_MS, 'linear.issueField');
      if (!issue) throw new Error('Linear createIssue returned no issue');

      logger.info(
        { incident_id: incidentId, linear_issue_id: issue.id, linear_issue_url: issue.url },
        'Postmortem draft created in Linear',
      );

      return {
        incident_id: incidentId,
        linear_issue_id: issue.id,
        linear_issue_url: issue.url,
        title: issueTitle,
        created_at: new Date().toISOString(),
        sla_deadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      };
    } catch (err) {
      logger.error(
        { incident_id: incidentId, error: err instanceof Error ? err.message : String(err) },
        'Failed to create postmortem draft in Linear',
      );
      throw err;
    }
  }

  private async findOrCreateLabel(name: string): Promise<string | null> {
    try {
      const labels = await withTimeout(
        this.client.issueLabels({ filter: { name: { eq: name } } }),
        LINEAR_CALL_TIMEOUT_MS,
        'linear.issueLabels',
      );
      const existing = labels.nodes[0];
      if (existing) return existing.id;
      const created = await withTimeout(this.client.createIssueLabel({ name }), LINEAR_CALL_TIMEOUT_MS, 'linear.createIssueLabel');
      if (!created.issueLabel) return null;
      const label = await withTimeout(created.issueLabel, LINEAR_CALL_TIMEOUT_MS, 'linear.issueLabelField');
      return label?.id ?? null;
    } catch {
      return null;
    }
  }
}
