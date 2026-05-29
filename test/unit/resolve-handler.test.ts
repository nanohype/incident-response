/**
 * Unit tests for /marshal resolve handler.
 * Exercises the 6-step flow: load → AI postmortem → Linear draft → nudge delete → pulse rating → status flip.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { makeResolveHandler, type ResolveDeps } from '../../src/commands/resolve.js';
import type { CommandContext } from '../../src/services/command-registry.js';
import type { MarshalAI } from '../../src/ai/marshal-ai.js';
import type { LinearMarshalClient } from '../../src/clients/linear-client.js';
import type { GitHubClient } from '../../src/clients/github-client.js';
import type { NudgeScheduler } from '../../src/services/nudge-scheduler.js';
import type { AuditWriter } from '../../src/utils/audit.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

function mkDeps(): ResolveDeps {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
  const marshalAI = { generatePostmortemSections: jest.fn().mockResolvedValue('postmortem body') } as unknown as MarshalAI;
  const linearClient = {
    createPostmortemDraft: jest.fn().mockResolvedValue({
      incident_id: 'inc-1',
      linear_issue_id: 'LIN-1',
      linear_issue_url: 'https://linear.app/x/issue/LIN-1',
      title: 'pm',
      created_at: new Date().toISOString(),
      sla_deadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    }),
  } as unknown as LinearMarshalClient;
  const githubClient = { getRecentCommits: jest.fn().mockResolvedValue([]) } as unknown as GitHubClient;
  const nudgeScheduler = { deleteNudge: jest.fn().mockResolvedValue(undefined) } as unknown as NudgeScheduler;
  const auditWriter = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditWriter;
  return { docClient, incidentsTableName: 'tbl', marshalAI, linearClient, githubClient, nudgeScheduler, auditWriter, githubRepoNames: [] };
}

function mkCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const slack = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1' }) } };
  return {
    subCommand: 'resolve',
    args: [],
    incidentId: 'inc-1',
    userId: 'U-ic',
    channelId: 'C1',
    rawCommand: {} as never,
    slack: slack as never,
    respond: jest.fn() as never,
    ...overrides,
  };
}

const ACTIVE_INCIDENT = {
  PK: 'INCIDENT#inc-1',
  SK: 'METADATA',
  incident_id: 'inc-1',
  status: 'ROOM_ASSEMBLED',
  severity: 'P1',
  alert_payload: { alert_group: { title: 'Database latency' } },
  slack_channel_id: 'C1',
  slack_channel_name: 'marshal-p1-...',
  responders: ['U-resp-1'],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  correlation_id: 'inc-1',
};

describe('/marshal resolve', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('RESOLVE-001: no active incident → responds, no writes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const deps = mkDeps();
    const ctx = mkCtx();
    await makeResolveHandler(deps)(ctx);
    expect(ctx.respond).toHaveBeenCalledWith({ text: expect.stringContaining('No active incident') });
    expect(deps.linearClient.createPostmortemDraft).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('RESOLVE-002: already-resolved incident → informational reply, no side effects', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...ACTIVE_INCIDENT, status: 'RESOLVED', linear_postmortem_id: 'LIN-42' } });
    const deps = mkDeps();
    const ctx = mkCtx();
    await makeResolveHandler(deps)(ctx);
    expect(ctx.respond).toHaveBeenCalledWith({ text: expect.stringContaining('already resolved') });
    expect(deps.linearClient.createPostmortemDraft).not.toHaveBeenCalled();
    expect(deps.nudgeScheduler.deleteNudge).not.toHaveBeenCalled();
  });

  it('RESOLVE-003: happy path → postmortem created, nudge deleted, status RESOLVED, audit events written', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ACTIVE_INCIDENT });
    ddbMock.on(UpdateCommand).resolves({});
    const deps = mkDeps();
    const ctx = mkCtx();

    await makeResolveHandler(deps)(ctx);

    expect(deps.marshalAI.generatePostmortemSections).toHaveBeenCalled();
    expect(deps.linearClient.createPostmortemDraft).toHaveBeenCalled();
    expect(deps.nudgeScheduler.deleteNudge).toHaveBeenCalledWith('inc-1');
    expect(deps.auditWriter.write).toHaveBeenCalledWith(
      'inc-1',
      'U-ic',
      'POSTMORTEM_CREATED',
      expect.objectContaining({ linear_issue_id: 'LIN-1' }),
    );
    expect(deps.auditWriter.write).toHaveBeenCalledWith(
      'inc-1',
      'U-ic',
      'INCIDENT_RESOLVED',
      expect.objectContaining({ had_postmortem: true }),
    );
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[0]!.input.ExpressionAttributeValues![':status']).toBe('RESOLVED');
    expect(ctx.slack.chat.postMessage as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('resolved') }),
    );
  });

  it('RESOLVE-004: Linear failure → still marks resolved, emits had_postmortem:false', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ACTIVE_INCIDENT });
    ddbMock.on(UpdateCommand).resolves({});
    const deps = mkDeps();
    (deps.linearClient.createPostmortemDraft as jest.Mock).mockRejectedValueOnce(new Error('Linear down'));
    const ctx = mkCtx();

    await makeResolveHandler(deps)(ctx);

    expect(deps.auditWriter.write).not.toHaveBeenCalledWith('inc-1', 'U-ic', 'POSTMORTEM_CREATED', expect.anything());
    expect(deps.auditWriter.write).toHaveBeenCalledWith(
      'inc-1',
      'U-ic',
      'INCIDENT_RESOLVED',
      expect.objectContaining({ had_postmortem: false }),
    );
    expect(ctx.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Linear postmortem creation failed') }),
    );
  });

  it('RESOLVE-005: fetches recent commits for each configured repo', async () => {
    ddbMock.on(GetCommand).resolves({ Item: ACTIVE_INCIDENT });
    ddbMock.on(UpdateCommand).resolves({});
    const deps = { ...mkDeps(), githubRepoNames: ['svc-api', 'svc-worker'] };
    const ctx = mkCtx();
    await makeResolveHandler(deps)(ctx);
    expect(deps.githubClient.getRecentCommits).toHaveBeenCalledWith('svc-api', 'inc-1');
    expect(deps.githubClient.getRecentCommits).toHaveBeenCalledWith('svc-worker', 'inc-1');
  });
});
