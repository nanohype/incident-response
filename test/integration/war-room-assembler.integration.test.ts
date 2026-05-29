/**
 * Integration tests for WarRoomAssembler.assemble against real dynamodb-local.
 *
 * External boundaries (Slack, WorkOS, Grafana OnCall, Grafana Cloud, EventBridge Scheduler)
 * are stubbed at the constructor seam. Everything else — AuditWriter, state-machine transitions
 * (ALERT_RECEIVED → ROOM_ASSEMBLING → ROOM_ASSEMBLED), IncidentRecord persistence, Slack-blocks
 * assembly — runs through the real code path against real DynamoDB.
 *
 * Requires dynamodb-local on localhost:8000. See package.json `test:integration:docker`.
 */

import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { WarRoomAssembler } from '../../src/services/war-room-assembler.js';
import { AuditWriter } from '../../src/utils/audit.js';
import { GrafanaOnCallAlertPayload, GrafanaContextSnapshot } from '../../src/types/index.js';
import { createSlackAdapter } from '../../src/adapters/slack-adapter.js';
import { ddbLocalDoc, createAuditTable, deleteAuditTable, createIncidentsTable, deleteIncidentsTable } from './setup.js';

const AUDIT_TABLE = 'marshal-audit-war-room-int';
const INCIDENTS_TABLE = 'marshal-incidents-war-room-int';

// Narrow stub surface — only the methods WarRoomAssembler.assemble actually calls.
type SlackStub = {
  conversations: {
    create: jest.Mock;
    invite: jest.Mock;
  };
  chat: { postMessage: jest.Mock };
  pins: { add: jest.Mock };
  users: { lookupByEmail: jest.Mock };
};

function makeSlackStub(
  overrides: Partial<{
    createOk: boolean;
    channelId: string;
    channelName: string;
    postMessageTs: string | null;
  }> = {},
): SlackStub {
  const channelId = overrides.channelId ?? 'C-WAR-ROOM';
  const channelName = overrides.channelName ?? 'marshal-p1-20260416-abc123';
  return {
    conversations: {
      create: jest
        .fn()
        .mockResolvedValue(
          overrides.createOk === false ? { ok: false, error: 'name_taken' } : { ok: true, channel: { id: channelId, name: channelName } },
        ),
      invite: jest.fn().mockResolvedValue({ ok: true }),
    },
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: overrides.postMessageTs ?? '1734567890.123' }),
    },
    pins: { add: jest.fn().mockResolvedValue({ ok: true }) },
    users: {
      lookupByEmail: jest
        .fn()
        .mockImplementation(({ email }: { email: string }) => Promise.resolve({ ok: true, user: { id: `U-${email.split('@')[0]}` } })),
    },
  };
}

function makeWorkOSStub(users: Array<{ id: string; email: string; first_name: string; last_name: string; state: 'active' }> = []) {
  return {
    getUsersInGroup: jest.fn().mockResolvedValue(users),
  };
}

function makeGrafanaOnCallStub(chain: unknown = null, emails: string[] = []) {
  return {
    getEscalationChainForIntegration: jest.fn().mockResolvedValue(chain),
    extractEmailsFromChain: jest.fn().mockReturnValue(emails),
  };
}

function makeGrafanaCloudStub(snapshot?: GrafanaContextSnapshot | null) {
  return {
    getContextSnapshot: jest
      .fn()
      .mockImplementation(() =>
        snapshot === null ? Promise.reject(new Error('Mimir unreachable')) : Promise.resolve(snapshot ?? undefined),
      ),
  };
}

const nudgeStub = { scheduleNudge: jest.fn().mockResolvedValue(undefined) };

function alertPayload(overrides: Partial<GrafanaOnCallAlertPayload> = {}): GrafanaOnCallAlertPayload {
  const id = overrides.alert_group_id ?? `int-alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    alert_group_id: id,
    alert_group: { id, title: 'P1 checkout service 500s', state: 'firing' },
    integration_id: 'grafana-integration-prod',
    route_id: 'route-critical',
    team_id: 'team-platform',
    team_name: 'Platform',
    alerts: [
      {
        id: 'a1',
        title: 'P1 checkout service 500s',
        message: 'error rate > 5% on /checkout',
        received_at: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

async function seedIncident(incidentId: string): Promise<void> {
  await ddbLocalDoc.send(
    new PutCommand({
      TableName: INCIDENTS_TABLE,
      Item: {
        PK: `INCIDENT#${incidentId}`,
        SK: 'METADATA',
        incident_id: incidentId,
        status: 'ALERT_RECEIVED',
        severity: 'P1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        responders: [],
        TTL: Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60,
      },
    }),
  );
}

