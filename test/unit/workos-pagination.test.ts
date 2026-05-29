/**
 * Unit tests for WorkOS Directory Sync cursor pagination + cache semantics.
 */

import { WorkOSClient, __resetWorkOSCacheForTests } from '../../src/clients/workos-client.js';
import { DirectoryLookupFailedError } from '../../src/types/index.js';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mkResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function mkUser(id: string, overrides: Partial<{ state: string; email: string; primary: boolean }> = {}) {
  return {
    id,
    emails: [{ primary: overrides.primary ?? true, type: 'work', value: overrides.email ?? `${id}@example.com` }],
    first_name: id,
    last_name: 'Test',
    state: overrides.state ?? 'active',
  };
}

function mkPage(users: unknown[], after: string | null = null) {
  return { data: users, list_metadata: { before: null, after } };
}

describe('WorkOSClient pagination', () => {
  let client: WorkOSClient;

  beforeEach(() => {
    mockFetch.mockReset();
    __resetWorkOSCacheForTests();
    client = new WorkOSClient('sk_test_key');
  });

  it('WORKOS-PAGE-001: single page returns all active members, one fetch', async () => {
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), mkUser('u2')])));
    const users = await client.getUsersInGroup(`single-${Date.now()}`, 'inc-1');
    expect(users).toHaveLength(2);
    expect(users[0]!.email).toBe('u1@example.com');
    expect(users[0]!.state).toBe('active');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('WORKOS-PAGE-002: follows list_metadata.after across two pages', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), mkUser('u2')], 'CURSOR1')))
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u3'), mkUser('u4')])));
    const users = await client.getUsersInGroup(`two-page-${Date.now()}`, 'inc-1');
    expect(users.map((u) => u.id).sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondUrl = mockFetch.mock.calls[1]![0];
    expect(secondUrl).toContain('after=CURSOR1');
  });

  it('WORKOS-PAGE-003: filters non-active users across pages', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), mkUser('sus', { state: 'suspended' })], 'X')))
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u2'), mkUser('inactive', { state: 'inactive' })])));
    const users = await client.getUsersInGroup(`filter-${Date.now()}`, 'inc-1');
    expect(users.map((u) => u.id).sort()).toEqual(['u1', 'u2']);
  });

  it('WORKOS-PAGE-004: skips users with no email', async () => {
    const noEmailUser = { id: 'noemail', emails: [], first_name: 'No', last_name: 'Email', state: 'active' };
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), noEmailUser])));
    const users = await client.getUsersInGroup(`noemail-${Date.now()}`, 'inc-1');
    expect(users.map((u) => u.id)).toEqual(['u1']);
  });

  it('WORKOS-PAGE-005: prefers primary email when multiple are present', async () => {
    const multi = {
      id: 'multi',
      emails: [
        { primary: false, type: 'work', value: 'alt@example.com' },
        { primary: true, type: 'work', value: 'primary@example.com' },
      ],
      first_name: 'M',
      last_name: 'U',
      state: 'active',
    };
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([multi])));
    const users = await client.getUsersInGroup(`multi-${Date.now()}`, 'inc-1');
    expect(users[0]!.email).toBe('primary@example.com');
  });

  it('WORKOS-PAGE-006: falls back to first email if no primary flag is set', async () => {
    const noPrimary = {
      id: 'noprim',
      emails: [
        { type: 'work', value: 'first@example.com' },
        { type: 'work', value: 'second@example.com' },
      ],
      first_name: 'N',
      last_name: 'P',
      state: 'active',
    };
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([noPrimary])));
    const users = await client.getUsersInGroup(`noprim-${Date.now()}`, 'inc-1');
    expect(users[0]!.email).toBe('first@example.com');
  });

  it('WORKOS-PAGE-007: stops at 50-page cap', async () => {
    mockFetch.mockResolvedValue(mkResponse(200, mkPage([mkUser('u')], 'X')));
    await client.getUsersInGroup(`cap-${Date.now()}`, 'inc-1');
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it('WORKOS-PAGE-008: mid-pagination 500 surfaces DirectoryLookupFailedError with page number', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1')], 'X')))
      .mockResolvedValueOnce(mkResponse(500, {}))
      .mockResolvedValueOnce(mkResponse(500, {}))
      .mockResolvedValueOnce(mkResponse(500, {}));
    await expect(client.getUsersInGroup(`err-${Date.now()}`, 'inc-1')).rejects.toBeInstanceOf(DirectoryLookupFailedError);
  });

  it('WORKOS-PAGE-009: 2nd call within TTL hits cache — no fetch', async () => {
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1')])));
    const groupId = `cache-${Date.now()}`;
    await client.getUsersInGroup(groupId, 'inc-1');
    await client.getUsersInGroup(groupId, 'inc-2');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('WORKOS-PAGE-010: stale cache fallback on live fetch failure after TTL expiry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-04-15T00:00:00Z'));
    try {
      mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1')]))).mockResolvedValue(mkResponse(500, {}));
      const groupId = `stale-${Date.now()}`;
      const first = await client.getUsersInGroup(groupId, 'inc-1');
      expect(first.map((u) => u.id)).toEqual(['u1']);
      // Advance past the 5-minute cache TTL.
      jest.advanceTimersByTime(6 * 60 * 1000);
      const second = await client.getUsersInGroup(groupId, 'inc-2');
      expect(second.map((u) => u.id)).toEqual(['u1']); // stale cache returned
    } finally {
      jest.useRealTimers();
    }
  });

  it('WORKOS-PAGE-011: no-cache + failure → throws DirectoryLookupFailedError', async () => {
    mockFetch.mockResolvedValue(mkResponse(500, {}));
    await expect(client.getUsersInGroup(`fail-${Date.now()}`, 'inc-1')).rejects.toBeInstanceOf(DirectoryLookupFailedError);
  });
});
