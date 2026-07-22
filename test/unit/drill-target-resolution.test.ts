/**
 * Behavioural tests for `scripts/fire-drill.sh`: where a drill's request
 * actually goes, and whose secret actually signed it.
 *
 * The invariant, stated once:
 *
 *   A payload signed for environment X is delivered only to environment X's
 *   webhook host, or nothing is sent at all.
 *
 * Every case here asserts that on the wire, not on the script's own account of
 * itself. Each environment gets a stub webhook that verifies signatures with the
 * repository's own `verifyHmacSignature` and validates bodies with its own
 * `GrafanaOnCallPayloadSchema`, so "delivered" means a real request arrived and
 * "refused" means no listener saw anything. A stub `aws` on PATH hands out a
 * different secret per environment, so the stub that receives a request can say
 * which environment's secret signed it.
 *
 * The combinations are generated, not hand-picked. A suite that supplies one
 * target-naming input per case stays green while `--url` and `--host` disagree
 * about where the POST goes, so the generator enumerates every way a target or a
 * signing identity can be named and runs them in pairs and triples, including
 * pairs that disagree. Expected outcomes come from a small oracle that states
 * the rules in the abstract — never from what the script happens to do.
 *
 * Fixture notes: the stubs are HTTPS, because a hostname resolves to an `https`
 * base URL and the drill has no insecure switch; the certificate is generated
 * per run and trusted through `CURL_CA_BUNDLE`. Each environment's hostname is a
 * loopback name carrying its listening port (`localhost:PORT`, `127.0.0.1:PORT`)
 * so two environments differ in hostname the way two real deployments do.
 * `development` is deliberately given a host nothing listens on: it exists to be
 * a foreign environment, and a delivery there would be a failure either way.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { verifyHmacSignature } from "../../src/handlers/webhook-ingress.js";
import { GrafanaOnCallPayloadSchema } from "../../src/types/index.js";

const SCRIPT = path.resolve(__dirname, "../../scripts/fire-drill.sh");
const BASE_VALUES = path.resolve(__dirname, "../../chart/values.yaml");

// The stub webhooks live in this process, so the drill has to be spawned without
// blocking the event loop — a synchronous spawn would deadlock against the
// listener it is talking to.
const execFileAsync = promisify(execFile);

type Env = "development" | "staging" | "production";
const ENVS: Env[] = ["development", "staging", "production"];

/** Environments a drill is run for here. `development` is only ever a foreign target. */
const DRILL_ENVS: Env[] = ["staging", "production"];

const upper = (env: Env) => env.toUpperCase();
const secretIdOf = (env: Env) => `incident-response/${env}/grafana/oncall-webhook-hmac`;
const secretOf = (env: Env) => `hmac-secret-for-${env}`;

/** `host:port` as each environment declares it. Ports arrive once the stubs are up. */
const HOSTS: Record<Env, string> = {
  development: "127.0.0.55",
  staging: "localhost",
  production: "127.0.0.1",
};

/** Hostname only — the form the cross-environment checks compare. */
const bareHost = (hostPort: string) => (hostPort.split(":")[0] ?? "").toLowerCase();

/** A host no environment claims, for the "values file is the identity" rule. */
const FOREIGN_HOST = "webhook.someone-elses-zone.invalid";

/** A port nothing listens on, for showing that a port cannot hide a collision. */
const DEAD_PORT = "19999";

interface Delivery {
  listener: Env;
  method: string;
  path: string;
  hostHeader: string;
  /** Which environment's secret produced the signature, or null if none did. */
  signedFor: Env | null;
  payloadEnvironment: string | null;
  schemaValid: boolean;
}

const deliveries: Delivery[] = [];
const servers: https.Server[] = [];

let fixtureRoot = "";
let binDir = "";
let certPath = "";