async function readIncident(incidentId: string) {
  const r = await ddbLocalDoc.send(
    new GetCommand({
      TableName: INCIDENTS_TABLE,
      Key: { PK: `INCIDENT#${incidentId}`, SK: 'METADATA' },
    }),
  );
  return r.Item;
}

async function readAuditActions(incidentId: string): Promise<string[]> {
  const r = await ddbLocalDoc.send(
    new QueryCommand({
      TableName: AUDIT_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk_prefix)',
      ExpressionAttributeValues: { ':pk': `INCIDENT#${incidentId}`, ':sk_prefix': 'AUDIT#' },
      ConsistentRead: true,
    }),
  );
  return (r.Items ?? []).map((i) => i['action_type'] as string);
}

function buildAssembler(
  slack: SlackStub,
  workos: ReturnType<typeof makeWorkOSStub>,
  oncall: ReturnType<typeof makeGrafanaOnCallStub>,
  cloud: ReturnType<typeof makeGrafanaCloudStub>,
) {
  const auditWriter = new AuditWriter(ddbLocalDoc, AUDIT_TABLE);
  const slackAdapter = createSlackAdapter(slack as never);
  return new WarRoomAssembler(
    slackAdapter,
    ddbLocalDoc,
    INCIDENTS_TABLE,
    workos as never,
    oncall as never,
    cloud as never,
    auditWriter,
    nudgeStub as never,
    'test-org',
    undefined,
  );
}

