/**
 * Behavioural tests for `scripts/fire-drill.sh`: where a drill's request
 * actually goes, and whose secret actually signed it.
 *
 * The invariant, stated once:
 *
 *   A payload signed for environment X reaches only environment X's webhook
 *   host, or nothing is sent at all.
 *
 * ── Two facts, kept apart ───────────────────────────────────────────────────
 *
 * The world and the configuration are separate things here, and that separation
 * is what makes this a test rather than a restatement.
 *
 * The **world** is four HTTPS listeners this file starts. Three are owned by an
 * environment — that ownership is ground truth, because this file created them —
 * and the fourth is owned by nobody and stands for an Ingress the chart does not
 * know about. Each listener records what arrived and which environment's secret
 * signed it, using the repository's own `verifyHmacSignature` and
 * `GrafanaOnCallPayloadSchema`, so "delivered" means a real request arrived and
 * "refused" means no listener saw anything.
 *
 * The **configuration** is what a case writes into the fixture: values files,
 * scoped variables, flags. Configuration is allowed to lie about the world —
 * that is precisely what a misfire is, and the shipped exploits below are
 * nothing but a variable naming another environment's host.
 *
 * So the primary assertion consults no oracle at all: whatever a case
 * configured, a `--env X` run may only ever be observed at the listener this
 * file owns for X, signed with X's secret. A resolver that agrees with a bug
 * cannot talk its way past that, because the check never reads the resolver's
 * inputs.
 *
 * Two secondary assertions need a specification, and it is derived from the
 * sources an environment's identity can come from — not from what the script
 * does with them:
 *
 *   fail closed  when a case leaves any environment's identity unestablishable,
 *                contradictory, or shared with another environment, the run must
 *                refuse and deliver nothing. This is the property the invariant
 *                rests on: a host nobody can name is a host nothing can be
 *                proved to miss.
 *   liveness     when a case establishes every identity and aims at the drilled
 *                environment's own host, a request must actually arrive. A suite
 *                of nothing but refusals would pass against a drill that never
 *                fires.
 *
 * `--check-target` is asserted against observed behaviour on every case: it is
 * the verdict `.github/workflows/drill.yml` runs on, so a disagreement between
 * it and the wire is a workflow that blesses a misfire or blocks a good drill.
 *
 * Fixture notes: the listeners are HTTPS, because a hostname resolves to an
 * `https` base URL and the drill has no insecure switch; the certificate is
 * generated per run and trusted through `CURL_CA_BUNDLE`. The four hostnames are
 * loopback spellings that resolve without DNS on every platform this suite runs
 * on — `127.0.0.1`, `localhost`, `[::1]` and `[0:0:0:0:0:0:0:1]` — each carrying
 * its listener's port, so two environments differ in hostname the way two real
 * deployments do.
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

// The listeners live in this process, so the drill has to be spawned without
// blocking the event loop — a synchronous spawn would deadlock against the
// listener it is talking to.
const execFileAsync = promisify(execFile);

type Env = "development" | "staging" | "production";
const ENVS: Env[] = ["development", "staging", "production"];

/** Somewhere a request can land. `drifted` belongs to no environment. */
type Place = Env | "drifted";
const PLACES: Place[] = [...ENVS, "drifted"];

const upper = (env: Env) => env.toUpperCase();
const secretIdOf = (env: Env) => `incident-response/${env}/grafana/oncall-webhook-hmac`;
const secretOf = (env: Env) => `hmac-secret-for-${env}`;

/** The placeholder this repository ships in every values file. */
const PLACEHOLDER = "incident-response-webhook.example.com";

// ── The world ───────────────────────────────────────────────────────────────

interface Site {
  /** The environment that owns this listener, or null for the unowned one. */
  owner: Env | null;
  /** Hostname as anything addressing it spells it, without the port. */
  host: string;
  /** Loopback address the listener binds. */
  bind: string;
  port: number;
  /** `host:port` — what a values file or a variable would carry. */
  hostPort: string;
}

const WORLD: Record<Place, Site> = {
  development: {
    owner: "development",
    host: "127.0.0.1",
    bind: "127.0.0.1",
    port: 0,
    hostPort: "",
  },
  staging: { owner: "staging", host: "localhost", bind: "127.0.0.1", port: 0, hostPort: "" },
  production: { owner: "production", host: "[::1]", bind: "::1", port: 0, hostPort: "" },
  drifted: { owner: null, host: "[0:0:0:0:0:0:0:1]", bind: "::1", port: 0, hostPort: "" },
};

