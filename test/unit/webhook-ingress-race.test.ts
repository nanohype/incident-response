/**
 * Unit tests for the webhook ingress handler's atomic-create behavior.
 *
 * P1 race fix: two concurrent firing webhooks for the same alert_group_id must collapse.
 * The loser sees ConditionalCheckFailedException on the conditional Put and returns 200
 * WITHOUT re-enqueuing ALERT_RECEIVED (which would otherwise create a second Slack channel).
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import * as crypto from 'crypto';

import { handler, __resetHmacCacheForTests } from '../../src/handlers/webhook-ingress.js';

const smMock = mockClient(SecretsManagerClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const HMAC_SECRET = 'test-secret';

function signedEvent(body: string) {
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(body, 'utf8').digest('hex');
  return {
    headers: { 'x-grafana-oncall-signature': signature },
    body,
    requestContext: {} as never,
    isBase64Encoded: false,
    rawPath: '/webhook',
    rawQueryString: '',
    routeKey: 'POST /webhook',
    version: '2.0' as const,
  };
}

function firingPayload(alertGroupId = 'alert-group-001') {
  return {
    alert_group_id: alertGroupId,
    alert_group: { id: alertGroupId, title: 'P1 DB outage', state: 'firing' as const },
    integration_id: 'integration-123',
    route_id: 'route-1',
    team_id: 'team-platform',
    team_name: 'Platform',
    alerts: [
      {
        id: 'alert-1',
        title: 'P1 DB outage',
        message: 'connection refused on db-prod',
        received_at: '2026-04-16T00:00:00Z',
      },
    ],
  };
}

function invokeHandler(event: ReturnType<typeof signedEvent>) {
  return (handler as unknown as (event: ReturnType<typeof signedEvent>) => Promise<{ statusCode: number; body: string }>)(event);
}

describe('webhook-ingress atomic-create', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    ddbMock.reset();
    sqsMock.reset();
    __resetHmacCacheForTests();
    process.env['GRAFANA_ONCALL_HMAC_SECRET_ARN'] = 'arn:aws:secretsmanager:us-west-2:000000000000:secret:test';
    process.env['INCIDENTS_TABLE_NAME'] = 'marshal-incidents-test';
    process.env['INCIDENT_EVENTS_QUEUE_URL'] = 'https://sqs.us-west-2.amazonaws.com/000000000000/marshal-events.fifo';
    smMock.on(GetSecretValueCommand).resolves({ SecretString: HMAC_SECRET, VersionId: 'v1' });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('WEBHOOK-001: fresh firing alert → conditional Put succeeds → enqueue ALERT_RECEIVED → 200', async () => {
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });

    const body = JSON.stringify(firingPayload());
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: 'Alert accepted', incident_id: 'alert-group-001' });
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: 'marshal-incidents-test',
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 1);
    expect(sqsMock).toHaveReceivedCommandWith(SendMessageCommand, {
      MessageDeduplicationId: 'received-alert-group-001',
    });
  });

  it('WEBHOOK-002: concurrent firing webhook → ConditionalCheckFailedException → 200 duplicate, no SQS enqueue', async () => {
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'already exists',
        $metadata: {},
      }),
    );

    const body = JSON.stringify(firingPayload());
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: 'Duplicate event ignored', incident_id: 'alert-group-001' });
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it('WEBHOOK-003: silenced alert → 200 no-op, no DDB / SQS', async () => {
    const payload = { ...firingPayload(), alert_group: { ...firingPayload().alert_group, state: 'silenced' as const } };
    const result = await invokeHandler(signedEvent(JSON.stringify(payload)));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: 'Silenced alert ignored' });
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it('WEBHOOK-004: resolved alert → enqueue ALERT_RESOLVED → 200, no DDB', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm2' });
    const payload = { ...firingPayload(), alert_group: { ...firingPayload().alert_group, state: 'resolved' as const } };
    const result = await invokeHandler(signedEvent(JSON.stringify(payload)));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: 'Resolution event queued' });
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 1);
    expect(sqsMock).toHaveReceivedCommandWith(SendMessageCommand, {
      MessageBody: expect.stringContaining('"ALERT_RESOLVED"') as unknown as string,
    });
  });

  it('WEBHOOK-005: invalid HMAC → 401, no DDB / SQS', async () => {
    const body = JSON.stringify(firingPayload());
    const evt = { ...signedEvent(body), headers: { 'x-grafana-oncall-signature': 'deadbeef' } };
    const result = await invokeHandler(evt);

    expect(result.statusCode).toBe(401);
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it('WEBHOOK-006: malformed JSON body → 400', async () => {
    const body = '{not valid json';
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'Invalid JSON' });
  });

  it('WEBHOOK-007: non-ConditionalCheckFailed DynamoDB error → propagates (Lambda 5xx triggers API Gateway retry)', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    const body = JSON.stringify(firingPayload());
    await expect(invokeHandler(signedEvent(body))).rejects.toThrow('ProvisionedThroughputExceededException');
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });
});
