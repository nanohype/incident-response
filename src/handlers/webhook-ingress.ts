/**
 * Webhook ingress Lambda handler.
 * Verifies Grafana OnCall HMAC-SHA256 signature, validates payload, checks idempotency,
 * and enqueues to SQS FIFO.
 */

import { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import * as crypto from 'crypto';
import { GrafanaOnCallPayloadSchema } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { injectSqsTraceAttributes } from '../utils/tracing.js';
import { initOtelIfNeeded } from './webhook-otel-init.js';

const sqsClient = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' });
const dynamoClient = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' });

interface HmacSecretCacheEntry {
  value: string;
  versionId: string | undefined;
  expiresAt: number;
}
const HMAC_SECRET_TTL_MS = 5 * 60 * 1000;
let hmacCache: HmacSecretCacheEntry | null = null;

export function __resetHmacCacheForTests(): void {
  hmacCache = null;
}

async function fetchHmacSecret(): Promise<HmacSecretCacheEntry> {
  const secretArn = process.env['GRAFANA_ONCALL_HMAC_SECRET_ARN'];
  if (!secretArn) throw new Error('GRAFANA_ONCALL_HMAC_SECRET_ARN not set');
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) throw new Error('HMAC secret is empty');
  return { value: result.SecretString, versionId: result.VersionId, expiresAt: Date.now() + HMAC_SECRET_TTL_MS };
}

export async function getHmacSecret(forceRefresh = false): Promise<string> {
  if (!forceRefresh && hmacCache && Date.now() < hmacCache.expiresAt) return hmacCache.value;
  hmacCache = await fetchHmacSecret();
  return hmacCache.value;
}

function verifyHmacSignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event): Promise<APIGatewayProxyResultV2> => {
  // Best-effort OTel init on cold start. Memoized inside `initOtelIfNeeded`.
  // Tracing failure must not block webhook processing.
  await initOtelIfNeeded();

  const body = event.body ?? '';
  const signature = event.headers?.['x-grafana-oncall-signature'] ?? '';

  try {
    let secret = await getHmacSecret();
    if (!verifyHmacSignature(body, signature, secret)) {
      // Possible rotation race: refetch once and retry before rejecting.
      secret = await getHmacSecret(true);
      if (!verifyHmacSignature(body, signature, secret)) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'HMAC secret fetch failed');
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const parsed = GrafanaOnCallPayloadSchema.safeParse(parsedBody);
  if (!parsed.success) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload', details: parsed.error.message }) };

  const payload = parsed.data;
  const alertGroupId = payload.alert_group_id;

  if (payload.alert_group.state === 'silenced') return { statusCode: 200, body: JSON.stringify({ message: 'Silenced alert ignored' }) };

  if (payload.alert_group.state === 'resolved') {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: process.env['INCIDENT_EVENTS_QUEUE_URL'],
        MessageBody: JSON.stringify({ type: 'ALERT_RESOLVED', payload }),
        MessageGroupId: alertGroupId,
        MessageDeduplicationId: `resolved-${alertGroupId}-${Date.now()}`,
        MessageAttributes: injectSqsTraceAttributes(),
      }),
    );
    return { statusCode: 200, body: JSON.stringify({ message: 'Resolution event queued' }) };
  }

  // Atomic create: conditional write is the single source of truth for "is this a new incident?"
  // Two concurrent firing webhooks collapse safely — loser sees ConditionalCheckFailedException and
  // returns 200 without re-enqueuing ALERT_RECEIVED (which would otherwise create a second Slack channel).
  try {
    await docClient.send(
      new PutCommand({
        TableName: process.env['INCIDENTS_TABLE_NAME'] ?? 'marshal-incidents',
        Item: {
          PK: `INCIDENT#${alertGroupId}`,
          SK: 'METADATA',
          incident_id: alertGroupId,
          status: 'ALERT_RECEIVED',
          severity: 'P1',
          alert_payload: payload,
          correlation_id: alertGroupId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          responders: [],
          TTL: Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException)
      return { statusCode: 200, body: JSON.stringify({ message: 'Duplicate event ignored', incident_id: alertGroupId }) };
    throw err;
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env['INCIDENT_EVENTS_QUEUE_URL'],
      MessageBody: JSON.stringify({ type: 'ALERT_RECEIVED', payload }),
      MessageGroupId: alertGroupId,
      MessageDeduplicationId: `received-${alertGroupId}`,
      MessageAttributes: injectSqsTraceAttributes(),
    }),
  );

  return { statusCode: 200, body: JSON.stringify({ message: 'Alert accepted', incident_id: alertGroupId }) };
};
