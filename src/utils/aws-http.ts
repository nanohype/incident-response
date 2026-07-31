/**
 * Shared HTTP bounds for every AWS SDK client in this service.
 *
 * `@smithy/node-http-handler` defaults both `requestTimeout` and
 * `connectionTimeout` to 0 — unbounded. A client constructed with `{ region }`
 * alone will therefore wait forever on a wedged socket.
 *
 * That is worse here than an outright failure. The webhook path carries a
 * latency SLO and answers Grafana OnCall, which retries; the approval gate's
 * read-after-write is what stands between a draft and a customer-facing
 * Statuspage post. A hung DynamoDB read stalls the gate instead of failing it,
 * and nothing downstream can tell that apart from slow — no error, no metric,
 * no alert, just a request that never lands.
 *
 * The values match the deadline `src/utils/http-client.ts` already applies to
 * every non-AWS call, so one class of external call does not quietly run under
 * a different contract from another.
 */

import { NodeHttpHandler } from "@smithy/node-http-handler";

/** Enough for a TCP + TLS handshake to a regional endpoint, and no more. */
const CONNECTION_TIMEOUT_MS = 1_000;

/** Matches HttpClient's hard cap. Single-digit-millisecond calls in practice. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Build a bounded request handler. Pass `requestTimeout` only for a call whose
 * deadline genuinely differs — an SQS long poll, say, where the wait is the
 * point and a 5s cap would defeat it.
 */
export function boundedRequestHandler(
  requestTimeout: number = DEFAULT_REQUEST_TIMEOUT_MS,
): NodeHttpHandler {
  return new NodeHttpHandler({
    requestTimeout,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });
}
