/**
 * WorkOS Directory Sync client — user/group resolution at incident-fire time.
 *
 * Cursor pagination and user mapping delegate to the vendored runtime module
 * (`src/vendor/runtime/workos-directory.ts`, source of truth in nanohype
 * `library/runtime`). This app-side wrapper owns what the vendored client
 * deliberately leaves to the consumer:
 *
 *   - transport: the vendored client's fetch port is routed through
 *     `HttpClient`, so every page request inherits the 5s timeout cap,
 *     429/5xx selective retry with jittered backoff, and structured logging
 *   - caching: per-instance 5-min TTL group cache with stale fallback
 *     (constructed once in wiring/dependencies.ts; tests get isolation by
 *     constructing a fresh client)
 *   - resilience: the circuit breaker around the full group walk
 *   - the app error contract: `DirectoryLookupFailedError` with IC guidance
 *
 * SECURITY: If lookup fails and no cache exists, throws DirectoryLookupFailedError.
 * Caller MUST surface explicit error to IC. NEVER fabricate an invite list.
 */

import { DirectoryLookupFailedError, type DirectoryUser } from "../types/index.js";
import { type CircuitBreaker, CircuitOpenError } from "../utils/circuit-breaker.js";
import { stringifyError } from "../utils/errors.js";
import { HttpClient } from "../utils/http-client.js";
import { logger } from "../utils/logger.js";
import {
  createWorkOsDirectoryClient,
  type DirectoryUser as VendoredDirectoryUser,
  type WorkOsDirectoryClient,
} from "../vendor/runtime/workos-directory.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;

export class WorkOSClient {
  private readonly http: HttpClient;
  private readonly directory: WorkOsDirectoryClient;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly groupCache = new Map<string, CacheEntry<DirectoryUser[]>>();

  constructor(apiKey: string, directoryId: string, breaker?: CircuitBreaker) {
    this.http = new HttpClient({
      clientName: "workos",
      baseUrl: "https://api.workos.com",
      defaultHeaders: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 5000,
      maxRetries: 2,
    });
    // Fetch port for the vendored client: reduce the request back to
    // path + query and route it through HttpClient so each page gets the
    // capped timeout and selective retry. Auth lives in HttpClient's default
    // headers, so the vendored client's own header arg is ignored here.
    const fetchViaHttpClient: typeof fetch = async (input) => {
      const url = new URL(
        input instanceof URL || typeof input === "string" ? String(input) : input.url,
      );
      const resp = await this.http.get<unknown>(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify(resp.data), {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    };
    this.directory = createWorkOsDirectoryClient({
      apiKey,
      directoryId,
      fetchImpl: fetchViaHttpClient,
    });
    this.breaker = breaker;
  }

  async getUsersInGroup(groupId: string, incidentId: string): Promise<DirectoryUser[]> {
    const cacheKey = `group:${groupId}`;
    const cached = this.groupCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      logger.debug(
        { incident_id: incidentId, group_id: groupId },
        "Using cached WorkOS group membership",
      );
      return cached.value;
    }

    logger.info(
      { incident_id: incidentId, group_id: groupId },
      "Fetching WorkOS directory group members",
    );

    const fetchUnderBreaker = (): Promise<DirectoryUser[]> =>
      this.breaker
        ? this.breaker.exec(() => this.fetchActiveGroupMembers(groupId))
        : this.fetchActiveGroupMembers(groupId);

    try {
      const users = await fetchUnderBreaker();
      this.groupCache.set(cacheKey, { value: users, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
      logger.info(
        { incident_id: incidentId, group_id: groupId, user_count: users.length },
        "WorkOS group members fetched",
      );
      return users;
    } catch (err) {
      if (cached) {
        // Stale cache works for both regular failures and CircuitOpenError —
        // a half-stale invite list is preferable to a failed assembly.
        logger.warn(
          {
            incident_id: incidentId,
            group_id: groupId,
            error: stringifyError(err),
            circuit_open: err instanceof CircuitOpenError,
          },
          "WorkOS lookup failed, using stale cache data",
        );
        return cached.value;
      }
      const reason =
        err instanceof CircuitOpenError
          ? `WorkOS circuit is open (recent failures exceeded threshold). IC must manually invite responders.`
          : `WorkOS directory group lookup failed for group ${groupId}: ${stringifyError(err)}. IC must manually invite responders.`;
      const error = new DirectoryLookupFailedError(reason);
      logger.error(
        {
          incident_id: incidentId,
          group_id: groupId,
          error: error.message,
          circuit_open: err instanceof CircuitOpenError,
        },
        "DIRECTORY LOOKUP FAILED — IC must manually specify responders",
      );
      throw error;
    }
  }

  /** Walk the group via the vendored client; keep only active members with a resolvable email. */
  private async fetchActiveGroupMembers(groupId: string): Promise<DirectoryUser[]> {
    const members = await this.directory.listUsersInGroup(groupId);
    const users: DirectoryUser[] = [];
    for (const m of members) {
      if (m.state !== "active") continue;
      if (!m.email) continue;
      users.push(toAppDirectoryUser(m, m.email));
    }
    return users;
  }
}

function toAppDirectoryUser(u: VendoredDirectoryUser, email: string): DirectoryUser {
  return {
    id: u.id,
    email,
    first_name: u.firstName,
    last_name: u.lastName,
    state: "active",
  };
}
