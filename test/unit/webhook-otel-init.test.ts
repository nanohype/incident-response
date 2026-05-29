/**
 * Unit tests for the Lambda webhook's OTel init module.
 *
 * Asserts:
 *  - Skips quietly when config env vars are absent (dev deploys without Grafana).
 *  - Fails gracefully (warn-log, returns false) when the secret is malformed
 *    or Secrets Manager errors — tracing loss must never block webhook flow.
 *  - Memoizes the init promise so a burst of concurrent cold-start invocations
 *    fetches the secret at most once.
 *  - Clears the memo on failure so the next cold start retries.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { initOtelIfNeeded, __resetOtelInitForTests } from '../../src/handlers/webhook-otel-init.js';

const smMock = mockClient(SecretsManagerClient);

describe('initOtelIfNeeded', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    __resetOtelInitForTests();
    // Clean slate each test — individual tests opt in by setting the two vars.
    delete process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'];
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('OTEL-INIT-001: returns false when secret ARN is missing', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway-prod-us-west-0.grafana.net/otlp';
    const started = await initOtelIfNeeded();
    expect(started).toBe(false);
    expect(smMock.calls()).toHaveLength(0);
  });

  it('OTEL-INIT-002: returns false when OTLP endpoint is missing', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] =
      'arn:aws:secretsmanager:us-west-2:111111111111:secret:marshal/staging/grafana-cloud/otlp-auth-abc';
    const started = await initOtelIfNeeded();
    expect(started).toBe(false);
    expect(smMock.calls()).toHaveLength(0);
  });

  it('OTEL-INIT-003: returns false + warns when the secret has no string value', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] = 'arn:test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway.example.com/otlp';
    smMock.on(GetSecretValueCommand).resolves({ SecretString: undefined });
    const started = await initOtelIfNeeded();
    expect(started).toBe(false);
  });

  it('OTEL-INIT-004: returns false + warns when `basic_auth` field is missing', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] = 'arn:test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway.example.com/otlp';
    smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ instance_id: 'x', api_token: 'y' }) });
    const started = await initOtelIfNeeded();
    expect(started).toBe(false);
  });

  it('OTEL-INIT-005: returns false + warns when Secrets Manager errors out', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] = 'arn:test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway.example.com/otlp';
    smMock.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
    const started = await initOtelIfNeeded();
    expect(started).toBe(false);
  });

  it('OTEL-INIT-006: memoizes concurrent calls — secret is fetched once per cold start', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] = 'arn:test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway.example.com/otlp';
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'service.name=marshal-staging-webhook,service.version=0.1.0';
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ basic_auth: 'dXNlcjpwYXNz' }),
    });

    const results = await Promise.all([initOtelIfNeeded(), initOtelIfNeeded(), initOtelIfNeeded()]);

    expect(results).toEqual([true, true, true]);
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
  });

  it('OTEL-INIT-007: clears the memo on failure so the next cold start retries', async () => {
    process.env['GRAFANA_CLOUD_OTLP_SECRET_ARN'] = 'arn:test';
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://otlp-gateway.example.com/otlp';

    smMock.on(GetSecretValueCommand).rejectsOnce(new Error('transient'));
    const first = await initOtelIfNeeded();
    expect(first).toBe(false);

    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ basic_auth: 'dXNlcjpwYXNz' }),
    });
    const second = await initOtelIfNeeded();
    expect(second).toBe(true);
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
  });
});
