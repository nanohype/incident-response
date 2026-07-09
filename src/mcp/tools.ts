/**
 * The MCP pull surface — READ + DRAFT ONLY.
 *
 * Claude Tag (and any Claude surface reaching in over the tunnel) can read
 * incident state and DRAFT customer-facing / internal artefacts. It CANNOT
 * approve, publish, or resolve: those are irreversible, compliance-gated, and
 * human-attributed, so they stay on the signed-HTTP Slack surface where a human
 * clicks with their own id. This boundary is the whole point of the port —
 * the agent assembles and drafts; a human approves.
 *
 * Tools:
 *   - get_incident(incidentId)                       → state + audit timeline
 *   - list_open()                                    → open incidents
 *   - draft_statuspage_update(incidentId, body, …)   → createDraft → PENDING_APPROVAL (publishes NOTHING)
 *   - draft_postmortem(incidentId)                   → Bedrock postmortem draft (internal doc text)
 */

import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { StatuspageApprovalGate } from '../services/statuspage-approval-gate.js';
import type { IncidentResponseAI, PostmortemInput } from '../ai/incident-response-ai.js';
import type { AuditEvent, IncidentRecord } from '../types/index.js';

export interface McpToolDeps {
  docClient: DynamoDBDocumentClient;
  incidentsTableName: string;
  auditTableName: string;
  /** Only `createDraft` is reachable — approve/publish is NOT exposed to MCP. */
  approvalGate: Pick<StatuspageApprovalGate, 'createDraft'>;
  incidentResponseAI: Pick<IncidentResponseAI, 'generatePostmortemSections'>;
  /**
   * Identity recorded as the CREATOR of an MCP-drafted Statuspage update. Never
   * the approver — the human who clicks Approve & Publish in Slack is attributed
   * at publish. A fixed service actor, never an LLM-supplied value.
   */
  draftActorId: string;
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The exact tool list the server advertises on `tools/list`. */
export function listTools(): ToolDescriptor[] {
  return [
    {
      name: 'get_incident',
      description:
        'Fetch one incident: its current state (status, severity, responders, channel, timestamps) plus the full audit timeline (every logged action with actor and timestamp). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          incidentId: {
            type: 'string',
            description: 'The canonical incident id (= Grafana OnCall alert_group_id).',
          },
        },
        required: ['incidentId'],
      },
    },
    {
      name: 'list_open',
      description:
        'List all open incidents (status not RESOLVED) with a one-line summary each: id, status, severity, title, responder count, created_at. Read-only.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'draft_statuspage_update',
      description:
        'Compose a customer-facing status page message and persist it as a PENDING_APPROVAL draft. Publishes NOTHING — a human Incident Commander must click "Approve & Publish" in Slack, which is the only path that reaches the status page and records the human as approver. Returns the stored draft.',
      inputSchema: {
        type: 'object',
        properties: {
          incidentId: { type: 'string', description: 'The canonical incident id.' },
          body: {
            type: 'string',
            description:
              'The customer-facing message body. Generic language only (no customer names, account ids, hostnames, IPs).',
          },
          affectedComponentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional Statuspage component ids affected by this incident.',
          },
        },
        required: ['incidentId', 'body'],
      },
    },
    {
      name: 'draft_postmortem',
      description:
        'Generate a postmortem draft (Markdown, internal document) for an incident from its persisted state — the same Bedrock-backed draft the resolve flow produces. Root Cause Analysis and Action Items are left for the IC to complete. Creates no Linear issue and changes no incident state.',
      inputSchema: {
        type: 'object',
        properties: {
          incidentId: { type: 'string', description: 'The canonical incident id.' },
        },
        required: ['incidentId'],
      },
    },
  ];
}

// ── Input validation ─────────────────────────────────────────────────────────
// Tool arguments arrive from an LLM client and the declared inputSchema is
// advisory. Every argument is re-parsed with Zod at this boundary. Failures
// throw a ZodError; `callTool` folds it into an `isError` result so the calling
// model can self-correct.
const getIncidentArgs = z.object({ incidentId: z.string().min(1, 'incidentId is required') });
const draftStatuspageArgs = z.object({
  incidentId: z.string().min(1, 'incidentId is required'),
  body: z.string().min(1, 'body must be a non-empty string'),
  affectedComponentIds: z.array(z.string()).optional(),
});
const draftPostmortemArgs = z.object({ incidentId: z.string().min(1, 'incidentId is required') });
const noArgs = z.object({}).strip();

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: true;
};

/** Marker for a tool the server never advertised — a protocol error, re-thrown. */
class UnknownToolError extends Error {}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const POSTMORTEM_DURATION_FALLBACK_MINUTES = 30;
function durationMinutes(created_at: string): number {
  const minutes = Math.round((Date.now() - new Date(created_at).getTime()) / 60000);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : POSTMORTEM_DURATION_FALLBACK_MINUTES;
}