/** The comparison form of a hostname: lower-cased, no port, no trailing dot. */
function canonical(hostPort: string): string {
  let v = hostPort.replace(/^[a-z]+:\/\//i, "");
  v = v.split("/")[0] ?? "";
  v = v.split("?")[0] ?? "";
  const at = v.lastIndexOf("@");
  if (at !== -1) v = v.slice(at + 1);
  v = v.startsWith("[") ? `${v.slice(0, v.indexOf("]"))}]` : (v.split(":")[0] ?? "");
  return v.replace(/\.$/, "").toLowerCase();
}

interface Delivery {
  place: Place;
  owner: Env | null;
  method: string;
  path: string;
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

function handlerFor(place: Place) {
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
        place,
        owner: WORLD[place].owner,
        method: req.method ?? "",
        path: req.url ?? "",
        signedFor,
        payloadEnvironment,
        schemaValid,
      });

      // Each environment's listener accepts only its own signature, the way the
      // webhook handler does. The unowned one belongs to whichever environment
      // the cluster serves it for, so any real signature is good enough there.
      const owner = WORLD[place].owner;
      const accepted = owner === null ? signedFor !== null : signedFor === owner;
      res.writeHead(accepted ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ listener: place }));
    });
  };
}

/** One throwaway repo root: the real script, the real base values, stub tools. */
function buildFixture(): void {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drill-wire-"));
  binDir = path.join(fixtureRoot, "bin");
  fs.mkdirSync(path.join(fixtureRoot, "scripts"));
  fs.mkdirSync(path.join(fixtureRoot, "chart"));
  fs.mkdirSync(binDir);
  fs.copyFileSync(SCRIPT, path.join(fixtureRoot, "scripts/fire-drill.sh"));

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
      "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
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
 * Run the drill in the fixture. The environment is built from scratch rather
 * than inherited: a DRILL_* variable set by whoever ran the suite deciding the
 * outcome is the exact class of bug under test.
 */
async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: fixtureRoot,
    // Trust the listeners' certificate, and nothing else.
    CURL_CA_BUNDLE: certPath,
    SSL_CERT_FILE: certPath,
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [path.join(fixtureRoot, "scripts/fire-drill.sh"), ...args],
      { env, encoding: "utf8" },
    );
    return { code: 0, stdout, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

// ── What a case says ────────────────────────────────────────────────────────

/** How a hostname can be spelled without changing which host it names. */
type Spelling = "asIs" | "upperCase" | "trailingDot" | "otherPort" | "userinfo";

/** A port nothing listens on, for showing that a port cannot hide a collision. */
const DEAD_PORT = "19999";

/** Spellings that survive a real connection — used where a case must deliver. */
const DELIVERABLE_SPELLINGS: Spelling[] = ["asIs"];
/** Every spelling — used where a case must refuse, so resolution never matters. */
const ALL_SPELLINGS: Spelling[] = ["asIs", "upperCase", "trailingDot", "otherPort", "userinfo"];

function spell(place: Place, spelling: Spelling): string {
  const { host, port } = WORLD[place];
  switch (spelling) {
    case "asIs":
      return `${host}:${port}`;
    case "upperCase":
      return `${host.toUpperCase()}:${port}`;
    case "trailingDot":
      return host.startsWith("[") ? `${host}:${port}` : `${host}.:${port}`;
    case "otherPort":
      return `${host}:${DEAD_PORT}`;
    // curl connects to what follows the last `@` and ignores what precedes it,
    // so userinfo is a way to spell a hostname that a naive check misreads. It
    // is only legal in a URL.
    case "userinfo":
      return `${host}:${port}`;
  }
}

/** One thing a source can say about an environment. */
type Claim =
  | { says: "nothing" }
  | { says: "placeholder" }
  | { says: "no-file" }
  | { says: "absent" }
  | { says: "host"; at: Place; spelling?: Spelling };

interface Sources {
  /** chart/values-<env>.yaml */
  values: Claim;
  /** DRILL_WEBHOOK_HOST_<ENV> */
  hostVar: Claim;
  /** DRILL_WEBHOOK_URL_<ENV> */
  urlVar: Claim;
}

const NOTHING: Claim = { says: "nothing" };
const truthful = (env: Env): Sources => ({
  values: { says: "host", at: env },
  hostVar: NOTHING,
  urlVar: NOTHING,
});
const shippedPlaceholder = (): Sources => ({
  values: { says: "placeholder" },
  hostVar: NOTHING,
  urlVar: NOTHING,
});

interface SecretChoice {
  via: "--hmac-secret-id" | "scoped-id-var" | "unscoped-id-var" | "scoped-value-var";
  of: Env;
}

interface Case {
  title: string;
  drillEnv: Env;
  sources: Record<Env, Sources>;
  /** chart/values.yaml ingress.host — the fallback Helm applies. */
  baseValues?: Claim;
  target?: { via: "--host" | "--url" | "--from-cluster"; at: Place; spelling: Spelling };
  secret?: SecretChoice;
  /** Unscoped DRILL_* variables, which apply to every --env. */
  unscoped?: Record<string, string>;
}

const allEnvs = (make: (env: Env) => Sources): Record<Env, Sources> => ({
  development: make("development"),
  staging: make("staging"),
  production: make("production"),
});

// ── The specification, read off the sources ─────────────────────────────────
//
// Identity is what an environment's sources establish about it, and it is the
// same question for every environment: the two scoped variables and the values
// file Helm renders that environment's Ingress from. Nothing here consults the
// script.

type Identity =
  | { state: "known"; host: string }
  | { state: "absent" }
  | { state: "unknown" }
  | { state: "conflict" };

function claimHost(claim: Claim, baseValues: Claim | undefined, isValues: boolean): Claim {
  if (isValues && (claim.says === "no-file" || claim.says === "nothing")) {
    return baseValues ?? { says: "nothing" };
  }
  return claim;
}

function identityOf(c: Case, env: Env): Identity {
  const s = c.sources[env];
  const ordered: Claim[] = [s.urlVar, s.hostVar, claimHost(s.values, c.baseValues, true)];

  let state: "unknown" | "known" | "absent" = "unknown";
  let host = "";
  for (const claim of ordered) {
    if (claim.says === "nothing" || claim.says === "placeholder" || claim.says === "no-file") {
      continue;
    }
    if (claim.says === "absent") {
      if (state === "known") return { state: "conflict" };
      state = "absent";
      continue;
    }
    const named = canonical(spell(claim.at, claim.spelling ?? "asIs"));
    if (state === "absent") return { state: "conflict" };
    if (state === "known" && host !== named) return { state: "conflict" };
    state = "known";
    host = named;
  }

  if (state === "known") return { state: "known", host };
  if (state === "absent") return { state: "absent" };
  return { state: "unknown" };
}

/**
 * Why a case must not put anything on the wire. Null means it must fire.
 *
 * Everything here is a statement about the sources a case declares, in the
 * terms the invariant needs: an identity that cannot be established, two
 * environments that cannot be told apart, and a destination that is not the
 * drilled environment's.
 */
function refusalReason(c: Case): string | null {
  if (c.unscoped && Object.keys(c.unscoped).length > 0) {
    return "an unscoped override applies to every --env";
  }

  const identities = new Map<Env, Identity>();
  for (const env of ENVS) identities.set(env, identityOf(c, env));

  for (const env of ENVS) {
    const id = identities.get(env) as Identity;
    if (id.state === "conflict") return `${env}'s sources contradict each other`;
  }
  for (const a of ENVS) {
    for (const b of ENVS) {
      if (a >= b) continue;
      const ia = identities.get(a) as Identity;
      const ib = identities.get(b) as Identity;
      if (ia.state === "known" && ib.state === "known" && ia.host === ib.host) {
        return `${a} and ${b} claim the same host`;
      }
    }
  }
  for (const env of ENVS) {
    const id = identities.get(env) as Identity;
    if (id.state === "unknown") return `${env} has no establishable host`;
  }

  const own = identities.get(c.drillEnv) as Identity;
  if (own.state === "absent") return `${c.drillEnv} is declared to have no host`;
  if (own.state !== "known") return `${c.drillEnv} has no establishable host`;

  if (c.secret && c.secret.via !== "scoped-value-var" && c.secret.of !== c.drillEnv) {
    return "the HMAC secret id names another environment's tree";
  }

  if (c.target) {
    const aimed = canonical(spell(c.target.at, c.target.spelling));
    if (c.target.via === "--from-cluster") {
      for (const env of ENVS) {
        if (env === c.drillEnv) continue;
        const id = identities.get(env) as Identity;
        if (id.state === "known" && id.host === aimed) {
          return `the live Ingress serves ${env}'s host`;
        }
      }
      return null;
    }
    if (aimed !== own.host) return "the named target is not the drilled environment's host";
  }

  return null;
}

/** Where a firing case must land, in world terms. */
function expectedPlace(c: Case): Place {
  if (c.target) return c.target.at;
  const own = identityOf(c, c.drillEnv);
  const host = own.state === "known" ? own.host : "";
  const place = PLACES.find((p) => canonical(WORLD[p].host) === host);
  if (place === undefined) throw new Error(`no listener owns '${host}' — case is not expressible`);
  return place;
}

// ── Materializing a case ────────────────────────────────────────────────────

function writeValues(c: Case): void {
  const base = fs.readFileSync(BASE_VALUES, "utf8");
  const baseClaim = c.baseValues;
  const baseHost =
    baseClaim === undefined || baseClaim.says !== "host"
      ? ""
      : spell(baseClaim.at, baseClaim.spelling ?? "asIs");
  fs.writeFileSync(
    path.join(fixtureRoot, "chart/values.yaml"),
    baseHost === "" ? base : base.replace(/^ {2}host: ''.*$/m, `  host: '${baseHost}'`),
  );

  for (const env of ENVS) {
    const file = path.join(fixtureRoot, `chart/values-${env}.yaml`);
    const claim = c.sources[env].values;
    if (claim.says === "no-file") {
      fs.rmSync(file, { force: true });
      continue;
    }
    let host = "";
    if (claim.says === "placeholder") host = PLACEHOLDER;
    if (claim.says === "host") host = spell(claim.at, claim.spelling ?? "asIs");
    if (claim.says === "absent") {
      throw new Error("a values file cannot declare an environment absent");
    }
    // Quoted, because an IPv6 literal with a port is a flow sequence to a YAML
    // parser and a hostname to everything else.
    fs.writeFileSync(file, `ingress:\n  host: '${host}'\n`);
  }
}

function materialize(c: Case): { args: string[]; env: Record<string, string> } {
  const args = ["--env", c.drillEnv];
  const env: Record<string, string> = { ...(c.unscoped ?? {}) };

  for (const e of ENVS) {
    const s = c.sources[e];
    if (s.hostVar.says === "absent") env[`DRILL_WEBHOOK_HOST_${upper(e)}`] = "none";
    if (s.hostVar.says === "host") {
      env[`DRILL_WEBHOOK_HOST_${upper(e)}`] = spell(s.hostVar.at, s.hostVar.spelling ?? "asIs");
    }
    if (s.urlVar.says === "absent") env[`DRILL_WEBHOOK_URL_${upper(e)}`] = "none";
    if (s.urlVar.says === "host") {
      env[`DRILL_WEBHOOK_URL_${upper(e)}`] =
        `https://${spell(s.urlVar.at, s.urlVar.spelling ?? "asIs")}`;
    }
  }

  if (c.target) {
    const spelled = spell(c.target.at, c.target.spelling);
    if (c.target.via === "--host") args.push("--host", spelled);
    if (c.target.via === "--url") {
      const userinfo = c.target.spelling === "userinfo" ? "drill@" : "";
      args.push("--url", `https://${userinfo}${spelled}`);
    }
    if (c.target.via === "--from-cluster") {
      args.push("--from-cluster");
      env.STUB_INGRESS_HOST = spelled;
    }
  }

  if (c.secret) {
    const { via, of } = c.secret;
    if (via === "--hmac-secret-id") args.push("--hmac-secret-id", secretIdOf(of));
    if (via === "scoped-id-var") env[`DRILL_HMAC_SECRET_ID_${upper(c.drillEnv)}`] = secretIdOf(of);
    if (via === "unscoped-id-var") env.DRILL_HMAC_SECRET_ID = secretIdOf(of);
    if (via === "scoped-value-var") env[`DRILL_HMAC_SECRET_${upper(c.drillEnv)}`] = secretOf(of);
  }

  return { args, env };
}

// ── The three assertions ────────────────────────────────────────────────────

async function assertCase(c: Case): Promise<void> {
  writeValues(c);
  const { args, env } = materialize(c);

  const before = deliveries.length;
  const result = await run(args, env);
  const fresh = deliveries.slice(before);
  const checked = await run([...args, "--check-target"], env);

  // 1. The invariant, against the world. No case, however configured, may put a
  //    request on a listener belonging to an environment other than the one it
  //    signed for. This reads only what arrived.
  for (const delivery of fresh) {
    const where = JSON.stringify(delivery);
    expect(delivery.owner === null || delivery.owner === c.drillEnv, where).toBe(true);
    expect(delivery.signedFor, where).toBe(c.drillEnv);
    expect(delivery.payloadEnvironment, where).toBe(c.drillEnv);
    expect(delivery.schemaValid, where).toBe(true);
    // An unowned listener is only reachable by asking for it explicitly.
    if (delivery.owner === null) expect(c.target?.via).toBe("--from-cluster");
  }

  const reason = refusalReason(c);

  if (reason !== null) {
    // 2. Fail closed: nothing on the wire, a non-zero exit, and a refusal that
    //    happened before any request rather than after one.
    expect(fresh, `${reason}: nothing may reach any listener — ${JSON.stringify(fresh)}`).toEqual(
      [],
    );
    expect(result.code, reason).not.toBe(0);
    expect(result.output).toContain("[drill] FAIL:");
    expect(result.output).not.toContain("[drill] HTTP ");
    expect(checked.code, `--check-target must agree: ${reason}`).not.toBe(0);
    return;
  }

  // 3. Liveness: a configured drill actually fires, exactly once, where the
  //    world says the drilled environment lives.
  expect(fresh, `expected exactly one request — ${JSON.stringify(fresh)}`).toHaveLength(1);
  const delivery = fresh[0] as Delivery;
  expect(delivery.place).toBe(expectedPlace(c));
  expect(delivery.method).toBe("POST");
  expect(delivery.path).toBe("/webhook/grafana-oncall");
  expect(result.code).toBe(0);
  expect(checked.code, "--check-target must agree that this fires").toBe(0);

  // `--print-host` has to name the host of the request that was actually made.
  const printed = await run([...args, "--print-host"], env);
  expect(printed.code).toBe(0);
  expect(printed.stdout.trim()).toBe(canonical(WORLD[delivery.place].host));
}

// ── Cases ───────────────────────────────────────────────────────────────────

const cases: Case[] = [];
const push = (c: Case) => cases.push(c);

// The state of a fresh clone: every values file carries the shipped
// placeholder, and nothing else names a host. Naming a target does not rescue
// it — an environment nobody can name is an environment nothing can be proved
// to miss.
for (const drillEnv of ENVS) {
  push({
    title: `fresh clone | --env ${drillEnv} | no target named`,
    drillEnv,
    sources: allEnvs(shippedPlaceholder),
  });
  for (const via of ["--host", "--url", "--from-cluster"] as const) {
    push({
      title: `fresh clone | --env ${drillEnv} | ${via} at its own host`,
      drillEnv,
      sources: allEnvs(shippedPlaceholder),
      target: { via, at: drillEnv, spelling: "asIs" },
    });
  }
}

// The exploits that shipped, in the two shapes that need no flags at all. Both
// are a scoped variable naming another environment's load balancer, which is
// exactly what a repository variable holding the wrong hostname looks like.
push({
  title: "exploit | DRILL_WEBHOOK_HOST_PRODUCTION names staging's host, nothing else set",
  drillEnv: "production",
  sources: {
    development: shippedPlaceholder(),
    staging: shippedPlaceholder(),
    production: {
      values: { says: "placeholder" },
      hostVar: { says: "host", at: "staging" },
      urlVar: NOTHING,
    },
  },
});
push({
  title: "exploit | DRILL_WEBHOOK_URL_PRODUCTION names staging's host, nothing else set",
  drillEnv: "production",
  sources: {
    development: shippedPlaceholder(),
    staging: shippedPlaceholder(),
    production: {
      values: { says: "placeholder" },
      hostVar: NOTHING,
      urlVar: { says: "host", at: "staging" },
    },
  },
});
push({
  title: "exploit | both scoped host variables name staging's host",
  drillEnv: "production",
  sources: {
    development: shippedPlaceholder(),
    staging: {
      values: { says: "placeholder" },
      hostVar: { says: "host", at: "staging" },
      urlVar: NOTHING,
    },
    production: {
      values: { says: "placeholder" },
      hostVar: { says: "host", at: "staging" },
      urlVar: NOTHING,
    },
  },
});
push({
  title: "exploit | every other environment named, production's variable still points at staging",
  drillEnv: "production",
  sources: {
    development: truthful("development"),
    staging: truthful("staging"),
    production: {
      values: { says: "placeholder" },
      hostVar: { says: "host", at: "staging" },
      urlVar: NOTHING,
    },
  },
});
push({
  title: "exploit | --host at staging while drilling production, everything named",
  drillEnv: "production",
  sources: allEnvs(truthful),
  target: { via: "--host", at: "staging", spelling: "asIs" },
});

// A fully named world: every way of naming a target, at every place, in every
// spelling. A drill fires at its own environment and refuses everywhere else,
// and no spelling of a foreign host changes which environment it belongs to.
for (const drillEnv of ENVS) {
  push({
    title: `named world | --env ${drillEnv} | values files decide`,
    drillEnv,
    sources: allEnvs(truthful),
  });

  for (const via of ["--host", "--url", "--from-cluster"] as const) {
    for (const at of PLACES) {
      // A case that has to reach a listener has to be spelled in a way that
      // resolves; one that has to refuse never opens a socket, so any spelling
      // will do — and a foreign host spelled five ways is the point.
      const delivers = at === drillEnv || (at === "drifted" && via === "--from-cluster");
      const spellings = delivers ? DELIVERABLE_SPELLINGS : ALL_SPELLINGS;
      for (const spelling of spellings) {
        if (spelling === "userinfo" && via !== "--url") continue;
        if (at === "drifted" && !delivers && spelling !== "asIs") continue;
        push({
          title: `named world | --env ${drillEnv} | ${via} at ${at} (${spelling})`,
          drillEnv,
          sources: allEnvs(truthful),
          target: { via, at, spelling },
        });
      }
    }
  }
}

// Identity from each source in turn, and from sources that disagree.
for (const drillEnv of ENVS) {
  push({
    title: `identity | --env ${drillEnv} | every host from DRILL_WEBHOOK_HOST_<ENV>`,
    drillEnv,
    sources: allEnvs((env) => ({
      values: { says: "placeholder" },
      hostVar: { says: "host", at: env },
      urlVar: NOTHING,
    })),
  });
  push({
    title: `identity | --env ${drillEnv} | every host from DRILL_WEBHOOK_URL_<ENV>`,
    drillEnv,
    sources: allEnvs((env) => ({
      values: { says: "placeholder" },
      hostVar: NOTHING,
      urlVar: { says: "host", at: env },
    })),
  });
  push({
    title: `identity | --env ${drillEnv} | one source each: values, host variable, URL variable`,
    drillEnv,
    sources: {
      development: truthful("development"),
      staging: {
        values: { says: "placeholder" },
        hostVar: { says: "host", at: "staging" },
        urlVar: NOTHING,
      },
      production: {
        values: { says: "placeholder" },
        hostVar: NOTHING,
        urlVar: { says: "host", at: "production" },
      },
    },
  });
  push({
    title: `identity | --env ${drillEnv} | variable agrees with the values file`,
    drillEnv,
    sources: allEnvs((env) => ({
      values: { says: "host", at: env },
      hostVar: { says: "host", at: env },
      urlVar: NOTHING,
    })),
  });
  push({
    title: `identity | --env ${drillEnv} | variable contradicts the values file`,
    drillEnv,
    sources: allEnvs((env) => ({
      values: { says: "host", at: env },
      hostVar: { says: "host", at: env === "staging" ? "production" : "staging" },
      urlVar: NOTHING,
    })),
  });
  push({
    title: `identity | --env ${drillEnv} | the two variables contradict each other`,
    drillEnv,
    sources: {
      ...allEnvs(truthful),
      staging: {
        values: { says: "placeholder" },
        hostVar: { says: "host", at: "staging" },
        urlVar: { says: "host", at: "drifted" },
      },
    },
  });
  push({
    title: `identity | --env ${drillEnv} | a variable says absent while the values file names a host`,
    drillEnv,
    sources: {
      ...allEnvs(truthful),
      development: {
        values: { says: "host", at: "development" },
        hostVar: { says: "absent" },
        urlVar: NOTHING,
      },
    },
  });
  push({
    title: `identity | --env ${drillEnv} | values file with no host at all`,
    drillEnv,
    sources: {
      ...allEnvs(truthful),
      development: { values: { says: "no-file" }, hostVar: NOTHING, urlVar: NOTHING },
    },
  });
}

// chart/values.yaml is the fallback Helm applies, so it is the fallback here —
// and two environments inheriting one host from it is two environments that
// cannot be told apart.
push({
  title: "base values | one environment inherits ingress.host from chart/values.yaml",
  drillEnv: "production",
  sources: {
    development: truthful("development"),
    staging: truthful("staging"),
    production: { values: { says: "no-file" }, hostVar: NOTHING, urlVar: NOTHING },
  },
  baseValues: { says: "host", at: "production" },
});
push({
  title: "base values | two environments inherit the same host from chart/values.yaml",
  drillEnv: "production",
  sources: {
    development: truthful("development"),
    staging: { values: { says: "no-file" }, hostVar: NOTHING, urlVar: NOTHING },
    production: { values: { says: "no-file" }, hostVar: NOTHING, urlVar: NOTHING },
  },
  baseValues: { says: "host", at: "production" },
});

// An environment with no webhook deployment is declared, not omitted. The
// declaration is a claim about a host that does not exist, so it collides with
// nothing — and drilling the environment that made it has nowhere to go.
for (const absent of ENVS) {
  for (const drillEnv of ENVS) {
    push({
      title: `absent | ${absent} declared to have no deployment | --env ${drillEnv}`,
      drillEnv,
      sources: {
        ...allEnvs(truthful),
        [absent]: { values: { says: "placeholder" }, hostVar: { says: "absent" }, urlVar: NOTHING },
      } as Record<Env, Sources>,
    });
  }
}

// One environment degraded while another is drilled: the fail-closed matrix.
// Every one of these leaves the drilled environment perfectly well named, and
// every one of them still has to refuse.
for (const drillEnv of ENVS) {
  for (const degraded of ENVS) {
    if (degraded === drillEnv) continue;
    push({
      title: `fail closed | --env ${drillEnv} | ${degraded} left on the placeholder`,
      drillEnv,
      sources: { ...allEnvs(truthful), [degraded]: shippedPlaceholder() } as Record<Env, Sources>,
    });
    push({
      title: `fail closed | --env ${drillEnv} | ${degraded} has no values file and no variable`,
      drillEnv,
      sources: {
        ...allEnvs(truthful),
        [degraded]: { values: { says: "no-file" }, hostVar: NOTHING, urlVar: NOTHING },
      } as Record<Env, Sources>,
    });
    push({
      title: `fail closed | --env ${drillEnv} | ${degraded} claims the ${drillEnv} host`,
      drillEnv,
      sources: {
        ...allEnvs(truthful),
        [degraded]: {
          values: { says: "placeholder" },
          hostVar: { says: "host", at: drillEnv },
          urlVar: NOTHING,
        },
      } as Record<Env, Sources>,
    });
  }
}

// The signing identity, crossed with a named world. A secret id that names
// another environment's tree is the same misfire read backwards.
for (const drillEnv of ENVS) {
  for (const via of ["--hmac-secret-id", "scoped-id-var", "unscoped-id-var"] as const) {
    for (const of of ENVS) {
      push({
        title: `secret | --env ${drillEnv} | ${via} names ${of}`,
        drillEnv,
        sources: allEnvs(truthful),
        secret: { via, of },
        ...(via === "unscoped-id-var"
          ? { unscoped: { DRILL_HMAC_SECRET_ID: secretIdOf(of) } }
          : {}),
      });
    }
  }
  // A pasted secret value carries no environment to check — it is the caller's
  // own assertion, and nothing in a checkout can contradict it. So it is only
  // ever paired with its own environment.
  push({
    title: `secret | --env ${drillEnv} | DRILL_HMAC_SECRET_<ENV> holds its own secret`,
    drillEnv,
    sources: allEnvs(truthful),
    secret: { via: "scoped-value-var", of: drillEnv },
  });
}

// An unscoped variable applies to every --env, which is one environment's
// signature delivered to another's load balancer waiting to happen.
for (const drillEnv of ENVS) {
  for (const name of ["DRILL_WEBHOOK_HOST", "DRILL_WEBHOOK_URL", "DRILL_HMAC_SECRET"] as const) {
    push({
      title: `unscoped | --env ${drillEnv} | ${name} is set`,
      drillEnv,
      sources: allEnvs(truthful),
      unscoped: {
        [name]:
          name === "DRILL_WEBHOOK_URL"
            ? `https://${spell(drillEnv, "asIs")}`
            : name === "DRILL_WEBHOOK_HOST"
              ? spell(drillEnv, "asIs")
              : secretOf(drillEnv),
      },
    });
  }
}

// ── The suite ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  buildFixture();
  const key = fs.readFileSync(path.join(fixtureRoot, "stub-key.pem"));
  const cert = fs.readFileSync(certPath);
  for (const place of PLACES) {
    const site = WORLD[place];
    const server = https.createServer({ key, cert }, handlerFor(place));
    await new Promise<void>((resolve) => server.listen(0, site.bind, resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listener has no port");
    site.port = address.port;
    site.hostPort = `${site.host}:${address.port}`;
    servers.push(server);
  }
});

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("fire-drill.sh delivers only where it signs for", () => {
  it("holds a matrix that both fires and refuses", () => {
    const firing = cases.filter((c) => refusalReason(c) === null);
    const refusing = cases.filter((c) => refusalReason(c) !== null);
    // A matrix of nothing but refusals would pass against a drill that never
    // fires at all, and one of nothing but firings would prove no safety.
    expect(firing.length).toBeGreaterThan(20);
    expect(refusing.length).toBeGreaterThan(50);
    // The shipped state of this repository is a refusal, and so is every shape
    // of the exploit.
    for (const c of cases.filter((x) => x.title.startsWith("fresh clone"))) {
      expect(refusalReason(c), c.title).not.toBeNull();
    }
    for (const c of cases.filter((x) => x.title.startsWith("exploit"))) {
      expect(refusalReason(c), c.title).not.toBeNull();
    }
  });

  it.each(cases)("$title", async (c) => {
    await assertCase(c);
  });
});

describe("what an absence declaration costs", () => {
  // `none` is the one claim a checkout cannot check: a hostname can be compared
  // against another hostname, "there is no host here" cannot be compared against
  // anything. An operator who declares an environment absent *and* names that
  // environment's real host as another environment's gets a delivery, and the
  // drill says so on the way out rather than pretending otherwise.
  it("says out loud that nothing held the request against the absent environment", async () => {
    const c: Case = {
      title: "absence declared, and believed",
      drillEnv: "production",
      sources: {
        development: truthful("development"),
        staging: { values: { says: "placeholder" }, hostVar: { says: "absent" }, urlVar: NOTHING },
        production: truthful("production"),
      },
    };
    writeValues(c);
    const { args, env } = materialize(c);
    const before = deliveries.length;
    const { code, output } = await run(args, env);

    expect(code).toBe(0);
    expect(deliveries.slice(before)).toHaveLength(1);
    expect(output).toContain("WARNING: staging is declared to have no webhook deployment");
    expect(output).toContain("this is the one place the drill takes the operator's word");
  });
});

describe("what the drill says when it refuses", () => {
  // A refusal is only useful if it names what to change, so the map goes out
  // with it.
  it("prints the identity map and what to configure on a fresh clone", async () => {
    const c: Case = {
      title: "fresh clone",
      drillEnv: "staging",
      sources: allEnvs(shippedPlaceholder),
    };
    writeValues(c);
    const { args, env } = materialize(c);
    const { code, output } = await run(args, env);

    expect(code).not.toBe(0);
    expect(output).toContain("environment identities:");
    expect(output).toContain("UNKNOWN");
    expect(output).toContain(PLACEHOLDER);
    // The drilled environment is the one named first: "I do not know where you
    // are firing" is plainer than "I cannot rule out somewhere else".
    expect(output).toContain("nothing establishes a webhook host for staging");
    expect(output).toContain("DRILL_WEBHOOK_HOST_STAGING=none");
  });

  it("names both environments when two claim one host", async () => {
    const c: Case = {
      title: "collision",
      drillEnv: "production",
      sources: {
        development: truthful("development"),
        staging: truthful("staging"),
        production: {
          values: { says: "placeholder" },
          hostVar: { says: "host", at: "staging" },
          urlVar: NOTHING,
        },
      },
    };
    writeValues(c);
    const { args, env } = materialize(c);
    const { code, output } = await run(args, env);

    expect(code).not.toBe(0);
    expect(output).toContain("staging and production both claim the webhook host");
  });

  it("refuses a --host that is really a URL, rather than pasting it into one", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run([
      "--env",
      "staging",
      "--host",
      `https://${WORLD.staging.hostPort}`,
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain("which is a URL and not a hostname");
  });

  it("refuses a --url without a scheme, rather than guessing one", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run(["--env", "staging", "--url", WORLD.staging.hostPort]);

    expect(code).not.toBe(0);
    expect(output).toContain("which has no scheme");
  });

  it("refuses a target named twice", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run([
      "--env",
      "staging",
      "--host",
      WORLD.staging.hostPort,
      "--url",
      `https://${WORLD.staging.hostPort}`,
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain("named 2 times");
  });

  it("refuses an HMAC secret id named twice", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run(
      ["--env", "staging", "--hmac-secret-id", "acme/webhook-hmac", "--check-target"],
      { DRILL_HMAC_SECRET_ID_STAGING: "acme/other-webhook-hmac" },
    );

    expect(code).not.toBe(0);
    expect(output).toContain("named twice");
  });

  it("keeps a custom secret id that names no environment", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run([
      "--env",
      "staging",
      "--hmac-secret-id",
      "acme/webhook-hmac",
      "--check-target",
    ]);

    expect(code).toBe(0);
    expect(output).toContain("hmac   acme/webhook-hmac");
  });

  it("refuses a variable that names the shipped placeholder", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const { code, output } = await run(["--env", "staging", "--check-target"], {
      DRILL_WEBHOOK_HOST_DEVELOPMENT: PLACEHOLDER,
    });

    expect(code).not.toBe(0);
    expect(output).toContain("the placeholder this repository ships");
  });
});

