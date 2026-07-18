/**
 * Structured JSON logger for IncidentResponse.
 * Correlation IDs thread through all log entries keyed by incident_id.
 * When an OTel span is active, trace_id + span_id are stamped so Grafana's
 * Tempo → Loki correlation jump works one-click.
 *
 * The emission core (JSON lines, level filtering from LOG_LEVEL, trace
 * correlation, child bindings) is the vendored `@nanohype/runtime` logger;
 * this file pins the app's stream policy — info/debug to stdout, warn/error
 * to stderr.
 */

import { createLogger } from "../vendor/runtime/logger.js";

export const logger = createLogger({ stream: "split" });
