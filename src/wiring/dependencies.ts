/**
 * Build all runtime dependencies in one place. index.ts composes these.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WebClient } from "@slack/web-api";
import { createSlackAdapter, type SlackAdapter } from "../adapters/slack-adapter.js";
import { IncidentResponseAI } from "../ai/incident-response-ai.js";
import { GitHubClient } from "../clients/github-client.js";
import { GrafanaCloudClient } from "../clients/grafana-cloud-client.js";
import { GrafanaOnCallClient } from "../clients/grafana-oncall-client.js";
import { LinearIncidentResponseClient } from "../clients/linear-client.js";
import { StatuspageClient } from "../clients/statuspage-client.js";
import { WorkOSClient } from "../clients/workos-client.js";
import { config } from "../config/index.js";
import { awsRegion as resolveAwsRegion } from "../utils/env.js";
import { NudgeScheduler } from "../services/nudge-scheduler.js";
import { StatuspageApprovalGate } from "../services/statuspage-approval-gate.js";
import { WarRoomAssembler } from "../services/war-room-assembler.js";
import { AuditWriter } from "../utils/audit.js";
import { boundedRequestHandler } from "../utils/aws-http.js";
import { createCircuitBreaker } from "../utils/circuit-breaker.js";
import { setHttpClientMetrics } from "../utils/http-client.js";
import { MetricsEmitter } from "../utils/metrics.js";

export interface Dependencies {
  readonly awsRegion: string;
  readonly incidentsTableName: string;
  readonly githubRepoNames: string[];
  readonly dynamoDb: DynamoDBDocumentClient;
  /**
   * The raw Slack WebClient, exposed for the signed-HTTP Slack surface: the
   * slash-command dispatch (each `CommandContext` carries it as `slack`) and
   * the interactivity handler's `views.open`. New domain services should depend
   * on `slackAdapter` instead so they inherit the timeout/fail-mode discipline.
   */
  readonly slackWebClient: WebClient;
  readonly slackAdapter: SlackAdapter;
  readonly auditWriter: AuditWriter;
  readonly metrics: MetricsEmitter;
  readonly incidentResponseAI: IncidentResponseAI;
  readonly linearClient: LinearIncidentResponseClient;
  readonly githubClient: GitHubClient;
  readonly nudgeScheduler: NudgeScheduler;
  readonly approvalGate: StatuspageApprovalGate;
  readonly warRoomAssembler: WarRoomAssembler;
}

export function buildDependencies(): Dependencies {
  // Through the one accessor rather than a `!` assertion: the webhook
  // entrypoint reaches this without an entrypoint-level env check, so a missing
  // region has to fail here rather than construct every client against
  // `undefined`.
  const awsRegion = resolveAwsRegion();
  const incidentsTableName = process.env.INCIDENTS_TABLE_NAME!;
  const githubRepoNames = (process.env.GITHUB_REPO_NAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // removeUndefinedValues: true — audit/incident writes frequently carry
  // optional fields like `linear_issue_id` that are undefined when an
  // upstream step (Linear postmortem creation) failed. Without this, DDB
  // marshaling throws "Pass options.removeUndefinedValues=true" and the
  // write fails — which for INCIDENT_RESOLVED would silently drop the
  // resolution audit event.
  // Bounded: the approval gate's read-after-write runs through this client, and
  // a hung read there stalls the gate rather than failing it — indistinguishable
  // downstream from a slow publish that is still coming.
  const dynamoDb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: awsRegion, requestHandler: boundedRequestHandler() }),
    {
      marshallOptions: { removeUndefinedValues: true },
    },
  );
  const metrics = new MetricsEmitter(awsRegion);
  // Wire HttpClient timeout-emit hook to the shared metrics emitter so that any
  // external client timing out shows up in Mimir without each call site needing
  // to plumb metrics through.
  setHttpClientMetrics(metrics);

  const grafanaOnCallClient = new GrafanaOnCallClient(
    process.env.GRAFANA_ONCALL_BASE_URL ?? "https://oncall-prod-us-central-0.grafana.net",
    process.env.GRAFANA_ONCALL_TOKEN!,
  );
  const grafanaCloudClient = new GrafanaCloudClient(
    process.env.GRAFANA_CLOUD_BASE_URL ?? "https://prometheus-prod-01-prod-us-east-0.grafana.net",
    process.env.GRAFANA_CLOUD_ORG_ID!,
    process.env.GRAFANA_CLOUD_TOKEN!,
  );
  // Circuit breaker for WorkOS directory lookups: 5 failures within a 60s
  // sliding window opens the circuit for 30s (then a single half-open probe),
  // so a degraded WorkOS doesn't get hammered by every P1 incident retry.
  // WarRoomAssembler still degrades to manual-invite via
  // `DirectoryLookupFailedError` while the circuit is open.
  const directoryBreaker = createCircuitBreaker({
    name: "workos.directory",
    failureThreshold: 5,
    windowMs: 60_000,
    halfOpenAfterMs: 30_000,
    metrics,
  });
  const directoryClient = new WorkOSClient(
    process.env.WORKOS_API_KEY!,
    process.env.WORKOS_DIRECTORY_ID!,
    directoryBreaker,
  );
  const statuspageClient = new StatuspageClient(
    process.env.STATUSPAGE_API_KEY!,
    process.env.STATUSPAGE_PAGE_ID!,
  );
  const linearClient = new LinearIncidentResponseClient(
    process.env.LINEAR_API_KEY!,
    process.env.LINEAR_PROJECT_ID!,
    process.env.LINEAR_TEAM_ID!,
  );
  const githubClient = new GitHubClient(
    process.env.GITHUB_TOKEN ?? "",
    process.env.GITHUB_ORG_SLUG ?? "",
  );
  const auditWriter = new AuditWriter(dynamoDb, process.env.AUDIT_TABLE_NAME!);
  // NudgeScheduler's second arg is the queue ARN, not URL — EventBridge
  // Scheduler's `Target.Arn` field expects an AWS resource ARN. Passing the
  // SQS URL here fails silently at schedule-create time with
  // "Provided Arn is not in correct format", which means 15-min status
  // nudges never fire even though the audit log shows scheduling attempts.
  const nudgeScheduler = new NudgeScheduler(
    process.env.SCHEDULER_ROLE_ARN!,
    process.env.NUDGE_EVENTS_QUEUE_ARN!,
    awsRegion,
    process.env.SCHEDULER_GROUP_NAME!,
  );
  const incidentResponseAI = new IncidentResponseAI(config.MODEL_GATEWAY_ENDPOINT, metrics);
  const slackWebClient = new WebClient(process.env.SLACK_BOT_TOKEN, { timeout: 10000 });
  const slackAdapter = createSlackAdapter(slackWebClient);
  const approvalGate = new StatuspageApprovalGate(
    dynamoDb,
    incidentsTableName,
    auditWriter,
    statuspageClient,
    metrics,
  );
  const warRoomAssembler = new WarRoomAssembler(
    slackAdapter,
    dynamoDb,
    incidentsTableName,
    directoryClient,
    grafanaOnCallClient,
    grafanaCloudClient,
    auditWriter,
    nudgeScheduler,
    process.env.GITHUB_ORG_SLUG ?? "",
    metrics,
  );

  return {
    awsRegion,
    incidentsTableName,
    githubRepoNames,
    dynamoDb,
    slackWebClient,
    slackAdapter,
    auditWriter,
    metrics,
    incidentResponseAI,
    linearClient,
    githubClient,
    nudgeScheduler,
    approvalGate,
    warRoomAssembler,
  };
}
