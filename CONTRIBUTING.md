# Contributing

## Workflow

1. Branch from `main` with a conventional prefix: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`.
2. Run `task ci` locally before pushing. CI must pass.
3. Use the structured commit-message format from `~/.claude/CLAUDE.md` (section headers, file-level detail, scaled verbosity).
4. Open a PR. Reviews are required for changes under `src/services/`, `src/handlers/`, and `chart/`.

## Local prereqs

| Tool     | Version                           |
| -------- | --------------------------------- |
| `node`   | see `package.json` engines (≥ 24) |
| `npm`    | bundled with Node 24              |
| `helm`   | matches the target cluster minor  |
| `task`   | latest                            |
| `docker` | for the container build job and `test:integration:docker` (runs `amazon/dynamodb-local`) |

## Layout

See [README.md](./README.md), [AGENTS.md](./AGENTS.md), and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Toolchain — CommonJS + Jest (deliberate)

This repo is **CommonJS**, not ESM — `package.json` has no `"type": "module"` and
`tsconfig.json` emits `module: commonjs`. It runs on Node 24 and every dependency is
CJS-compatible. This is an intentional choice, not drift: keeping CommonJS avoids a refactor that
would touch the two 100%-branch-coverage invariant files for no runtime benefit.

Tests run on **Jest** (`jest.config.cjs` + `jest.config.integration.cjs`), not Vitest — also
deliberate. The enforced invariant below is the load-bearing reason: migrating the runner would
put the 100%-branch guarantee at risk. Don't convert either of these; they're documented choices.

## The test contract (grep-enforced in CI)

Three invariants are enforced by CI grep checks — they are the load-bearing guardrails of an
incident-commander system, not style preferences:

1. **`createIncident()` only in the gate.** The single call site of
   `StatuspageClient.createIncident()` is `src/services/statuspage-approval-gate.ts`. CI fails if
   the call appears anywhere else — no customer-facing Statuspage publish may bypass the
   two-phase-commit approval gate (see [SECURITY.md](./SECURITY.md)).
2. **`new WebClient(` only in the adapter.** The Slack client is constructed once in the Slack
   adapter and injected downstream; CI fails on a stray `new WebClient(` elsewhere.
3. **No bare `fetch(`** outside `src/utils/http-client.ts`. Boundary calls go through the
   hard-capped HTTP client (≤5s timeout, ≤2 retries, jittered backoff); CI fails on a bare
   `fetch(` outside it.

### Coverage

- **100% branch coverage on `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts`.**
  CI fails on any regression — both arms of every branch must be covered. The enforcement is live:
  flipping `ConsistentRead: true` → `false` in `audit.ts` makes `npm run test:unit` exit 1.
- Global floor: 55% branches / 75% statements / 75% lines / 75% functions. A PR that lowers
  coverage turns CI red.
- Test files are typechecked too — `npm run typecheck` includes `test/**` via
  `tsconfig.eslint.json`, so test type drift doesn't slip past the lazy `ts-jest` path.

### Integration tests

Integration tests run against **`amazon/dynamodb-local`**. Use `npm run test:integration:docker` —
it starts the container, runs the suite (`ConsistentRead` semantics, idempotency, cross-incident
isolation against real DynamoDB behavior), and tears the container down. Anything that depends on
DynamoDB semantics (consistency, conditions, GSI) belongs here, not in a unit test.

When adding tests: accept the SDK client as a typed dep on the source-side factory and inject a
fake. AWS SDK clients use `aws-sdk-client-mock` (client-level injection), never module-level
mocking. New boundary code needs a port-injected test; new pure logic needs a direct test.

## Adding a `/incident-response` subcommand

The dispatch layer is a registry — a new subcommand is a new file plus one registration line,
never a `switch` in `src/index.ts`. (Internal naming stays `incident-response`: the GitHub repo is
`incident-response`, but the Slack product surface, the OTel identity, and the secret prefixes
all stay `incident-response` — see [ARCHITECTURE.md](./ARCHITECTURE.md).)

1. Add `src/commands/<name>.ts` exporting a `make<Name>Handler(deps)` factory (match the shape of
   `status.ts` / `resolve.ts` / `silence.ts` / `checklist.ts` / `help.ts`). Take every external
   service as an injected client; drive each action through and report honestly to the IC — never
   reply "triggered" for work that didn't happen.
2. Register it with one `.register('<name>', handler)` line in `src/wiring/commands.ts`. The
   `CommandRegistry` is case-insensitive and returns "Unknown command" for unregistered names.
3. Add a handler-level unit test plus an entry in the command-registry test. Anything
   security-critical (a new Statuspage or audit path) gets covered in the 100%-branch files.

## Adding an SQS event type

The SQS consumer dispatches through the `EventRegistry` the same way — a new event type is a new
file plus a registration, never a branch in the consumer.

1. Add `src/events/<type>.ts` (match `alert-received.ts` / `alert-resolved.ts` /
   `sla-check.ts` / `status-update-nudge.ts`). Validate the payload with Zod at the boundary.
2. Register it in `src/wiring/events.ts`. Unknown event types log a warn and no-op — the
   consumer is DLQ-safe (no `DeleteMessage` on a handler exception; the 300s visibility timeout
   drives retry).
3. Add a handler-level unit test plus a registry-test entry.

## Deploy contract

This app ships as a Platform tenant: a Helm `chart/`, a `platform.yaml` (Platform CR), and a
`gitops/applicationset-entry.yaml`. Per-tenant AWS substrate (DynamoDB, SQS, EventBridge
Scheduler, S3, IRSA) lives in `landing-zone` (the `incident-response-platform` component); cluster addons
live in `eks-gitops`. Do not add IAM, cloud resources, or cluster addons to the chart — see
[ARCHITECTURE.md](./ARCHITECTURE.md#boundaries).

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
