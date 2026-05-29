/**
 * Domain-specific error classes. Using typed errors (vs bare `Error`) lets
 * callers differentiate failure modes with `instanceof` and keeps error
 * messages actionable for incident commanders.
 */

export class AutoPublishNotPermittedError extends Error {
  constructor(incident_id: string) {
    super(
      `AutoPublishNotPermitted: Attempted to publish Statuspage.io incident for incident_id=${incident_id} ` +
        `without a confirmed STATUSPAGE_DRAFT_APPROVED audit record. ` +
        `This is a hard invariant violation — no status message reaches the public without explicit IC approval.`,
    );
    this.name = 'AutoPublishNotPermittedError';
  }
}

/**
 * Thrown when the directory-sync client (WorkOS today; pluggable) cannot
 * resolve group membership at incident-fire time and no stale cache is
 * available. Callers MUST surface this explicitly to the IC; the war-room
 * assembler writes a `DIRECTORY_LOOKUP_FAILED` audit event and falls back
 * to manual invite — never fabricates an invite list.
 */
export class DirectoryLookupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryLookupFailedError';
  }
}

export class ExternalClientTimeoutError extends Error {
  constructor(client: string, timeout_ms: number) {
    super(`${client} request timed out after ${timeout_ms}ms`);
    this.name = 'ExternalClientTimeoutError';
  }
}