function stubHandler(listener: Env) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const signature = String(req.headers["x-grafana-oncall-signature"] ?? "");
      let signedFor: Env | null = null;
      for (const env of ENVS) {
        if (verifyHmacSignature(body, signature, secretOf(env))) signedFor = env;
      }

      let payloadEnvironment: string | null = null;
      let schemaValid = false;
      try {
        const parsed = GrafanaOnCallPayloadSchema.safeParse(JSON.parse(body));
        schemaValid = parsed.success;
        if (parsed.success) payloadEnvironment = parsed.data.labels?.environment ?? null;
      } catch {
        schemaValid = false;
      }

      deliveries.push({
        listener,
        method: req.method ?? "",
        path: req.url ?? "",
        hostHeader: String(req.headers.host ?? ""),
        signedFor,
        payloadEnvironment,
        schemaValid,
      });

      res.writeHead(signedFor === listener ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ stub: listener }));
    });
  };
}

/** One throwaway repo root shared by the generated cases: the real script, the real base values. */
function buildFixture(): void {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drill-wire-"));
  binDir = path.join(fixtureRoot, "bin");
  fs.mkdirSync(path.join(fixtureRoot, "scripts"));
  fs.mkdirSync(path.join(fixtureRoot, "chart"));
  fs.mkdirSync(binDir);
  fs.copyFileSync(SCRIPT, path.join(fixtureRoot, "scripts/fire-drill.sh"));
  fs.copyFileSync(BASE_VALUES, path.join(fixtureRoot, "chart/values.yaml"));

  // A Secrets Manager that hands out one secret per environment tree, so the
  // signature on the wire says which environment the drill signed for.
  fs.writeFileSync(
    path.join(binDir, "aws"),
    [
      "#!/usr/bin/env bash",
      'for arg in "$@"; do',
      '  case "$arg" in',
      ...ENVS.map((env) => `    ${secretIdOf(env)}) printf '${secretOf(env)}\\n'; exit 0 ;;`),
      "  esac",
      "done",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // `--from-cluster` reads a live Ingress; this serves whichever host the case
  // put in STUB_INGRESS_HOST.
  fs.writeFileSync(
    path.join(binDir, "kubectl"),
    ["#!/usr/bin/env bash", 'printf "%s" "$STUB_INGRESS_HOST"', ""].join("\n"),
    { mode: 0o755 },
  );

  certPath = path.join(fixtureRoot, "stub-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(fixtureRoot, "stub-key.pem"),
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}

interface RunResult {
  code: number;
  stdout: string;
  output: string;
}

/**
 * Run the drill in a fixture. The environment is built from scratch rather than
 * inherited: a DRILL_* variable set by whoever ran the suite deciding the
 * outcome is the exact class of bug under test.
 */
async function run(
  args: string[],
  extraEnv: Record<string, string> = {},
  root: string = fixtureRoot,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: root,
    // Trust the stub webhooks' certificate, and nothing else.
    CURL_CA_BUNDLE: certPath,
    SSL_CERT_FILE: certPath,
    ...extraEnv,
  };
  try {
    const { stdout } = await execFileAsync(
      "bash",
      [path.join(root, "scripts/fire-drill.sh"), ...args],
      { env, encoding: "utf8" },
    );
    return { code: 0, stdout, output: stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

// ── The ways a target can be named ──────────────────────────────────────────

type Mutation = "asIs" | "upperCase" | "otherPort" | "trailingDot" | "noPort" | "userinfo";
const SPELLINGS: Mutation[] = [
  "asIs",
  "upperCase",
  "otherPort",
  "trailingDot",
  "noPort",
  "userinfo",
];

/** Spellings of one host. None of them may change which environment it belongs to. */
function mutate(hostPort: string, mutation: Mutation): string {
  const host = bareHost(hostPort);
  const port = hostPort.split(":")[1];
  switch (mutation) {
    case "asIs":
      return hostPort;
    case "upperCase":
      return port ? `${host.toUpperCase()}:${port}` : host.toUpperCase();
    case "otherPort":
      return `${host}:${DEAD_PORT}`;
    case "trailingDot":
      return port ? `${host}.:${port}` : `${host}.`;
    case "noPort":
      return host;
    // curl connects to what follows the last `@` and ignores what precedes it,
    // so userinfo is a way to spell a hostname that a naive check misreads.
    case "userinfo":
      return `drill@${hostPort}`;
  }
}

interface BuiltInput {
  args: string[];
  env: Record<string, string>;
}

interface TargetInput {
  name: string;
  /** False for the unscoped variables the drill refuses by name. */
  scoped: boolean;
  build(target: Env, drillEnv: Env, mutation: Mutation): BuiltInput;
}

const URL_FLAG: TargetInput = {
  name: "--url",
  scoped: true,
  build: (target, _drillEnv, mutation) => ({
    args: ["--url", `https://${mutate(HOSTS[target], mutation)}`],
    env: {},
  }),
};

const HOST_FLAG: TargetInput = {
  name: "--host",
  scoped: true,
  build: (target, _drillEnv, mutation) => ({
    args: ["--host", mutate(HOSTS[target], mutation)],
    env: {},
  }),
};

const SCOPED_URL_VAR: TargetInput = {
  name: "DRILL_WEBHOOK_URL_<ENV>",
  scoped: true,
  build: (target, drillEnv, mutation) => ({
    args: [],
    env: { [`DRILL_WEBHOOK_URL_${upper(drillEnv)}`]: `https://${mutate(HOSTS[target], mutation)}` },
  }),
};

const SCOPED_HOST_VAR: TargetInput = {
  name: "DRILL_WEBHOOK_HOST_<ENV>",
  scoped: true,
  build: (target, drillEnv, mutation) => ({
    args: [],
    env: { [`DRILL_WEBHOOK_HOST_${upper(drillEnv)}`]: mutate(HOSTS[target], mutation) },
  }),
};

const FROM_CLUSTER: TargetInput = {
  name: "--from-cluster",
  scoped: true,
  build: (target, _drillEnv, mutation) => ({
    args: ["--from-cluster"],
    env: { STUB_INGRESS_HOST: mutate(HOSTS[target], mutation) },
  }),
};

const UNSCOPED_URL_VAR: TargetInput = {
  name: "DRILL_WEBHOOK_URL",
  scoped: false,
  build: (target, _drillEnv, mutation) => ({
    args: [],
    env: { DRILL_WEBHOOK_URL: `https://${mutate(HOSTS[target], mutation)}` },
  }),
};

const UNSCOPED_HOST_VAR: TargetInput = {
  name: "DRILL_WEBHOOK_HOST",
  scoped: false,
  build: (target, _drillEnv, mutation) => ({
    args: [],
    env: { DRILL_WEBHOOK_HOST: mutate(HOSTS[target], mutation) },
  }),
};

const SCOPED_TARGET_INPUTS: TargetInput[] = [
  URL_FLAG,
  HOST_FLAG,
  SCOPED_URL_VAR,
  SCOPED_HOST_VAR,
  FROM_CLUSTER,
];
const ALL_TARGET_INPUTS: TargetInput[] = [
  ...SCOPED_TARGET_INPUTS,
  UNSCOPED_URL_VAR,
  UNSCOPED_HOST_VAR,
];

// ── The ways a signing identity can be named ────────────────────────────────

interface IdentityInput {
  name: string;
  scoped: boolean;
  /** True when the value names an environment the drill can read; false for a pasted literal. */
  attributable: boolean;
  build(secretEnv: Env, drillEnv: Env): BuiltInput;
}

const SECRET_ID_FLAG: IdentityInput = {
  name: "--hmac-secret-id",
  scoped: true,
  attributable: true,
  build: (secretEnv) => ({ args: ["--hmac-secret-id", secretIdOf(secretEnv)], env: {} }),
};

const SCOPED_SECRET_ID_VAR: IdentityInput = {
  name: "DRILL_HMAC_SECRET_ID_<ENV>",
  scoped: true,
  attributable: true,
  build: (secretEnv, drillEnv) => ({
    args: [],
    env: { [`DRILL_HMAC_SECRET_ID_${upper(drillEnv)}`]: secretIdOf(secretEnv) },
  }),
};

const UNSCOPED_SECRET_ID_VAR: IdentityInput = {
  name: "DRILL_HMAC_SECRET_ID",
  scoped: false,
  attributable: true,
  build: (secretEnv) => ({ args: [], env: { DRILL_HMAC_SECRET_ID: secretIdOf(secretEnv) } }),
};

const SCOPED_SECRET_VAR: IdentityInput = {
  name: "DRILL_HMAC_SECRET_<ENV>",
  scoped: true,
  attributable: false,
  build: (secretEnv, drillEnv) => ({
    args: [],
    env: { [`DRILL_HMAC_SECRET_${upper(drillEnv)}`]: secretOf(secretEnv) },
  }),
};

const UNSCOPED_SECRET_VAR: IdentityInput = {
  name: "DRILL_HMAC_SECRET",
  scoped: false,
  attributable: false,
  build: (secretEnv) => ({ args: [], env: { DRILL_HMAC_SECRET: secretOf(secretEnv) } }),
};

const IDENTITY_INPUTS: IdentityInput[] = [
  SECRET_ID_FLAG,
  SCOPED_SECRET_ID_VAR,
  UNSCOPED_SECRET_ID_VAR,
  SCOPED_SECRET_VAR,
  UNSCOPED_SECRET_VAR,
];

// ── The oracle ──────────────────────────────────────────────────────────────

interface Combination {
  title: string;
  drillEnv: Env;
  /** One entry per input that names a target. Empty means the values file decides. */
  targets: Array<{ input: TargetInput; target: Env; mutation: Mutation }>;
  identity?: { input: IdentityInput; secretEnv: Env };
}

type Outcome = { delivered: false } | { delivered: true; to: Env; signedFor: Env };

/**
 * What must happen, derived from the rules rather than from the script: an
 * unscoped override is refused by name; a target named twice is refused; a
 * target or a readable secret id belonging to another environment is refused;
 * anything else is delivered to this environment, signed with its secret.
 */
function oracle(c: Combination): Outcome {
  if (c.targets.some((t) => !t.input.scoped)) return { delivered: false };
  if (c.targets.length > 1) return { delivered: false };
  if (c.identity && !c.identity.input.scoped) return { delivered: false };
  if (c.identity?.input.attributable && c.identity.secretEnv !== c.drillEnv) {
    return { delivered: false };
  }
  const target = c.targets[0]?.target ?? c.drillEnv;
  if (target !== c.drillEnv) return { delivered: false };
  return { delivered: true, to: c.drillEnv, signedFor: c.identity?.secretEnv ?? c.drillEnv };
}

function materialize(c: Combination): BuiltInput {
  const args = ["--env", c.drillEnv];
  const env: Record<string, string> = {};
  for (const t of c.targets) {
    const built = t.input.build(t.target, c.drillEnv, t.mutation);
    args.push(...built.args);
    Object.assign(env, built.env);
  }
  if (c.identity) {
    const built = c.identity.input.build(c.identity.secretEnv, c.drillEnv);
    args.push(...built.args);
    Object.assign(env, built.env);
  }
  return { args, env };
}

/**
 * Run one combination and hold the invariant against what reached the wire, then
 * check that `--print-host` describes that same request and no other.
 */
async function assertInvariant(c: Combination): Promise<void> {
  const expected = oracle(c);
  const { args, env } = materialize(c);
  const before = deliveries.length;

  const result = await run(args, env);
  const fresh = deliveries.slice(before);
  const printed = await run([...args, "--print-host"], env);

  if (!expected.delivered) {
    expect(fresh, `nothing may reach any listener: ${JSON.stringify(fresh)}`).toHaveLength(0);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("[drill] FAIL:");
    // A refusal happens before the request, so no status line is ever printed.
    expect(result.output).not.toContain("[drill] HTTP ");
    expect(printed.code).not.toBe(0);
    expect(printed.stdout.trim()).toBe("");
    return;
  }

  expect(fresh, `exactly one request: ${JSON.stringify(fresh)}`).toHaveLength(1);
  const delivery = fresh[0] as Delivery;
  expect(delivery.listener).toBe(expected.to);
  expect(delivery.signedFor).toBe(expected.signedFor);
  expect(delivery.payloadEnvironment).toBe(c.drillEnv);
  expect(delivery.schemaValid).toBe(true);
  expect(delivery.method).toBe("POST");
  expect(delivery.path).toBe("/webhook/grafana-oncall");
  expect(bareHost(delivery.hostHeader)).toBe(bareHost(HOSTS[expected.to]));
  // The webhook answers 200 only to its own environment's signature, and the
  // drill exits non-zero on anything else.
  expect(result.code).toBe(expected.signedFor === expected.to ? 0 : 1);
  // `--print-host` has to name the host of the request that was actually made.
  expect(printed.code).toBe(0);
  expect(printed.stdout.trim()).toBe(bareHost(delivery.hostHeader));
}

// ── Case generation ─────────────────────────────────────────────────────────

const combinations: Combination[] = [];

function push(c: Combination): void {
  combinations.push(c);
}

// One input at a time, against its own environment and against each foreign one.
// A foreign target is spelled five ways: a port, letter case, a trailing root
// dot and a missing port must not change which environment a host belongs to.
for (const drillEnv of DRILL_ENVS) {
  for (const input of ALL_TARGET_INPUTS) {
    for (const target of ENVS) {
      const spellings: Mutation[] = target === drillEnv ? ["asIs"] : SPELLINGS;
      for (const mutation of spellings) {
        push({
          title: `--env ${drillEnv} | ${input.name} -> ${target} (${mutation})`,
          drillEnv,
          targets: [{ input, target, mutation }],
        });
      }
    }
  }
  // No target-naming input at all: the values file decides.
  push({ title: `--env ${drillEnv} | chart/values-${drillEnv}.yaml`, drillEnv, targets: [] });
}

// Two inputs at a time — agreeing and disagreeing, in both orders. The exploit
// that shipped was a disagreeing pair whose checks read one input and whose POST
// read the other.
for (const drillEnv of DRILL_ENVS) {
  for (let i = 0; i < SCOPED_TARGET_INPUTS.length; i++) {
    for (let j = i + 1; j < SCOPED_TARGET_INPUTS.length; j++) {
      const first = SCOPED_TARGET_INPUTS[i] as TargetInput;
      const second = SCOPED_TARGET_INPUTS[j] as TargetInput;
      for (const foreign of ENVS) {
        push({
          title: `--env ${drillEnv} | ${first.name} -> ${drillEnv} + ${second.name} -> ${foreign}`,
          drillEnv,
          targets: [
            { input: first, target: drillEnv, mutation: "asIs" },
            { input: second, target: foreign, mutation: "asIs" },
          ],
        });
        push({
          title: `--env ${drillEnv} | ${second.name} -> ${foreign} + ${first.name} -> ${drillEnv}`,
          drillEnv,
          targets: [
            { input: second, target: foreign, mutation: "asIs" },
            { input: first, target: drillEnv, mutation: "asIs" },
          ],
        });
      }
    }
  }
}

// An unscoped variable alongside a perfectly good scoped one: the unscoped name
// is refused rather than quietly losing a precedence contest.
for (const drillEnv of DRILL_ENVS) {
  for (const unscoped of [UNSCOPED_URL_VAR, UNSCOPED_HOST_VAR]) {
    for (const scoped of SCOPED_TARGET_INPUTS) {
      push({
        title: `--env ${drillEnv} | ${scoped.name} -> ${drillEnv} + ${unscoped.name} -> ${drillEnv}`,
        drillEnv,
        targets: [
          { input: scoped, target: drillEnv, mutation: "asIs" },
          { input: unscoped, target: drillEnv, mutation: "asIs" },
        ],
      });
    }
  }
}

// Three inputs at a time, each naming a different environment.
for (let i = 0; i < SCOPED_TARGET_INPUTS.length; i++) {
  for (let j = i + 1; j < SCOPED_TARGET_INPUTS.length; j++) {
    for (let k = j + 1; k < SCOPED_TARGET_INPUTS.length; k++) {
      const trio = [
        SCOPED_TARGET_INPUTS[i] as TargetInput,
        SCOPED_TARGET_INPUTS[j] as TargetInput,
        SCOPED_TARGET_INPUTS[k] as TargetInput,
      ];
      push({
        title: `--env production | ${trio.map((t) => t.name).join(" + ")} (mixed targets)`,
        drillEnv: "production",
        targets: [
          { input: trio[0] as TargetInput, target: "production", mutation: "asIs" },
          { input: trio[1] as TargetInput, target: "staging", mutation: "asIs" },
          { input: trio[2] as TargetInput, target: "development", mutation: "asIs" },
        ],
      });
    }
  }
}

// A signing identity crossed with a target. The secret is the other half of the
// pair: the right host signed with another environment's secret is the same
// misfire read backwards. A pasted literal secret is the caller's assertion and
// carries no environment to check, so it is only ever paired with its own.
for (const drillEnv of DRILL_ENVS) {
  for (const identity of IDENTITY_INPUTS) {
    const secretEnvs = identity.attributable ? ENVS : [drillEnv];
    for (const secretEnv of secretEnvs) {
      push({
        title: `--env ${drillEnv} | values file + ${identity.name} -> ${secretEnv}`,
        drillEnv,
        targets: [],
        identity: { input: identity, secretEnv },
      });
      push({
        title: `--env ${drillEnv} | --url -> ${drillEnv} + ${identity.name} -> ${secretEnv}`,
        drillEnv,
        targets: [{ input: URL_FLAG, target: drillEnv, mutation: "asIs" }],
        identity: { input: identity, secretEnv },
      });
    }
  }
}

// ── The suite ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  buildFixture();
  const key = fs.readFileSync(path.join(fixtureRoot, "stub-key.pem"));
  const cert = fs.readFileSync(certPath);
  for (const env of DRILL_ENVS) {
    const server = https.createServer({ key, cert }, stubHandler(env));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("stub has no port");
    HOSTS[env] = `${HOSTS[env]}:${address.port}`;
    servers.push(server);
  }
  // The values files name the ports, so they are written once the stubs are up.
  for (const env of ENVS) {
    fs.writeFileSync(
      path.join(fixtureRoot, `chart/values-${env}.yaml`),
      `ingress:\n  host: ${HOSTS[env]}\n`,
    );
  }
});

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  for (const f of extraFixtures) fs.rmSync(f.root, { recursive: true, force: true });
});

describe("fire-drill.sh delivers only where it signs for", () => {
  it("covers pairs and triples, not just singletons", async () => {
    expect(combinations.filter((c) => c.targets.length === 2)).not.toHaveLength(0);
    expect(combinations.filter((c) => c.targets.length === 3)).not.toHaveLength(0);
    expect(combinations.filter((c) => c.identity !== undefined)).not.toHaveLength(0);
    // Every case where two inputs disagree must be a refusal — if the oracle
    // ever says otherwise, the invariant has been weakened by accident.
    const disagreeing = combinations.filter(
      (c) => new Set(c.targets.map((t) => t.target)).size > 1,
    );
    expect(disagreeing).not.toHaveLength(0);
    expect(disagreeing.every((c) => !oracle(c).delivered)).toBe(true);
    // A matrix of nothing but refusals would pass against a drill that never
    // fires at all, so some of it has to reach a listener.
    expect(combinations.filter((c) => oracle(c).delivered).length).toBeGreaterThan(10);
  });

  it.each(combinations)("$title", async (combination) => {
    await assertInvariant(combination);
  });
});

// ── The rules the generated cases lean on ───────────────────────────────────

/** A fixture with hand-written values files, for cases the generator cannot express. */
interface Fixture {
  root: string;
  run(args: string[], env?: Record<string, string>): Promise<RunResult>;
}

const extraFixtures: Fixture[] = [];

function fixture(hosts: Partial<Record<Env, string>>, baseHost?: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-values-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "chart"));
  fs.copyFileSync(SCRIPT, path.join(root, "scripts/fire-drill.sh"));
  const base = fs.readFileSync(BASE_VALUES, "utf8");
  fs.writeFileSync(
    path.join(root, "chart/values.yaml"),
    baseHost === undefined ? base : base.replace(/^ {2}host: ''.*$/m, `  host: ${baseHost}`),
  );
  for (const [env, host] of Object.entries(hosts)) {
    fs.writeFileSync(path.join(root, `chart/values-${env}.yaml`), `ingress:\n  host: ${host}\n`);
  }
  const f: Fixture = { root, run: (args, env = {}) => run(args, env, root) };
  extraFixtures.push(f);
  return f;
}

