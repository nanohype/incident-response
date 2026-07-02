/**
 * Unit tests for the WorkOS client wiring: the vendored directory client
 * (pagination, mapping) riding through the HttpClient fetch port, plus the
 * app-owned pieces — active-member/email filtering, per-instance TTL cache
 * with stale fallback, and the DirectoryLookupFailedError contract.
 *
 * Pure pagination/mapping semantics (cursor walk, maxPages bound, primary
 * email preference, displayName fallback) are the vendored module's contract,
 * tested upstream in nanohype/library/runtime/src/workos-directory.test.ts.
 */

import { WorkOSClient } from '../../src/clients/workos-client.js';
import { DirectoryLookupFailedError } from '../../src/types/index.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mkResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
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

describe('WorkOSClient', () => {
  let client: WorkOSClient;

  beforeEach(() => {
    mockFetch.mockReset();
    // Fresh client per test — the group cache is per-instance, so a new
    // construction is the isolation mechanism (no module-level escape hatch).
    client = new WorkOSClient('sk_test_key', 'directory_test');
  });

  it('WORKOS-PAGE-001: single page returns all active members, one fetch, scoped to the directory', async () => {
    mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), mkUser('u2')])));
    const users = await client.getUsersInGroup(`single-${Date.now()}`, 'inc-1');
    expect(users).toHaveLength(2);
    expect(users[0]!.email).toBe('u1@example.com');
    expect(users[0]!.state).toBe('active');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = String(mockFetch.mock.calls[0]![0]);
    expect(url).toContain('directory=directory_test');
  });

  it('WORKOS-PAGE-002: follows list_metadata.after across two pages through the fetch port', async () => {
    mockFetch
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1'), mkUser('u2')], 'CURSOR1')))
      .mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u3'), mkUser('u4')])));
    const users = await client.getUsersInGroup(`two-page-${Date.now()}`, 'inc-1');
    expect(users.map((u) => u.id).sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondUrl = String(mockFetch.mock.calls[1]![0]);
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

  it('WORKOS-PAGE-008: mid-pagination 500 surfaces DirectoryLookupFailedError', async () => {
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-04-15T00:00:00Z'));
    try {
      mockFetch.mockResolvedValueOnce(mkResponse(200, mkPage([mkUser('u1')]))).mockResolvedValue(mkResponse(500, {}));
      const groupId = `stale-${Date.now()}`;
      const first = await client.getUsersInGroup(groupId, 'inc-1');
      expect(first.map((u) => u.id)).toEqual(['u1']);
      // Advance past the 5-minute cache TTL.
      vi.advanceTimersByTime(6 * 60 * 1000);
      const second = await client.getUsersInGroup(groupId, 'inc-2');
      expect(second.map((u) => u.id)).toEqual(['u1']); // stale cache returned
    } finally {
      vi.useRealTimers();
    }
  });

  it('WORKOS-PAGE-011: no-cache + failure → throws DirectoryLookupFailedError', async () => {
    mockFetch.mockResolvedValue(mkResponse(500, {}));
    await expect(client.getUsersInGroup(`fail-${Date.now()}`, 'inc-1')).rejects.toBeInstanceOf(DirectoryLookupFailedError);
  });
});