describe('WarRoomAssembler — integration vs dynamodb-local', () => {
  const ORIGINAL_ENV = process.env['WORKOS_TEAM_GROUP_MAP'];

  beforeAll(async () => {
    await createAuditTable(AUDIT_TABLE);
    await createIncidentsTable(INCIDENTS_TABLE);
  });

  afterAll(async () => {
    await deleteAuditTable(AUDIT_TABLE);
    await deleteIncidentsTable(INCIDENTS_TABLE);
  });

  beforeEach(() => {
    process.env['WORKOS_TEAM_GROUP_MAP'] = JSON.stringify({ 'team-platform': 'directory_group_01abc' });
    nudgeStub.scheduleNudge.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env['WORKOS_TEAM_GROUP_MAP'];
    else process.env['WORKOS_TEAM_GROUP_MAP'] = ORIGINAL_ENV;
  });

  it('INT-ASSEMBLE-001: happy path — assembles, persists ROOM_ASSEMBLED, writes full audit chain', async () => {
    const alert = alertPayload();
    await seedIncident(alert.alert_group_id);

    const slack = makeSlackStub();
    const workos = makeWorkOSStub([
      { id: 'u1', email: 'alice@example.com', first_name: 'Alice', last_name: 'A', state: 'active' },
      { id: 'u2', email: 'bob@example.com', first_name: 'Bob', last_name: 'B', state: 'active' },
    ]);
    const oncall = makeGrafanaOnCallStub({ id: 'chain-1' }, ['carol@example.com']);
    const cloud = makeGrafanaCloudStub(undefined);

    const record = await buildAssembler(slack, workos, oncall, cloud).assemble(alert);

    expect(record.status).toBe('ROOM_ASSEMBLED');
    expect(record.slack_channel_id).toBe('C-WAR-ROOM');
    expect(record.responders.sort()).toEqual(['U-alice', 'U-bob', 'U-carol']);

    const persisted = await readIncident(alert.alert_group_id);
    expect(persisted).toMatchObject({
      status: 'ROOM_ASSEMBLED',
      slack_channel_id: 'C-WAR-ROOM',
      responders: expect.arrayContaining(['U-alice', 'U-bob', 'U-carol']),
    });

    const audit = await readAuditActions(alert.alert_group_id);
    expect(audit).toEqual(expect.arrayContaining(['WAR_ROOM_CREATED', 'RESPONDER_INVITED', 'CHECKLIST_PINNED']));
    expect(audit).not.toContain('DIRECTORY_LOOKUP_FAILED');

    expect(slack.conversations.create).toHaveBeenCalledTimes(1);
    expect(slack.conversations.invite).toHaveBeenCalledTimes(3);
    expect(nudgeStub.scheduleNudge).toHaveBeenCalledWith(alert.alert_group_id, 'C-WAR-ROOM');
  });

  it('INT-ASSEMBLE-002: directory lookup failure → DIRECTORY_LOOKUP_FAILED + ASSEMBLY_FALLBACK_INITIATED audit, assembly still completes', async () => {
    const alert = alertPayload();
    await seedIncident(alert.alert_group_id);

    const slack = makeSlackStub();
    const workos = { getUsersInGroup: jest.fn().mockRejectedValue(new Error('WorkOS 503')) };
    const oncall = makeGrafanaOnCallStub(null, []); // no escalation chain either
    const cloud = makeGrafanaCloudStub(undefined);

    const record = await buildAssembler(slack, workos, oncall, cloud).assemble(alert);

    expect(record.status).toBe('ROOM_ASSEMBLED');
    expect(record.responders).toEqual([]);

    const audit = await readAuditActions(alert.alert_group_id);
    expect(audit).toEqual(expect.arrayContaining(['WAR_ROOM_CREATED', 'DIRECTORY_LOOKUP_FAILED', 'ASSEMBLY_FALLBACK_INITIATED']));
    // Fallback warning was posted to Slack
    const fallbackCall = slack.chat.postMessage.mock.calls.find((c) => (c[0].text as string).includes('Responder auto-invite failed'));
    expect(fallbackCall).toBeDefined();
  });

  it('INT-ASSEMBLE-003: Slack channel-create failure → throws, no ROOM_ASSEMBLED record', async () => {
    const alert = alertPayload();
    await seedIncident(alert.alert_group_id);

    const slack = makeSlackStub({ createOk: false });
    const workos = makeWorkOSStub([]);
    const oncall = makeGrafanaOnCallStub(null, []);
    const cloud = makeGrafanaCloudStub(undefined);

    await expect(buildAssembler(slack, workos, oncall, cloud).assemble(alert)).rejects.toThrow(/Failed to create Slack channel/);

    const persisted = await readIncident(alert.alert_group_id);
    // Status reached ROOM_ASSEMBLING but did not advance to ROOM_ASSEMBLED; there is no slack_channel_id.
    expect(persisted?.['status']).toBe('ROOM_ASSEMBLING');
    expect(persisted?.['slack_channel_id']).toBeUndefined();
  });

  it('INT-ASSEMBLE-004: Grafana Cloud context failure is tolerated — assembly continues, audit records snapshot_present=false', async () => {
    const alert = alertPayload();
    await seedIncident(alert.alert_group_id);

    const slack = makeSlackStub();
    const workos = makeWorkOSStub([{ id: 'u1', email: 'alice@example.com', first_name: 'A', last_name: 'A', state: 'active' }]);
    const oncall = makeGrafanaOnCallStub(null, []);
    const cloud = makeGrafanaCloudStub(null); // reject — Mimir unreachable

    const record = await buildAssembler(slack, workos, oncall, cloud).assemble(alert);

    expect(record.status).toBe('ROOM_ASSEMBLED');
    expect(record.context_snapshot).toBeUndefined();

    const audit = await readAuditActions(alert.alert_group_id);
    expect(audit).toContain('WAR_ROOM_CREATED');
    // CONTEXT_SNAPSHOT_ATTACHED is now always written so the IC can tell from the
    // audit log alone whether the Grafana snapshot landed in-channel.
    expect(audit).toContain('CONTEXT_SNAPSHOT_ATTACHED');

    const fullAudit = await ddbLocalDoc.send(
      new QueryCommand({
        TableName: AUDIT_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk_prefix)',
        ExpressionAttributeValues: { ':pk': `INCIDENT#${alert.alert_group_id}`, ':sk_prefix': 'AUDIT#' },
        ConsistentRead: true,
      }),
    );
    const ctxRow = fullAudit.Items?.find((i) => i['action_type'] === 'CONTEXT_SNAPSHOT_ATTACHED');
    expect(ctxRow?.['details']).toMatchObject({ snapshot_present: false });
  });
});
