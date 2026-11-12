/**
 * The one way this service builds an SQS client.
 *
 * The SDK's SQS client defaults `useQueueUrlAsEndpoint` to true: when a command
 * carries a QueueUrl whose origin differs from the client's resolved endpoint,
 * the request is sent to the QueueUrl's host instead. An endpoint set directly
 * on the client suppresses that, but one supplied through the environment
 * (`AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_SQS`) does not. A process pointed at a
 * non-AWS endpoint that way, holding a queue URL on sqs.<region>.amazonaws.com,
 * therefore sends every queue call to that AWS host with whatever credentials it
 * resolved. Turning the option off makes the configured endpoint authoritative
 * in every case; with no override the resolved endpoint is the regional SQS
 * host the queue URL names anyway, so production traffic is unchanged.
 */

import { SQSClient } from "@aws-sdk/client-sqs";
import { boundedRequestHandler } from "./aws-http.js";
import { awsRegion } from "./env.js";

/**
 * Build an SQS client. `requestTimeout` is passed through to
 * `boundedRequestHandler` for a call whose deadline genuinely differs, such as
 * a long poll.
 */
export function createSqsClient(requestTimeout?: number): SQSClient {
  return new SQSClient({
    region: awsRegion(),
    requestHandler: boundedRequestHandler(requestTimeout),
    useQueueUrlAsEndpoint: false,
  });
}
