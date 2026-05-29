/**
 * Lambda-webhook OTel init.
 *
 * Runs in the Lambda handler's init path (cold start only — memoized).
 * Fetches the Grafana Cloud OTLP `basic_auth` field from Secrets Manager
 * via the AWS SDK, constructs OTLP exporters with the Authorization header
 * set programmatically, and starts the OTel NodeSDK.
 *
 * Why not the ADOT managed Lambda layer: the layer reads OTel config from
 * env vars at layer-load time (before user code runs). That forces the
 * Authorization header to live in `environment:` on the Lambda resource,
 * which means the plaintext credential ends up readable by any IAM
 * principal with `lambda:GetFunctionConfiguration`, logged in CloudTrail
 * on every describe call, and baked in until the next redeploy. Fetching
 * at cold-start via the Lambda's existing `secretsmanager:GetSecretValue`
 * permission keeps the secret inside Secrets Manager's perimeter.
 *
 * The init is best-effort: if it fails, the handler warn-logs and
 * continues without tracing. Losing a trace must not block a P1 alert
 * from flowing to the processor.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { logger } from '../utils/logger.js';

// Memoize on the promise so a cold-start burst of concurrent invocations
// doesn't fetch the secret more than once. On failure we clear the memo so
// the next cold start retries — cached failure would be worse than a retry.
let initPromise: Promise<boolean> | undefined;

export function __resetOtelInitForTests(): void {
  initPromise = undefined;
}

/**
 * Idempotent. Returns true if OTel is active after the call, false if
 * initialization was skipped (missing config) or failed.
 */
export function initOtelIfNeeded(): Promise<boolean> {
  if (!initPromise) {
    initPromise = initOtel().catch((err) => {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'OTel init failed — webhook will continue without tracing');
      initPromise = undefined;
      return false;
    });
  }
  return initPromise;
}

async function initOtel(): Promise<boolean> {
  const secretArn = process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'];
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  // Operators can deploy the Lambda without Grafana Cloud configured
  // (e.g. early dev) — skip quietly rather than spam warnings.
  if (!secretArn || !endpoint) return false;

  const region = process.env['AWS_REGION'];
  const sm = region ? new SecretsManagerClient({ region }) : new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) throw new Error('OTLP auth secret has no string value');

  const parsed = JSON.parse(res.SecretString) as { basic_auth?: unknown };
  if (typeof parsed.basic_auth !== 'string' || parsed.basic_auth.length === 0) {
    throw new Error('OTLP auth secret is missing a string `basic_auth` field');
  }

  const headers = { Authorization: `Basic ${parsed.basic_auth}` };
  const resource = resourceFromAttributes(parseOtelResourceAttrs(process.env['OTEL_RESOURCE_ATTRIBUTES'] ?? ''));

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces`, headers }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/metrics`, headers }),
      exportIntervalMillis: Number(process.env['OTEL_METRIC_EXPORT_INTERVAL'] ?? 60000),
    }),
    instrumentations: [
      // Auto-instruments http/fetch/aws-sdk/aws-lambda. Slimmer than the full
      // contrib set since the webhook's call graph is narrow.
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info({ service: process.env['OTEL_SERVICE_NAME'], endpoint }, 'OTel SDK started (webhook Lambda cold start)');
  return true;
}

function parseOtelResourceAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}
