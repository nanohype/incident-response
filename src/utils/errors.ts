/**
 * Error normalization for log and message sites.
 *
 * Catch clauses receive `unknown` — anything from an Error to a rejected
 * string. Every structured-log `error:` field and user-facing failure
 * message goes through this one helper so the coercion is uniform and its
 * two branches are covered explicitly (test/unit/errors.test.ts).
 */

export function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
