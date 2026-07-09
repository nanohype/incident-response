/**
 * Unit tests for the MCP tool dispatcher (READ + DRAFT ONLY).
 *
 * Dependencies are faked at the interface: the DynamoDB client via the
 * repo's aws-sdk-client-mock, and the approval gate / AI as plain objects. The
 * MCP SDK itself is never mocked. The invariant under test: the tool surface
 * can DRAFT (PENDING_APPROVAL) and READ, but exposes no approve/publish/resolve
 * — those stay human on the Slack surface.
 */

import type { Mock } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-vitest/extend';

import { callTool, listTools, type McpToolDeps, type ToolResult } from '../../src/mcp/tools.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

interface Fakes extends McpToolDeps {
  approvalGate: { createDraft: Mock };
  incidentResponseAI: { generatePostmortemSections: Mock };
}

function mkDeps(): Fakes {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
  return {
    docClient,
    incidentsTableName: 'incidents',
    auditTableName: 'audit',
    approvalGate: {
      createDraft: vi.fn().mockResolvedValue({
        draft_id: 'draft-inc-1-1',
        incident_id: 'inc-1',
        body: 'Some customers may be affected.',
        body_sha256: 'abc',
        affected_component_ids: ['comp-1'],
        status: 'PENDING_APPROVAL',
        created_at: new Date().toISOString(),
      }),
    },
    incidentResponseAI: {
      generatePostmortemSections: vi.fn().mockResolvedValue('## Incident Summary\n...'),
    },
    draftActorId: 'claude-tag-mcp',
  } as Fakes;
}

const INCIDENT = {
  PK: 'INCIDENT#inc-1',
  SK: 'METADATA',
  incident_id: 'inc-1',
  status: 'ACTIVE',
  severity: 'P1',
  alert_payload: { alert_group: { title: 'Database latency' } },
  slack_channel_id: 'C-1',
  responders: ['U-1', 'U-2'],
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:05:00.000Z',
};

function textOf(result: ToolResult): string {
  return result.content[0]!.text;
}

beforeEach(() => ddbMock.reset());

describe('listTools', () => {
  it('MCP-000: advertises exactly the read + draft surface — no approve/publish/resolve', () => {
    const names = listTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'draft_postmortem',
      'draft_statuspage_update',
      'get_incident',
      'list_open',
    ]);
  });
});

describe('get_incident', () => {
  it('MCP-001: returns incident summary + audit timeline', async () => {
    ddbMock.on(GetCommand).resolves({ Item: INCIDENT });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          action_type: 'WAR_ROOM_CREATED',
          actor_user_id: 'U-1',
          timestamp: '2026-07-01T00:01:00.000Z',
          details: { channel_id: 'C-1' },
        },
      ],
    });
    const result = await callTool(mkDeps(), 'get_incident', { incidentId: 'inc-1' });
    const payload = JSON.parse(textOf(result)) as {
      incident: { status: string; responders: number };
      timeline: { action_type: string }[];
    };
    expect(payload.incident.status).toBe('ACTIVE');
    expect(payload.incident.responders).toBe(2);
    expect(payload.timeline[0]!.action_type).toBe('WAR_ROOM_CREATED');
  });

  it('MCP-002: unknown incident → tool error', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await callTool(mkDeps(), 'get_incident', { incidentId: 'nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not found');
  });

  it('MCP-003: missing incidentId → validation tool error', async () => {
    const result = await callTool(mkDeps(), 'get_incident', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/incidentId|expected string/i);
  });
});

describe('list_open', () => {
  it('MCP-004: scans and returns open incident summaries', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [INCIDENT] });
    const result = await callTool(mkDeps(), 'list_open', {});
    const payload = JSON.parse(textOf(result)) as { count: number; incidents: unknown[] };
    expect(payload.count).toBe(1);
    const scan = ddbMock.commandCalls(ScanCommand)[0]!.args[0]!.input;
    expect(scan.ExpressionAttributeValues).toMatchObject({ ':resolved': 'RESOLVED' });
  });

  it('MCP-005: empty backend → zero count', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    const result = await callTool(mkDeps(), 'list_open', {});
    expect(JSON.parse(textOf(result))).toMatchObject({ count: 0 });
  });
});

describe('draft_statuspage_update', () => {
  it('MCP-006: creates a PENDING_APPROVAL draft attributed to the MCP service actor — publishes nothing', async () => {
    const deps = mkDeps();
    const result = await callTool(deps, 'draft_statuspage_update', {
      incidentId: 'inc-1',
      body: 'Some customers may be affected.',
      affectedComponentIds: ['comp-1'],
    });
    expect(deps.approvalGate.createDraft).toHaveBeenCalledWith(
      'inc-1',
      'Some customers may be affected.',
      ['comp-1'],
      'claude-tag-mcp',
    );
    const payload = JSON.parse(textOf(result)) as { draft: { status: string }; note: string };
    expect(payload.draft.status).toBe('PENDING_APPROVAL');
    expect(payload.note).toContain('Approve & Publish');
  });

  it('MCP-007: defaults affectedComponentIds to []', async () => {
    const deps = mkDeps();
    await callTool(deps, 'draft_statuspage_update', { incidentId: 'inc-1', body: 'x' });
    expect(deps.approvalGate.createDraft).toHaveBeenCalledWith('inc-1', 'x', [], 'claude-tag-mcp');
  });

  it('MCP-008: empty body → validation tool error, gate not called', async () => {
    const deps = mkDeps();
    const result = await callTool(deps, 'draft_statuspage_update', {
      incidentId: 'inc-1',
      body: '',
    });
    expect(result.isError).toBe(true);
    expect(deps.approvalGate.createDraft).not.toHaveBeenCalled();
  });
});

describe('draft_postmortem', () => {
  it('MCP-009: returns the Bedrock postmortem draft markdown without changing state', async () => {
    ddbMock.on(GetCommand).resolves({ Item: INCIDENT });
    const deps = mkDeps();
    const result = await callTool(deps, 'draft_postmortem', { incidentId: 'inc-1' });
    expect(deps.incidentResponseAI.generatePostmortemSections).toHaveBeenCalled();
    const payload = JSON.parse(textOf(result)) as { incident_id: string; markdown: string };
    expect(payload.incident_id).toBe('inc-1');
    expect(payload.markdown).toContain('Incident Summary');
  });

  it('MCP-010: unknown incident → tool error, AI not called', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const deps = mkDeps();
    const result = await callTool(deps, 'draft_postmortem', { incidentId: 'nope' });
    expect(result.isError).toBe(true);
    expect(deps.incidentResponseAI.generatePostmortemSections).not.toHaveBeenCalled();
  });
});

describe('protocol', () => {
  it('MCP-011: an unknown tool is a protocol error (re-thrown), not a tool result', async () => {
    await expect(callTool(mkDeps(), 'approve_and_publish', {})).rejects.toThrow(/Unknown tool/);
  });
});
