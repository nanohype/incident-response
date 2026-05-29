/**
 * Resolve a war-room Slack channel back to its canonical incident_id.
 *
 * Slash commands arrive from Slack carrying only `channel_id`. The DynamoDB
 * partition key is `INCIDENT#<incident_id>` (from the Grafana OnCall
 * alert_group_id), so a command can't directly `GetItem` the incident
 * record. This helper queries `slack-channel-index` (a sparse GSI on
 * `slack_channel_id` + `created_at`) and returns the newest matching row.
 *
 * Returns undefined if no war-room record exists for the channel — callers
 * should surface that as "No active incident found for this channel".
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { IncidentRecord } from '../types/index.js';

const SLACK_CHANNEL_INDEX = 'slack-channel-index';

export async function resolveIncidentByChannel(
  docClient: DynamoDBDocumentClient,
  incidentsTableName: string,
  channelId: string,
): Promise<IncidentRecord | undefined> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: incidentsTableName,
      IndexName: SLACK_CHANNEL_INDEX,
      KeyConditionExpression: 'slack_channel_id = :cid',
      ExpressionAttributeValues: { ':cid': channelId },
      ScanIndexForward: false, // newest first
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  return item ? (item as IncidentRecord) : undefined;
}
