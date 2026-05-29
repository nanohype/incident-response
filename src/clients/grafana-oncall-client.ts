/**
 * Grafana OnCall REST API client.
 * Read-only escalation-chain + on-call rotation queries.
 * Ack and resolve are the only write operations Marshal performs on OnCall.
 *
 * Two non-obvious things about this API surface (hard-won — confirm with curl
 * before changing):
 *
 * 1. OnCall lives on its OWN cluster topology, not Grafana Cloud's stack
 *    topology. A stack in `prod-us-west-0` can have its OnCall served out of
 *    `oncall-prod-us-central-0.grafana.net`. The `GRAFANA_ONCALL_BASE_URL`
 *    env var is the authoritative source — find yours by opening DevTools
 *    while navigating OnCall in the Grafana UI and watching the Network tab.
 *
 * 2. OnCall's API path prefix is `/oncall/api/v1/` and the auth header is
 *    plain `Authorization: <token>` (no `Bearer` prefix — this is OnCall's
 *    legacy convention inherited from its pre-Grafana days). Grafana
 *    service-account tokens (`glsa_…`) work directly in this header.
 */

import { HttpClient } from '../utils/http-client.js';
import { GrafanaOnCallEscalationChain, GrafanaOnCallUser } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class GrafanaOnCallClient {
  private readonly http: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.http = new HttpClient({
      clientName: 'grafana-oncall',
      baseUrl,
      // OnCall expects the bare token, no `Bearer` prefix.
      defaultHeaders: { Authorization: apiToken, Accept: 'application/json' },
      timeoutMs: 5000,
      maxRetries: 2,
    });
  }

  async getEscalationChainForIntegration(integrationId: string): Promise<GrafanaOnCallEscalationChain | null> {
    logger.debug({ integration_id: integrationId }, 'Querying Grafana OnCall escalation chain');
    const resp = await this.http.get<{ results?: GrafanaOnCallEscalationChain[] }>(
      `/oncall/api/v1/escalation_chains/?integration_id=${encodeURIComponent(integrationId)}`,
    );
    if (!resp.ok) {
      logger.warn({ integration_id: integrationId, status: resp.status }, 'Escalation chain query failed');
      return null;
    }
    return resp.data.results?.[0] ?? null;
  }

  async getCurrentOnCallUser(scheduleId: string): Promise<GrafanaOnCallUser | null> {
    const resp = await this.http.get<{ users?: GrafanaOnCallUser[] }>(
      `/oncall/api/v1/schedules/${encodeURIComponent(scheduleId)}/on_call_now/`,
    );
    if (!resp.ok || !resp.data.users?.length) return null;
    return resp.data.users[0] ?? null;
  }

  async acknowledgeAlertGroup(alertGroupId: string): Promise<boolean> {
    const resp = await this.http.post(`/oncall/api/v1/alert_groups/${encodeURIComponent(alertGroupId)}/acknowledge/`, {}, undefined);
    return resp.ok;
  }

  async resolveAlertGroup(alertGroupId: string): Promise<boolean> {
    const resp = await this.http.post(`/oncall/api/v1/alert_groups/${encodeURIComponent(alertGroupId)}/resolve/`, {}, undefined);
    return resp.ok;
  }

  extractEmailsFromChain(chain: GrafanaOnCallEscalationChain): string[] {
    const emails = new Set<string>();
    for (const step of chain.steps) {
      for (const user of step.notify_to_users_queue ?? []) {
        if (user.email) emails.add(user.email.toLowerCase());
      }
    }
    return Array.from(emails);
  }
}
