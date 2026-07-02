/**
 * Shared setup for integration tests against dynamodb-local.
 * Tables mirror the CDK stack's audit table schema.
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const ENDPOINT = process.env['DDB_LOCAL_ENDPOINT'] ?? 'http://localhost:8000';

export const ddbLocalClient = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: 'us-west-2',
  credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
});

export const ddbLocalDoc = DynamoDBDocumentClient.from(ddbLocalClient);

/**
 * dynamodb-local takes a moment to accept connections after `docker run -d`.
 * Poll ListTables until it answers so the first table operation doesn't race
 * container startup (the test-runner boots faster than the JVM in the image).
 */
let ready: Promise<void> | undefined;
async function waitForDdbLocal(): Promise<void> {
  ready ??= (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await ddbLocalClient.send(new ListTablesCommand({ Limit: 1 }));
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
  await ready;
}

async function createPkSkTable(tableName: string): Promise<void> {
  await waitForDdbLocal();
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

// Close the keep-alive sockets the SDK client holds open — an undestroyed
// client is an open TCP handle that outlives the test run.
afterAll(() => {
  ddbLocalDoc.destroy();
  ddbLocalClient.destroy();
});
