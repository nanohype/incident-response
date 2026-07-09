/**
 * End-to-end MCP wiring: a real MCP client speaks the streamable-HTTP transport
 * to a real in-process server. Nothing in the MCP SDK is mocked — only the
 * app's own dependencies are faked (DynamoDB via aws-sdk-client-mock, gate + AI
 * as objects). This exercises server.ts the way a Claude surface would over the
 * tunnel.
 */

import { AddressInfo } from 'node:net';
import http from 'node:http';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpServer, type McpHttpServer } from '../../src/mcp/server.js';
import type { McpToolDeps } from '../../src/mcp/tools.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeDeps(): McpToolDeps {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
  return {
    docClient,
    incidentsTableName: 'incidents',
    auditTableName: 'audit',
    approvalGate: {
      createDraft: vi.fn().mockResolvedValue({
        draft_id: 'draft-1',
        incident_id: 'inc-1',
        body: 'Some customers affected.',
        body_sha256: 'abc',
        affected_component_ids: [],
        status: 'PENDING_APPROVAL',
        created_at: new Date().toISOString(),
      }),
    } as unknown as McpToolDeps['approvalGate'],
    incidentResponseAI: {
      generatePostmortemSections: vi.fn().mockResolvedValue('## Incident Summary'),
    } as unknown as McpToolDeps['incidentResponseAI'],
    draftActorId: 'claude-tag-mcp',
  };
}

async function port(server: McpHttpServer): Promise<number> {
  const scratch = http.createServer();
  await new Promise<void>((resolve) => scratch.listen(0, resolve));
  const p = (scratch.address() as AddressInfo).port;
  await new Promise<void>((resolve) => scratch.close(() => resolve()));
  await server.listen(p);
  return p;
}

describe('MCP streamable-HTTP server (end-to-end)', () => {
  let server: McpHttpServer;
  let client: Client;

  beforeEach(async () => {
    ddbMock.reset();
    server = createMcpHttpServer(makeDeps());
    const p = await port(server);
    const url = new URL(`http://127.0.0.1:${p}/mcp`);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    // exactOptionalPropertyTypes vs the SDK's transport typings — see server.ts.
    await client.connect(new StreamableHTTPClientTransport(url) as unknown as never);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('MCP-SRV-001: advertises the four read + draft tools over the transport', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'draft_postmortem',
      'draft_statuspage_update',
      'get_incident',
      'list_open',
    ]);
  });

  it('MCP-SRV-002: list_open returns open incidents through the transport', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          incident_id: 'inc-1',
          status: 'ACTIVE',
          severity: 'P1',
          alert_payload: { alert_group: { title: 'x' } },
          responders: [],
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
    const result = await client.callTool({ name: 'list_open', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ count: 1 });
  });

  it('MCP-SRV-003: get_incident on a missing incident surfaces a tool error', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await client.callTool({ name: 'get_incident', arguments: { incidentId: 'x' } });
    expect(result.isError).toBe(true);
  });

  it('MCP-SRV-004: a bad argument is a tool error, not a broken connection', async () => {
    const result = await client.callTool({
      name: 'draft_statuspage_update',
      arguments: { incidentId: 'inc-1', body: '' },
    });
    expect(result.isError).toBe(true);
  });
});
