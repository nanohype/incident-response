/**
 * Unit tests for HMAC secret cache invalidation.
 * Covers: first fetch, cache hit within TTL, cache refresh after TTL,
 * forced refresh (rotation-race recovery).
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-vitest/extend';

import { getHmacSecret, __resetHmacCacheForTests } from '../../src/handlers/webhook-ingress.js';

const smMock = mockClient(SecretsManagerClient);

describe('HMAC secret cache', () => {
  const ORIGINAL_ID = process.env['GRAFANA_ONCALL_HMAC_SECRET_ID'];

  beforeEach(() => {
    smMock.reset();
    __resetHmacCacheForTests();
    process.env['GRAFANA_ONCALL_HMAC_SECRET_ID'] =
      'arn:aws:secretsmanager:us-west-2:000000000000:secret:test-abcdef';
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_ID === undefined) delete process.env['GRAFANA_ONCALL_HMAC_SECRET_ID'];
    else process.env['GRAFANA_ONCALL_HMAC_SECRET_ID'] = ORIGINAL_ID;
  });

  it('HMAC-CACHE-001: first call fetches from Secrets Manager', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: 'secret-v1', VersionId: 'v1' });
    const secret = await getHmacSecret();
    expect(secret).toBe('secret-v1');
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
  });

  it('HMAC-CACHE-002: second call within TTL hits cache (no refetch)', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: 'secret-v1', VersionId: 'v1' });
    await getHmacSecret();
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 minutes — still within 5-min TTL
    await getHmacSecret();
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 1);
  });

  it('HMAC-CACHE-003: call after TTL expiry refetches', async () => {
    smMock
      .on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: 'secret-v1', VersionId: 'v1' })
      .resolves({ SecretString: 'secret-v2', VersionId: 'v2' });
    const first = await getHmacSecret();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes — past 5-min TTL
    const second = await getHmacSecret();
    expect(first).toBe('secret-v1');
    expect(second).toBe('secret-v2');
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
  });

  it('HMAC-CACHE-004: forceRefresh=true bypasses cache (rotation-race recovery)', async () => {
    smMock
      .on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: 'secret-v1', VersionId: 'v1' })
      .resolves({ SecretString: 'secret-v2', VersionId: 'v2' });
    await getHmacSecret();
    const refreshed = await getHmacSecret(true);
    expect(refreshed).toBe('secret-v2');
    expect(smMock).toHaveReceivedCommandTimes(GetSecretValueCommand, 2);
  });

  it('HMAC-CACHE-005: missing ARN env throws', async () => {
    delete process.env['GRAFANA_ONCALL_HMAC_SECRET_ID'];
    await expect(getHmacSecret()).rejects.toThrow('GRAFANA_ONCALL_HMAC_SECRET_ID not set');
  });

  it('HMAC-CACHE-006: empty SecretString throws', async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: undefined });
    await expect(getHmacSecret()).rejects.toThrow('HMAC secret is empty');
  });
});
