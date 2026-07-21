/**
 * Webhook OTel init.
 *
 * Runs on the first request the webhook pod serves and is memoized from then
 * on. Fetches the OTLP `basic_auth` field from Secrets Manager via the AWS
 * SDK, constructs OTLP exporters with the Authorization header set
 * programmatically, and starts the OTel NodeSDK.
 *
 * Why the credential is fetched rather than injected: the OTel SDK reads
 * exporter headers from `OTEL_EXPORTER_OTLP_HEADERS` at startup, which would
 * put the plaintext credential in the pod spec — readable by anything with
 * `get pod` in the namespace and captured in every rendered manifest.
 * Resolving it through the pod's existing `secretsmanager:GetSecretValue`
 * permission keeps the secret inside Secrets Manager's perimeter.
 *
 * The init is best-effort: if it fails, the handler warn-logs and
 * continues without tracing. Losing a trace must not block a P1 alert
 * from flowing to the processor.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { stringifyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// Memoize on the promise so a burst of concurrent requests on a fresh pod
// doesn't fetch the secret more than once. On failure we clear the memo so
// the next request retries — cached failure would be worse than a retry.
let initPromise: Promise<boolean> | undefined;
// Retained so tests can shut the SDK down. A started NodeSDK holds a live
// metric-export interval — without shutdown, every start leaks that handle.
let activeSdk: NodeSDK | undefined;

export async function __resetOtelInitForTests(): Promise<void> {
  initPromise = undefined;
  if (activeSdk) {
    await activeSdk.shutdown().catch(() => undefined);
    activeSdk = undefined;
  }
}

/**
 * Idempotent. Returns true if OTel is active after the call, false if
 * initialization was skipped (missing config) or failed.
 */
export function initOtelIfNeeded(): Promise<boolean> {
  if (!initPromise) {
    initPromise = initOtel().catch((err) => {
      logger.warn(
        { error: stringifyError(err) },
        "OTel init failed — webhook will continue without tracing",
      );
      initPromise = undefined;
      return false;
    });
  }
  return initPromise;
}

async function initOtel(): Promise<boolean> {
  const secretArn = process.env.GRAFANA_CLOUD_OTLP_SECRET_ARN;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // Operators can deploy without the OTLP credential configured (e.g. early
  // dev) — skip quietly rather than spam warnings.
  if (!secretArn || !endpoint) return false;

  const region = process.env.AWS_REGION;
  const sm = region ? new SecretsManagerClient({ region }) : new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) throw new Error("OTLP auth secret has no string value");

  const parsed = JSON.parse(res.SecretString) as { basic_auth?: unknown };
  if (typeof parsed.basic_auth !== "string" || parsed.basic_auth.length === 0) {
    throw new Error("OTLP auth secret is missing a string `basic_auth` field");
  }

  const headers = { Authorization: `Basic ${parsed.basic_auth}` };
  const resource = resourceFromAttributes(
    parseOtelResourceAttrs(process.env.OTEL_RESOURCE_ATTRIBUTES ?? ""),
  );

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
      headers,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
        headers,
      }),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000),
    }),
    instrumentations: [
      // Auto-instruments http/fetch/aws-sdk. Slimmer than the full contrib set
      // since the webhook's call graph is narrow.
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();
  activeSdk = sdk;
  logger.info(
    { service: process.env.OTEL_SERVICE_NAME, endpoint },
    "OTel SDK started (webhook pod)",
  );
  return true;
}

function parseOtelResourceAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}
