/**
 * WorkOS Directory Sync client — user/group resolution at incident-fire time.
 *
 * SECURITY: If lookup fails and no cache exists, throws DirectoryLookupFailedError.
 * Caller MUST surface explicit error to IC. NEVER fabricate an invite list.
 * Uses WorkOS Directory Sync REST API (/directory_users?group=<id>).
 */

import { HttpClient } from '../utils/http-client.js';
import { DirectoryUser, DirectoryLookupFailedError } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { CircuitOpenError, type CircuitBreaker } from '../utils/circuit-breaker.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const groupCache = new Map<string, CacheEntry<DirectoryUser[]>>();

interface WorkOSDirectoryUser {
  id: string;
  idp_id?: string;
  directory_id?: string;
  organization_id?: string;
  emails?: Array<{ primary?: boolean; type?: string; value: string }>;
  first_name?: string | null;
  last_name?: string | null;
  username?: string;
  state?: 'active' | 'suspended' | 'inactive';
}

interface WorkOSDirectoryUsersResponse {
  data: WorkOSDirectoryUser[];
  list_metadata: { before: string | null; after: string | null };
}

export function __resetWorkOSCacheForTests(): void {
  groupCache.clear();
}

export class WorkOSClient {
  private readonly http: HttpClient;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(apiKey: string, breaker?: CircuitBreaker) {
    this.http = new HttpClient({
      clientName: 'workos',
      baseUrl: 'https://api.workos.com',
      defaultHeaders: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 5000,
      maxRetries: 2,
    });
    this.breaker = breaker;
  }

  async getUsersInGroup(groupId: string, incidentId: string): Promise<DirectoryUser[]> {
    const cacheKey = `group:${groupId}`;
    const cached = groupCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      logger.debug({ incident_id: incidentId, group_id: groupId }, 'Using cached WorkOS group membership');
      return cached.value;
    }

    logger.info({ incident_id: incidentId, group_id: groupId }, 'Fetching WorkOS directory group members');

    const fetchUnderBreaker = (): Promise<DirectoryUser[]> =>
      this.breaker ? this.breaker.exec(() => this.fetchAllGroupMembers(groupId)) : this.fetchAllGroupMembers(groupId);

    try {
      const users = await fetchUnderBreaker();
      groupCache.set(cacheKey, { value: users, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
      logger.info({ incident_id: incidentId, group_id: groupId, user_count: users.length }, 'WorkOS group members fetched');
      return users;
    } catch (err) {
      if (cached) {
        // Stale cache works for both regular failures and CircuitOpenError —
        // a half-stale invite list is preferable to a failed assembly.
        logger.warn(
          {
            incident_id: incidentId,
            group_id: groupId,
            error: err instanceof Error ? err.message : String(err),
            circuit_open: err instanceof CircuitOpenError,
          },
          'WorkOS lookup failed, using stale cache data',
        );
        return cached.value;
      }
      const reason =
        err instanceof CircuitOpenError
          ? `WorkOS circuit is open (recent failures exceeded threshold). IC must manually invite responders.`
          : `WorkOS directory group lookup failed for group ${groupId}: ${err instanceof Error ? err.message : String(err)}. IC must manually invite responders.`;
      const error = new DirectoryLookupFailedError(reason);
      logger.error(
        { incident_id: incidentId, group_id: groupId, error: error.message, circuit_open: err instanceof CircuitOpenError },
        'DIRECTORY LOOKUP FAILED — IC must manually specify responders',
      );
      throw error;
    }
  }

  private async fetchAllGroupMembers(groupId: string): Promise<DirectoryUser[]> {
    const all: DirectoryUser[] = [];
    let nextPath: string | undefined = `/directory_users?group=${encodeURIComponent(groupId)}&limit=100`;
    // Bounded at 50 pages (5000 members) to prevent runaway loops on a misbehaving API.
    for (let page = 0; page < 50 && nextPath !== undefined; page++) {
      const currentPath: string = nextPath;
      const resp = await this.http.get<WorkOSDirectoryUsersResponse>(currentPath);
      if (!resp.ok) throw new Error(`WorkOS Directory Sync API returned ${resp.status} for group ${groupId} (page ${page})`);
      for (const u of resp.data.data) {
        if (u.state !== 'active') continue;
        const email = primaryEmail(u);
        if (!email) continue;
        all.push({
          id: u.id,
          email,
          first_name: u.first_name ?? '',
          last_name: u.last_name ?? '',
          state: 'active',
        });
      }
      const cursor: string | null | undefined = resp.data.list_metadata?.after;
      nextPath = cursor ? `/directory_users?group=${encodeURIComponent(groupId)}&limit=100&after=${encodeURIComponent(cursor)}` : undefined;
    }
    return all;
  }
}

function primaryEmail(u: WorkOSDirectoryUser): string | undefined {
  const emails = u.emails ?? [];
  if (emails.length === 0) return undefined;
  const primary = emails.find((e) => e.primary)?.value;
  return primary ?? emails[0]?.value;
}
