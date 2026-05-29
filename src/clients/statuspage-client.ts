/**
 * Statuspage.io API client.
 * CRITICAL: Only call createIncident() from StatuspageApprovalGate.
 * Never call directly — the approval gate enforces 100% IC-approval invariant.
 */

import { HttpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';

export interface StatuspageIncident {
  id: string;
  name: string;
  status: string;
  body: string;
  created_at: string;
  shortlink: string;
  page_id: string;
}

export interface StatuspageComponent {
  id: string;
  name: string;
  status: string;
  description?: string;
  group_id?: string;
}

export class StatuspageClient {
  private readonly http: HttpClient;
  private readonly pageId: string;

  constructor(apiKey: string, pageId: string) {
    this.pageId = pageId;
    this.http = new HttpClient({
      clientName: 'statuspage',
      baseUrl: 'https://api.statuspage.io',
      defaultHeaders: { Authorization: `OAuth ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 5000,
      maxRetries: 2,
    });
  }

  async listComponents(): Promise<StatuspageComponent[]> {
    const resp = await this.http.get<StatuspageComponent[]>(`/v1/pages/${this.pageId}/components`);
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Failed to list Statuspage components');
      return [];
    }
    return resp.data;
  }

  async createIncident(name: string, body: string, componentIds: string[], incidentId: string): Promise<StatuspageIncident> {
    logger.info({ incident_id: incidentId, page_id: this.pageId }, 'Creating Statuspage.io incident');
    const resp = await this.http.post<StatuspageIncident>(
      `/v1/pages/${this.pageId}/incidents`,
      {
        incident: {
          name,
          status: 'investigating',
          body,
          component_ids: componentIds,
          deliver_notifications: true,
          auto_transition_deliver_notifications_at_end: false,
          auto_transition_deliver_notifications_at_start: false,
        },
      },
      undefined,
    );
    if (!resp.ok) throw new Error(`Statuspage.io createIncident failed: HTTP ${resp.status}`);
    return resp.data;
  }

  async updateIncident(
    spIncidentId: string,
    body: string,
    status: 'investigating' | 'identified' | 'monitoring' | 'resolved',
    incidentId: string,
  ): Promise<StatuspageIncident> {
    logger.info({ incident_id: incidentId, statuspage_incident_id: spIncidentId, status }, 'Updating Statuspage.io incident');
    const resp = await this.http.put<StatuspageIncident>(
      `/v1/pages/${this.pageId}/incidents/${spIncidentId}`,
      { incident: { status, body, deliver_notifications: true } },
      undefined,
    );
    if (!resp.ok) throw new Error(`Statuspage.io updateIncident failed: HTTP ${resp.status}`);
    return resp.data;
  }
}
