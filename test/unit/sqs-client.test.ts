/**
 * Every SQS client this service builds keeps its requests on the endpoint it
 * was configured with.
 *
 * With `useQueueUrlAsEndpoint` left at the SDK default, a client whose
 * endpoint comes from AWS_ENDPOINT_URL_SQS sends each queue call to the host in
 * the QueueUrl instead. Queue URLs here are real AWS URLs, so a process pointed
 * at a local endpoint would send its traffic to AWS. These tests pin the option
 * on the factory, prove the behavior it buys, and check that both production
 * clients (the webhook's enqueue, the processor's consumer) come from the
 * factory.
 */

import * as crypto from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/webhook-ingress.js";
import { SqsConsumer } from "../../src/services/sqs-consumer.js";
import { createSqsClient } from "../../src/utils/sqs-client.js";

const AWS_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/111111111111/incident-response-events.fifo";
const LOCAL_ENDPOINT = "http://localhost:4566";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Send one message and return the origin the request was addressed to, without sending it. */
async function destinationOf(client: SQSClient): Promise<string> {
  let destination = "";
  client.middlewareStack.add(
    () => async (args) => {
      const request = args.request as { protocol: string; hostname: string; port?: number };
      destination = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}`;
      throw new Error("captured");
    },
    { step: "finalizeRequest", priority: "low" },
  );
  await expect(
    client.send(
      new SendMessageCommand({ QueueUrl: AWS_QUEUE_URL, MessageBody: "{}", MessageGroupId: "g" }),
    ),
  ).rejects.toThrow("captured");
  return destination;
}

describe("createSqsClient", () => {
  it("does not let a queue URL override the configured endpoint", () => {
    expect(createSqsClient().config.useQueueUrlAsEndpoint).toBe(false);
    expect(createSqsClient(15_000).config.useQueueUrlAsEndpoint).toBe(false);
  });

  it("sends to the endpoint from AWS_ENDPOINT_URL_SQS, not the queue URL's AWS host", async () => {
    process.env.AWS_ENDPOINT_URL_SQS = LOCAL_ENDPOINT;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";

    expect(await destinationOf(createSqsClient())).toBe(LOCAL_ENDPOINT);
  });

  it("still reaches the regional SQS host when no endpoint is configured", async () => {
    delete process.env.AWS_ENDPOINT_URL_SQS;
    delete process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";

    expect(await destinationOf(createSqsClient())).toBe("https://sqs.us-east-1.amazonaws.com");
  });
});

describe("production SQS clients", () => {
  it("the processor's consumer builds its default client through the factory", () => {
    const consumer = new SqsConsumer(
      AWS_QUEUE_URL,
      AWS_QUEUE_URL,
      async () => {},
      async () => {},
    );
    const { sqs } = consumer as unknown as { sqs: SQSClient };
    expect(sqs.config.useQueueUrlAsEndpoint).toBe(false);
  });

  it("the webhook's enqueue client does not let a queue URL override the endpoint", async () => {
    const smMock = mockClient(SecretsManagerClient);
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const sqsMock = mockClient(SQSClient);
    try {
      const secret = "test-secret";
      process.env.GRAFANA_ONCALL_HMAC_SECRET_ID =
        "arn:aws:secretsmanager:us-east-1:111111111111:secret:test";
      process.env.INCIDENTS_TABLE_NAME = "incident-response-incidents-test";
      process.env.INCIDENT_EVENTS_QUEUE_URL = AWS_QUEUE_URL;
      smMock.on(GetSecretValueCommand).resolves({ SecretString: secret, VersionId: "v1" });
      ddbMock.on(PutCommand).resolves({});
      sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

      const body = JSON.stringify({
        alert_group_id: "alert-group-sqs-endpoint",
        alert_group: { id: "alert-group-sqs-endpoint", title: "P1", state: "firing" },
        integration_id: "integration-123",
        route_id: "route-1",
        team_id: "team-platform",
        team_name: "Platform",
        alerts: [{ id: "a1", title: "P1", message: "m", received_at: "2026-04-16T00:00:00Z" }],
      });
      const signature = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
      const result = await handler({ headers: { "x-grafana-oncall-signature": signature }, body });

      expect(result.statusCode).toBe(200);
      expect(sqsMock.calls()).toHaveLength(1);
      const client = sqsMock.call(0).thisValue as SQSClient;
      expect(client.config.useQueueUrlAsEndpoint).toBe(false);
    } finally {
      smMock.restore();
      ddbMock.restore();
      sqsMock.restore();
    }
  });
});