const REAL: Record<Env, string> = {
  development: "webhook-development.example-corp.io",
  staging: "webhook-staging.example-corp.io",
  production: "webhook.example-corp.io",
};

describe("what a values file means", () => {
  it("refuses to fire at the placeholder this repository ships", async () => {
    const f = fixture({ staging: "webhook-staging.example.com" });
    const { code, output } = await f.run(["--env", "staging", "--dry-run"]);

    expect(code).not.toBe(0);
    expect(output).toContain("placeholder host");
  });

  it("refuses an override that disagrees with the declared host", async () => {
    const f = fixture(REAL);
    const { code, output } = await f.run(["--env", "staging", "--host", FOREIGN_HOST, "--dry-run"]);

    expect(code).not.toBe(0);
    expect(output).toContain("refusing to fire");
    expect(output).toContain(REAL.staging);
  });

  it("accepts an override that agrees with the declared host in another spelling", async () => {
    const f = fixture(REAL);
    const spelled = `${REAL.staging.toUpperCase()}.`;
    const { code, output } = await f.run(["--env", "staging", "--host", spelled, "--dry-run"]);

    expect(code).toBe(0);
    expect(output).toContain(`POST   https://${spelled}/webhook/grafana-oncall`);
  });

  it("allows an override when that environment ships only the placeholder", async () => {
    // A fork that has deployed staging but not production: there is no
    // production identity to contradict, so a scoped variable is how the target
    // is named. The cross-environment check still applies.
    const f = fixture({ staging: REAL.staging, production: "webhook.example.com" });
    const { code, output } = await f.run(["--env", "production", "--dry-run"], {
      DRILL_WEBHOOK_HOST_PRODUCTION: REAL.production,
    });

    expect(code).toBe(0);
    expect(output).toContain(`https://${REAL.production}/webhook/grafana-oncall`);
  });

  it("falls back to the base values file when an environment has no file of its own", async () => {
    const f = fixture({ staging: REAL.staging }, REAL.production);
    const { code, stdout } = await f.run(["--env", "production", "--print-host"]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(REAL.production);
  });

  it("prefers the per-environment file over the base file", async () => {
    const f = fixture(REAL, "webhook-from-base.example-corp.io");
    const { code, stdout } = await f.run(["--env", "production", "--print-host"]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(REAL.production);
  });

  it("refuses when no file names a host at all", async () => {
    const f = fixture({});
    const { code, output } = await f.run(["--env", "production", "--dry-run"]);

    expect(code).not.toBe(0);
    expect(output).toContain("ingress.host is empty");
  });

  it("refuses a --host that is really a URL, rather than pasting it into one", async () => {
    const f = fixture(REAL);
    const { code, output } = await f.run([
      "--env",
      "staging",
      "--host",
      `https://${REAL.staging}`,
      "--dry-run",
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain("which is a URL and not a hostname");
  });

  it("refuses a --url without a scheme, rather than guessing one", async () => {
    const f = fixture(REAL);
    const { code, output } = await f.run(["--env", "staging", "--url", REAL.staging, "--dry-run"]);

    expect(code).not.toBe(0);
    expect(output).toContain("which has no scheme");
  });

  it("refuses an HMAC secret id named twice", async () => {
    const f = fixture(REAL);
    const { code, output } = await f.run(
      ["--env", "staging", "--hmac-secret-id", "acme/webhook-hmac", "--dry-run"],
      { DRILL_HMAC_SECRET_ID_STAGING: "acme/other-webhook-hmac" },
    );

    expect(code).not.toBe(0);
    expect(output).toContain("named twice");
  });

  it("keeps a custom secret id that names no environment", async () => {
    const f = fixture(REAL);
    const { code, output } = await f.run([
      "--env",
      "staging",
      "--hmac-secret-id",
      "acme/webhook-hmac",
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(output).toContain("hmac   acme/webhook-hmac");
  });
});

describe("the URL curl parses is the URL the checks read", () => {
  // A fork that has deployed staging but not production: production's values
  // file still carries the placeholder, so neither the declared-host rule nor
  // anything else has a production hostname to compare against. All that stands
  // between a production-signed alert and the staging load balancer is the
  // cross-environment check reading the hostname curl will actually connect to.
  const halfDeployed = () => fixture({ staging: HOSTS.staging, production: "webhook.example.com" });

  it("reads the host after the userinfo, the way curl does", async () => {
    const f = halfDeployed();
    const before = deliveries.length;
    const { code, output } = await f.run([
      "--env",
      "production",
      "--url",
      `https://drill@${HOSTS.staging}`,
    ]);

    expect(deliveries.slice(before)).toHaveLength(0);
    expect(code).not.toBe(0);
    expect(output).toContain("refusing to fire");
    expect(output).not.toContain("[drill] HTTP ");
  });

  it("does not let a globbed URL address a host nothing checked", async () => {
    const f = halfDeployed();
    const before = deliveries.length;
    const { code, output } = await f.run([
      "--env",
      "production",
      "--url",
      `https://{${bareHost(HOSTS.staging)},nowhere.invalid}:${HOSTS.staging.split(":")[1]}`,
    ]);

    expect(deliveries.slice(before)).toHaveLength(0);
    expect(code).not.toBe(0);
    expect(output).toContain("which is not a hostname");
    expect(output).not.toContain("[drill] HTTP ");
  });
});

describe("--canonical-host", () => {
  // The comparison form the cross-environment rules use, and the primitive
  // .github/workflows/drill.yml compares with so the two cannot drift apart.
  const cases: Array<[string, string]> = [
    ["webhook.example-corp.io", "webhook.example-corp.io"],
    ["WEBHOOK.Example-Corp.IO", "webhook.example-corp.io"],
    ["webhook.example-corp.io.", "webhook.example-corp.io"],
    ["webhook.example-corp.io:8443", "webhook.example-corp.io"],
    ["https://webhook.example-corp.io", "webhook.example-corp.io"],
    ["http://webhook.example-corp.io:8443/webhook", "webhook.example-corp.io"],
    ["https://WEBHOOK.example-corp.io.:8443/webhook?x=1", "webhook.example-corp.io"],
    ["https://[::1]:8443/webhook", "[::1]"],
    ["127.0.0.1:19001", "127.0.0.1"],
    // curl splits userinfo on the last `@` and connects to what follows it.
    ["https://drill@webhook.example-corp.io/webhook", "webhook.example-corp.io"],
    ["https://user:pa@ss@webhook.example-corp.io:8443", "webhook.example-corp.io"],
    // The shipped placeholder is a stand-in, not an identity.
    ["example.com", ""],
    ["webhook.example.com", ""],
    ["https://webhook.example.com:8443/webhook", ""],
    ["", ""],
  ];

  it.each(cases)("%s -> %s", async (input, expected) => {
    const f = fixture({ staging: REAL.staging });
    const { code, stdout } = await f.run(["--canonical-host", input]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(expected);
  });
});
