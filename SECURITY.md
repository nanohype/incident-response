# Security Policy

## Reporting a vulnerability

Email rackctl@gmail.com with subject `[security][incident-response]`. Do not open public issues for security reports.

Acknowledgement target: within 72 hours. Triage target: within 5 business days.

## Security posture

incident-response is an incident-commander assistant: a Grafana OnCall webhook fans a P1 into a
Slack war room, and the IC drives the response through `/incident-response` slash commands. It handles
incident metadata, responder identities, and the IC's conversation with the model, and it can
publish customer-facing Statuspage updates — so its defining controls are that **the webhook
ingress only trusts requests it can cryptographically verify**, **no customer-facing Statuspage
publish happens without a recorded human approval**, and **the IC↔AI conversation never leaks to
inference logs or third parties**.

### Webhook authentication (HMAC, constant-time, rotation-safe)

- Every Grafana OnCall webhook is verified with **HMAC-SHA256** over the raw request body before
  anything is parsed or persisted (`src/handlers/webhook-ingress.ts`). The comparison uses
  `crypto.timingSafeEqual`, so signature checking is constant-time and doesn't leak the expected
  digest byte-by-byte.
- The signing secret is read from AWS Secrets Manager and cached keyed on the SecretsManager
  `VersionId` with a 5-minute TTL. On a verification failure the cache force-refreshes once and
  retries the check — so a secret rotation mid-flight recovers on the next request instead of
  failing every webhook until the TTL expires, and rotating the HMAC secret never needs a pod
  redeploy.
- A request that fails verification is rejected at the boundary (`401`); it is never written to
  DynamoDB and never enqueued to SQS.

### The Statuspage approval-gate invariant

- A customer-facing Statuspage incident is **only ever created through
  `src/services/statuspage-approval-gate.ts`** — it is the single call site of
  `StatuspageClient.createIncident()` anywhere in the codebase.
- The gate is a **two-phase commit**: it writes a `STATUSPAGE_DRAFT_APPROVED` audit event, then
  re-reads the audit log with `ConsistentRead: true`, and only on a confirmed read does it call
  `createIncident()`. If the audit write or the consistent re-read fails, the publish never
  happens and the gate throws `AutoPublishNotPermittedError`. There is no auto-publish path.
- This is enforced two ways so it can't silently regress: a **CI grep-gate** fails the build if
  `createIncident()` appears anywhere outside the gate file, and the gate carries **100% branch
  coverage** (alongside `src/utils/audit.ts`) — CI goes red if a branch drops.

### Data handling & inference

- `stripPII` runs **before every Bedrock call** (`src/ai/incident-response-ai.ts`), so responder names,
  contact details, and other sensitive strings in incident context are scrubbed out of the prompt
  before drafts or postmortem sections are generated.
- **Bedrock invocation logging is set to NONE** for the account, so the IC↔AI conversation (the
  model request and response bodies) never lands in CloudWatch. This is an **account-level control
  owned by the `landing-zone` substrate** — not app code. The app relies on it being in place; it
  does not (and should not) try to set it from the tenant.
- Inference runs on-account via Amazon Bedrock — incident content is not sent to third parties.

### Identity & secrets

- No long-lived credentials in the app. Pods get AWS access via EKS Pod Identity; there
  are no static keys anywhere in the repo or image. DynamoDB, SQS, Bedrock, EventBridge Scheduler,
  and Secrets Manager calls AssumeRoleWithWebIdentity into the landing-zone `tenant-substrate`
  IAM role.
- App-level secrets are projected at deploy time by External Secrets Operator from AWS Secrets
  Manager (one entry per integration under `incident-response/<env>/`, enumerated in `secrets.template.json`)
  into a Kubernetes Secret consumed `envFrom` — never committed. No telemetry credential is among
  them: the pods export OTLP to the cluster's in-cluster collector gateway receiver, which authenticates
  nothing, so there is no header to project. The one credential that stays out of the pod spec
  entirely is `incident-response/<env>/grafana-cloud/otlp-auth`, read through the pod's own
  `secretsmanager:GetSecretValue` grant by `src/handlers/webhook-otel-init.ts` and only on a
  deployment that has repointed export at an authenticated gateway.

### Network

- Default-deny `NetworkPolicy`: ingress is limited to the VPC range the ALB's network interfaces
  sit in reaching the webhook Deployment (the load balancer is not a pod, so it is a CIDR rule
  rather than a namespace selector); egress is DNS plus HTTPS to AWS APIs and the Slack /
  Grafana / Linear / WorkOS / Statuspage endpoints. IMDS is blocked.
- Public surface is limited to `/health` and the signed Grafana OnCall webhook POST behind
  the ALB, which terminates TLS against an ACM certificate and redirects plaintext to HTTPS.

## Known limitations

- Webhook authenticity is bounded by the secrecy of the HMAC signing secret. Anyone who can read
  the `incident-response/<env>` HMAC secret can forge a P1; protection of the secret rests on Secrets
  Manager access control and the Pod-Identity-only posture.
- The Bedrock-logging-NONE guarantee is a substrate control. If the `landing-zone` account
  configuration drifts (someone re-enables invocation logging out of band), IC↔AI conversations
  could reach CloudWatch — the app cannot detect or correct that on its own. Verifying it stays
  NONE is a landing-zone responsibility.
- The approval gate trusts the actor that clicked approve in Slack. The gate proves *that* an
  approval was recorded before a publish, not that the approver was authorized for that specific
  incident — authorization is upstream in the Slack action bindings.

## Compliance

incident-response exposes the controls needed for **SOC 2 Type II** — Pod-Identity-only access with no
static credentials, secrets sourced from AWS Secrets Manager (never committed), a constant-time
HMAC check at the only ingress, PII scrubbing before inference, inference logging disabled at the
account level, and a recorded human-approval gate as the sole path to any customer-facing
publish, backed by a complete per-incident audit trail in DynamoDB. Substrate-level controls
(CIS EKS baseline, Pod Security Standards, image signing, and the account-level Bedrock
invocation-logging=NONE setting) are enforced upstream by `landing-zone` and `eks-gitops`.
