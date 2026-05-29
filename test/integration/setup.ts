/**
 * Shared setup for integration tests against dynamodb-local.
 * Tables mirror the CDK stack's audit table schema.
 */

import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const ENDPOINT = process.env['DDB_LOCAL_ENDPOINT'] ?? 'http://localhost:8000';

export const ddbLocalClient = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: 'us-west-2',
  credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
});

export const ddbLocalDoc = DynamoDBDocumentClient.from(ddbLocalClient);

async function createPkSkTable(tableName: string): Promise<void> {
  try {
    await ddbLocalClient.send(new DescribeTableCommand({ TableName: tableName }));
    await ddbLocalClient.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    /* not present */
  }
  await ddbLocalClient.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

async function dropTable(tableName: string): Promise<void> {
  try {
    await ddbLocalClient.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    /* already gone */
  }
}

export const createAuditTable = createPkSkTable;
export const deleteAuditTable = dropTable;
export const createIncidentsTable = createPkSkTable;
export const deleteIncidentsTable = dropTable;
