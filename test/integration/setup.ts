/**
 * Shared setup for integration tests against dynamodb-local.
 * Tables mirror the audit table schema landing-zone provisions.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const ENDPOINT = process.env.DDB_LOCAL_ENDPOINT ?? "http://localhost:8000";

export const ddbLocalClient = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
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
  // Not an exception to the no-floating-promises policy — the promise on the next
  // line is awaited, and every concurrent caller awaits this same one. Biome 2.5.6
  // reports `await` on a `Promise<T> | undefined` union as floating; it is the
  // union that trips it, not a missing await. Restructuring to drop the union
  // (`return (ready ??= …)`) only trades this for `noAssignInExpressions`.
  // biome-ignore lint/nursery/noFloatingPromises: false positive on `await` of an optional-promise union
  await ready;
}

/**
 * CreateTable and DeleteTable return while the table is still CREATING or
 * DELETING. DynamoDB rejects item operations on a CREATING table and a
 * CreateTable for a name that is still DELETING, both with
 * ResourceNotFoundException / ResourceInUseException, for as long as the
 * transition takes (seconds on a real table). dynamodb-local finishes both
 * before it answers, which hides the gap, so every create and delete here waits
 * for the table state it needs before returning.
 *
 * Two waits fit inside the 60 s hookTimeout in vitest.config.integration.ts.
 */
const TABLE_WAITER = {
  client: ddbLocalClient,
  minDelay: 1,
  maxDelay: 2,
  maxWaitTime: 25,
} as const;

async function deleteAndWait(tableName: string): Promise<void> {
  try {
    await ddbLocalClient.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
  await waitUntilTableNotExists(TABLE_WAITER, { TableName: tableName });
}

async function createPkSkTable(tableName: string): Promise<void> {
  await waitForDdbLocal();
  try {
    await ddbLocalClient.send(new DescribeTableCommand({ TableName: tableName }));
    await deleteAndWait(tableName);
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    /* not present */
  }
  await ddbLocalClient.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists(TABLE_WAITER, { TableName: tableName });
}

async function dropTable(tableName: string): Promise<void> {
  await deleteAndWait(tableName);
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
