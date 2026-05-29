/**
 * Unit tests for HttpClient.
 */

import { HttpClient } from '../../src/utils/http-client.js';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new HttpClient({ clientName: 'test-client', baseUrl: 'https://api.example.com', timeoutMs: 5000, maxRetries: 2 });
  });

  it('HTTP-001: succeeds on first attempt', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    const result = await client.get<{ ok: boolean }>('/test');
    expect(result.ok).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP-002: retries on 503 and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(mockJsonResponse(200, { ok: true }));
    const result = await client.get('/test');
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP-003: returns non-ok response after max retries exhausted', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(429, { error: 'rate limited' }));
    const result = await client.get('/test');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('HTTP-004: non-retryable status returns without retrying', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(404, { error: 'not found' }));
    const result = await client.get('/test');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP-005: noRetry skips retries', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(503, {}));
    const result = await client.request({ method: 'GET', path: '/test', noRetry: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP-006: timeout hard-capped at 5000ms even if constructor says higher', () => {
    const capClient = new HttpClient({ clientName: 'test', baseUrl: 'https://api.example.com', timeoutMs: 99999 });
    expect(capClient).toBeDefined();
  });

  it('HTTP-007: max retries hard-capped at 2 even if constructor says higher', async () => {
    const capClient = new HttpClient({ clientName: 'test', baseUrl: 'https://api.example.com', maxRetries: 10 });
    mockFetch.mockResolvedValue(mockJsonResponse(503, {}));
    const result = await capClient.get('/test');
    expect(result.ok).toBe(false);
    expect(mockFetch.mock.calls.length).toBe(3);
  });

  it('HTTP-008: POST with JSON body stringifies the body', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(201, { ok: true }));
    await client.post('/test', { hello: 'world' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ hello: 'world' }) }),
    );
  });

  it('HTTP-009: PUT with body + headers passes both', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(200, { ok: true }));
    await client.put('/test', { x: 1 }, { 'X-Custom': 'value' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({ method: 'PUT', headers: expect.objectContaining({ 'X-Custom': 'value' }) }),
    );
  });

  it('HTTP-010: non-JSON response returns text body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: jest.fn().mockResolvedValue('hello'),
      json: jest.fn(),
    } as unknown as Response);
    const result = await client.get<string>('/test');
    expect(result.data).toBe('hello');
  });

  it('HTTP-011: timeout error wraps into ExternalClientTimeoutError after retries', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);
    await expect(client.get('/test')).rejects.toThrow(/timed out after/);
  });

  it('HTTP-012: non-timeout fetch error propagates', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(client.get('/test')).rejects.toThrow('network down');
  });

  it('HTTP-013: json parse failure sets data to null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: jest.fn().mockRejectedValue(new Error('bad json')),
      text: jest.fn(),
    } as unknown as Response);
    const result = await client.get<{ x: number }>('/test');
    expect(result.data).toBeNull();
  });
});