async function loadIncident(
  deps: McpToolDeps,
  incidentId: string,
): Promise<IncidentRecord | undefined> {
  const result = await deps.docClient.send(
    new GetCommand({
      TableName: deps.incidentsTableName,
      Key: { PK: `INCIDENT#${incidentId}`, SK: 'METADATA' },
    }),
  );
  return result.Item as IncidentRecord | undefined;
}

/** Shape an incident record into the read summary returned to the caller. */
function toSummary(incident: IncidentRecord): Record<string, unknown> {
  return {
    incident_id: incident.incident_id,
    status: incident.status,
    severity: incident.severity,
    title: incident.alert_payload?.alert_group?.title ?? null,
    responders: incident.responders?.length ?? 0,
    slack_channel_id: incident.slack_channel_id ?? null,
    created_at: incident.created_at,
    updated_at: incident.updated_at,
    resolved_at: incident.resolved_at ?? null,
  };
}

export async function callTool(
  deps: McpToolDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  try {
    return await dispatchTool(deps, name, args);
  } catch (err) {
    if (err instanceof UnknownToolError) throw err;
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join('; ')
        : err instanceof Error
          ? err.message
          : String(err);
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

async function dispatchTool(
  deps: McpToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_incident': {
      const { incidentId } = getIncidentArgs.parse(args);
      const incident = await loadIncident(deps, incidentId);
      if (!incident) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Incident ${incidentId} not found` }],
        };
      }
      const timelineResult = await deps.docClient.send(
        new QueryCommand({
          TableName: deps.auditTableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk_prefix)',
          ExpressionAttributeValues: { ':pk': `INCIDENT#${incidentId}`, ':sk_prefix': 'AUDIT#' },
        }),
      );
      const timeline = (timelineResult.Items ?? []).map((raw) => {
        const e = raw as AuditEvent;
        return {
          action_type: e.action_type,
          actor_user_id: e.actor_user_id,
          timestamp: e.timestamp,
          details: e.details,
        };
      });
      return json({ incident: toSummary(incident), timeline });
    }
    case 'list_open': {
      noArgs.parse(args);
      const result = await deps.docClient.send(
        new ScanCommand({
          TableName: deps.incidentsTableName,
          FilterExpression: 'SK = :sk AND #status <> :resolved',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':sk': 'METADATA', ':resolved': 'RESOLVED' },
        }),
      );
      const open = (result.Items ?? []).map((i) => toSummary(i as IncidentRecord));
      return json({ count: open.length, incidents: open });
    }
    case 'draft_statuspage_update': {
      const { incidentId, body, affectedComponentIds } = draftStatuspageArgs.parse(args);
      // createDraft writes a PENDING_APPROVAL draft and publishes nothing. The
      // creator is the fixed MCP service actor; the human approver is attributed
      // later, in Slack, by the gate.
      const draft = await deps.approvalGate.createDraft(
        incidentId,
        body,
        affectedComponentIds ?? [],
        deps.draftActorId,
      );
      return json({
        draft,
        note: 'PENDING_APPROVAL — a human IC must Approve & Publish in Slack.',
      });
    }
    case 'draft_postmortem': {
      const { incidentId } = draftPostmortemArgs.parse(args);
      const incident = await loadIncident(deps, incidentId);
      if (!incident) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Incident ${incidentId} not found` }],
        };
      }
      const pmInput: PostmortemInput = {
        incident_id: incident.incident_id,
        title: incident.alert_payload?.alert_group?.title ?? 'P1 Incident',
        slack_channel_name: incident.slack_channel_name ?? '(unknown)',
        duration_minutes: durationMinutes(incident.created_at),
        timeline_events: [],
        participants: (incident.responders ?? []).map((u) => ({ name: u, role: 'responder' })),
        metrics_summary: incident.context_snapshot
          ? `error rate ${(incident.context_snapshot.error_rate_2h.current * 100).toFixed(2)}%, p99 ${incident.context_snapshot.p99_latency_ms.current.toFixed(0)}ms`
          : 'no context snapshot captured',
        recent_deploys: [],
        statuspage_updates: [],
      };
      const markdown = await deps.incidentResponseAI.generatePostmortemSections(
        pmInput,
        incidentId,
      );
      return json({ incident_id: incidentId, markdown });
    }
    default:
      throw new UnknownToolError(`Unknown tool: ${name}`);
  }
}

/** Wire the tool handlers onto an MCP server. */
export function registerTools(server: Server, deps: McpToolDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(deps, name, args ?? {});
  });
}
