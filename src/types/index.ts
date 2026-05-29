/**
 * Marshal — core type definitions, re-exported from bounded-context modules.
 *
 * Downstream code imports from `../types/index.js`; the module organisation
 * below is an internal concern. To add a new type:
 *   - Incident state / IC ratings       → ./incident.ts
 *   - Grafana OnCall + Cloud contracts  → ./grafana.ts
 *   - Audit log event types + shapes    → ./audit.ts
 *   - Statuspage draft                   → ./statuspage.ts
 *   - Postmortem draft                   → ./postmortem.ts
 *   - Directory (IdP-neutral) user       → ./directory.ts
 *   - Domain-specific error classes      → ./errors.ts
 */

export * from './incident.js';
export * from './grafana.js';
export * from './audit.js';
export * from './statuspage.js';
export * from './postmortem.js';
export * from './directory.js';
export * from './errors.js';
