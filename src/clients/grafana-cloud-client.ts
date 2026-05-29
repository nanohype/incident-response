/**
 * Grafana Cloud HTTP API client — READ-ONLY.
 * Queries Mimir (metrics), Loki (logs), Tempo (traces) for incident context snapshots.
 * INVARIANT: This client MUST NEVER write to Grafana Cloud.
 */

import { HttpClient } from '../utils/http-client.js';
import { GrafanaContextSnapshot } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface MimirQueryResult {
  status: string;
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values?: [number, string][]; value?: [number, string] }>;
  };
}

interface LokiQueryResult {
  status: string;
  data: { resultType: string; result: Array<{ stream: Record<string, string>; values: [string, string][] }> };
}

interface TempoSearchResult {
  traces: Array<{ traceID: string; rootServiceName: string; rootTraceName: string; startTimeUnixNano: string; durationMs: number }>;
}

export class GrafanaCloudClient {
  private readonly mimirClient: HttpClient;
  private readonly lokiClient: HttpClient;
  private readonly tempoClient: HttpClient;

  constructor(grafanaBaseUrl: string, orgId: string, apiToken: string) {
    const common = {
      defaultHeaders: { Authorization: `Bearer ${apiToken}`, 'X-Scope-OrgID': orgId, Accept: 'application/json' },
      timeoutMs: 5000 as const,
      maxRetries: 2 as const,
    };
    this.mimirClient = new HttpClient({ clientName: 'grafana-cloud-mimir', baseUrl: `${grafanaBaseUrl}/api/prom`, ...common });
    this.lokiClient = new HttpClient({ clientName: 'grafana-cloud-loki', baseUrl: `${grafanaBaseUrl}/loki/api/v1`, ...common });
    this.tempoClient = new HttpClient({ clientName: 'grafana-cloud-tempo', baseUrl: `${grafanaBaseUrl}/tempo/api`, ...common });
  }

  async getContextSnapshot(serviceLabel: string, incidentId: string): Promise<GrafanaContextSnapshot> {
    logger.info({ incident_id: incidentId, service_label: serviceLabel }, 'Querying Grafana Cloud for incident context snapshot');
    const now = Math.floor(Date.now() / 1000);
    const twoHoursAgo = now - 7200;
    const datasourceErrors: string[] = [];

    const [errorRateResult, p99Result, logResult, traceResult] = await Promise.allSettled([
      this.queryErrorRate(serviceLabel, twoHoursAgo, now),
      this.queryP99Latency(serviceLabel, now),
      this.queryRecentErrors(serviceLabel, twoHoursAgo, now),
      this.queryRecentTraces(serviceLabel),
    ]);

    let errorRate = { current: 0, baseline: 0, series_url: '' };
    if (errorRateResult.status === 'fulfilled') errorRate = errorRateResult.value;
    else
      datasourceErrors.push(
        `Mimir error rate: ${errorRateResult.reason instanceof Error ? errorRateResult.reason.message : String(errorRateResult.reason)}`,
      );

    let p99Latency = { current: 0, baseline: 0 };
    if (p99Result.status === 'fulfilled') p99Latency = p99Result.value;
    else datasourceErrors.push(`Mimir p99: ${p99Result.reason instanceof Error ? p99Result.reason.message : String(p99Result.reason)}`);

    let logExcerpts: string[] = [];
    if (logResult.status === 'fulfilled') logExcerpts = logResult.value;
    else datasourceErrors.push(`Loki: ${logResult.reason instanceof Error ? logResult.reason.message : String(logResult.reason)}`);

    let traceIds: string[] = [];
    if (traceResult.status === 'fulfilled') traceIds = traceResult.value;
    else datasourceErrors.push(`Tempo: ${traceResult.reason instanceof Error ? traceResult.reason.message : String(traceResult.reason)}`);

    const errorBudgetBurnRate =
      errorRate.current > 0 && errorRate.baseline > 0 ? errorRate.current / Math.max(errorRate.baseline, 0.001) : 0;

    return {
      queried_at: new Date().toISOString(),
      error_rate_2h: errorRate,
      p99_latency_ms: p99Latency,
      error_budget_burn_rate: errorBudgetBurnRate,
      log_excerpts: logExcerpts.slice(0, 10),
      sample_trace_ids: traceIds.slice(0, 5),
      ...(datasourceErrors.length > 0 ? { datasource_errors: datasourceErrors } : {}),
    };
  }

  private async queryErrorRate(
    svc: string,
    _start: number,
    end: number,
  ): Promise<{ current: number; baseline: number; series_url: string }> {
    const [cur, base] = await Promise.all([
      this.mimirClient.get<MimirQueryResult>(
        `/query?query=${encodeURIComponent(`sum(rate(http_requests_total{service="${svc}",status=~"5.."}[5m]))/sum(rate(http_requests_total{service="${svc}"}[5m]))`)}&time=${end}`,
      ),
      this.mimirClient.get<MimirQueryResult>(
        `/query?query=${encodeURIComponent(`sum(rate(http_requests_total{service="${svc}",status=~"5.."}[2h]))/sum(rate(http_requests_total{service="${svc}"}[2h]))`)}&time=${end}`,
      ),
    ]);
    return { current: this.val(cur.ok ? cur.data : null), baseline: this.val(base.ok ? base.data : null), series_url: '' };
  }

  private async queryP99Latency(svc: string, end: number): Promise<{ current: number; baseline: number }> {
    const [cur, base] = await Promise.all([
      this.mimirClient.get<MimirQueryResult>(
        `/query?query=${encodeURIComponent(`histogram_quantile(0.99,sum by(le)(rate(http_request_duration_seconds_bucket{service="${svc}"}[5m])))*1000`)}&time=${end}`,
      ),
      this.mimirClient.get<MimirQueryResult>(
        `/query?query=${encodeURIComponent(`histogram_quantile(0.99,sum by(le)(rate(http_request_duration_seconds_bucket{service="${svc}"}[2h])))*1000`)}&time=${end}`,
      ),
    ]);
    return { current: this.val(cur.ok ? cur.data : null), baseline: this.val(base.ok ? base.data : null) };
  }

  private async queryRecentErrors(svc: string, start: number, end: number): Promise<string[]> {
    const resp = await this.lokiClient.get<LokiQueryResult>(
      `/query_range?query=${encodeURIComponent(`{service="${svc}"} |= "error" | level="error"`)}&start=${start}&end=${end}&limit=10&direction=backward`,
    );
    if (!resp.ok) return [];
    const excerpts: string[] = [];
    for (const stream of resp.data.data.result) {
      for (const [, line] of stream.values) {
        excerpts.push(line.substring(0, 200));
        if (excerpts.length >= 10) break;
      }
      if (excerpts.length >= 10) break;
    }
    return excerpts;
  }

  private async queryRecentTraces(svc: string): Promise<string[]> {
    const resp = await this.tempoClient.get<TempoSearchResult>(
      `/search?service.name=${encodeURIComponent(svc)}&limit=5&start=${Math.floor(Date.now() / 1000) - 3600}`,
    );
    if (!resp.ok) return [];
    return resp.data.traces.map((t) => t.traceID).slice(0, 5);
  }

  private val(data: MimirQueryResult | null): number {
    if (!data || !data.data.result[0]) return 0;
    const r = data.data.result[0];
    const v = r.value?.[1] ?? r.values?.[0]?.[1];
    if (!v) return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
}