describe("the URL curl parses is the URL the checks read", () => {
  it("does not let a globbed URL address a host nothing checked", async () => {
    writeValues({ title: "", drillEnv: "production", sources: allEnvs(truthful) });
    const before = deliveries.length;
    const { code, output } = await run([
      "--env",
      "production",
      "--url",
      `https://{${WORLD.staging.host},nowhere.invalid}:${WORLD.staging.port}`,
    ]);

    expect(deliveries.slice(before)).toHaveLength(0);
    expect(code).not.toBe(0);
    expect(output).toContain("not a hostname");
    expect(output).not.toContain("[drill] HTTP ");
  });
});

describe("--check-target is the whole verdict", () => {
  // .github/workflows/drill.yml runs this and nothing else. It has to print the
  // map, the request and the secret, so a failed run says what to fix without a
  // second reading of the configuration anywhere.
  it("prints the map, the target and the secret when a drill would fire", async () => {
    writeValues({ title: "", drillEnv: "production", sources: allEnvs(truthful) });
    const { code, stdout } = await run(["--env", "production", "--check-target"]);

    expect(code).toBe(0);
    expect(stdout).toContain("environment identities:");
    expect(stdout).toContain(canonical(WORLD.staging.host));
    expect(stdout).toContain(canonical(WORLD.production.host));
    expect(stdout).toContain("production drills");
    expect(stdout).toContain("incident-response/production/grafana/oncall-webhook-hmac");
  });

  it("needs no aws CLI, no cluster and no payload tooling", async () => {
    writeValues({ title: "", drillEnv: "staging", sources: allEnvs(truthful) });
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "drill-nobin-"));
    try {
      const { stdout } = await execFileAsync(
        "bash",
        [path.join(fixtureRoot, "scripts/fire-drill.sh"), "--env", "staging", "--check-target"],
        {
          env: { PATH: `${emptyBin}:/usr/bin:/bin`, HOME: fixtureRoot },
          encoding: "utf8",
        },
      );
      expect(stdout).toContain("staging drills");
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});
