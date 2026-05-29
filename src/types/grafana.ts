/**
 * Grafana OnCall + Grafana Cloud contract types.
 *
 * The OnCall webhook schema below is the SINGLE SOURCE OF TRUTH. The
 * TypeScript type is inferred from the Zod schema, and the Lambda ingress
 * handler uses the schema for runtime validation — a change to one updates
 * the other at compile time.
 */

import { z } from 'zod';

export const GrafanaOnCallPayloadSchema = z.object({
  alert_group_id: z.string().min(1),
  alert_group: z.object({
    id: z.string(),
    title: z.string(),
    state: z.enum(['firing', 'resolved', 'silenced']),
  }),
  integration_id: z.string().min(1),
  route_id: z.string(),
  team_id: z.string(),
  team_name: z.string(),
  labels: z.record(z.string()).optional(),
  alerts: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        message: z.string(),
        image_url: z.string().optional(),
        source_url: z.string().optional(),
        received_at: z.string(), // ISO 8601
      }),
    )
    .min(1),
});

export type GrafanaOnCallAlertPayload = z.infer<typeof GrafanaOnCallPayloadSchema>;

export interface GrafanaOnCallUser {
  pk: string;
  email: string;
  username: string;
  name: string;
  role: string;
}

export interface GrafanaOnCallEscalationChain {
  id: string;
  name: string;
  steps: Array<{
    id: string;
    type: string;
    notify_to_users_queue?: GrafanaOnCallUser[];
    notify_on_call_from_schedule?: string;
  }>;
}

export interface GrafanaContextSnapshot {
  queried_at: string;
  error_rate_2h: {
    current: number;
    baseline: number;
    series_url: string;
  };
  p99_latency_ms: {
    current: number;
    baseline: number;
  };
  error_budget_burn_rate: number;
  log_excerpts: string[];
  sample_trace_ids: string[];
  datasource_errors?: string[];
}
