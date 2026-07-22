#!/usr/bin/env node
/**
 * Validate platform.yaml against the eks-agent-platform CRD schemas.
 *
 * Four layers:
 *
 *   0. Integrity. Every schema under schemas/crd/ is hashed and matched against
 *      the SHA-256 recorded in schemas/crd/source.json before it is parsed.
 *      A vendored schema is a copy of upstream, never a source, so an edit to
 *      one — widening an enum, dropping a `required` — is not a change to
 *      review, it is a gate quietly told to accept more. Any mismatch, missing
 *      file, or undeclared extra schema aborts the run. (The complementary
 *      half, for an edit that updates the digest too, is
 *      `scripts/sync-crd-schemas.mjs --check`, which compares against upstream
 *      at the pinned commit in CI.)
 *
 *   1. Schema. Every document is walked against the vendored `openAPIV3Schema`
 *      for its apiVersion + kind. `controller-gen` does not emit
 *      `additionalProperties: false`, so a stock JSON Schema validator happily
 *      accepts an invented field — this walker rejects any property the CRD
 *      does not declare, in addition to the usual required / type / enum /
 *      pattern / bounds checks.
 *
 *   2. Scope. `Tenant` is cluster-scoped and must carry no
 *      `metadata.namespace`; `Platform` and `BudgetPolicy` are namespaced and
 *      must carry one.
 *
 *   3. Wiring. The references that only mean something when read together:
 *      `Platform.spec.tenant` == `Tenant.metadata.name`, the BudgetPolicy
 *      round-trip, and the `agents.tenant` / `agents.platform` OTel resource
 *      attributes in every chart values file.
 *
 * The schemas are read from schemas/crd/ in this working tree — never fetched.
 * If any declared schema is missing or unreadable the run aborts non-zero
 * rather than validating against a partial picture.
 *
 * `--self-test` breaks copies of the committed manifest and of a vendored
 * schema in memory and asserts each break is caught, then asserts the untouched
 * inputs pass. It is the answer to "is this gate actually load-bearing, or has
 * it degenerated into a no-op that prints a checkmark?" — asked on every CI run
 * rather than once by hand.
 *
 * Usage:
 *   node scripts/validate-platform-manifests.mjs [manifest]
 *   node scripts/validate-platform-manifests.mjs --self-test
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const SOURCE_MANIFEST = join(SCHEMA_DIR, "source.json");
const CHART_DIR = join(REPO_ROOT, "chart");

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const manifestArg = args.find((a) => !a.startsWith("--"));
const MANIFEST_PATH = resolve(manifestArg ?? join(REPO_ROOT, "platform.yaml"));

/** Repo-relative when the file lives in the tree, absolute otherwise. */
const MANIFEST_LABEL = (() => {
  const rel = relative(REPO_ROOT, MANIFEST_PATH);
  return rel.startsWith("..") ? MANIFEST_PATH : rel;
})();

const errors = [];
const record = (where, message) => errors.push(`${where}: ${message}`);

/** Abort immediately — used only for "the gate cannot do its job" conditions. */
function abort(message, remedy) {
  console.error(`\n  ✗ cannot validate: ${message}`);
  if (remedy) console.error(`    ${remedy}`);
  console.error("");
  process.exit(1);
}

// ─────────────────────────── schema integrity ───────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function loadSourceManifest() {
  if (!existsSync(SOURCE_MANIFEST)) {
    abort(
      `schemas/crd/source.json is missing`,
      "The vendored CRD schemas and the manifest that pins them travel together; see schemas/crd/README.md.",
    );
  }

  let source;
  try {
    source = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8"));
  } catch (err) {
    abort(`schemas/crd/source.json is not valid JSON — ${err.message}`);
  }
  if (!source.upstream?.repository || !/^[0-9a-f]{40}$/.test(source.upstream?.ref ?? "")) {
    abort(
      "schemas/crd/source.json needs `upstream.repository` and a full 40-character `upstream.ref`",
      "A branch name pins nothing, and the digests below describe whatever commit that is.",
    );
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    abort("schemas/crd/source.json declares no schema files");
  }
  return source;
}

/**
 * Compare each declared schema's bytes against its recorded SHA-256, and refuse
 * any schema in the directory that source.json does not declare — otherwise
 * a fourth CRD could be dropped in and picked up unrecorded.
 *
 * Split out from the reading so the self-test can drive it over doctored bytes
 * without touching the working tree. `read(file)` returns a Buffer or null.
 */
function digestFailures(source, read) {
  const failures = [];
  const declared = new Set();

  for (const entry of source.files) {
    const { file, sha256: expected } = entry;
    declared.add(file);

    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      failures.push(`schemas/crd/source.json records no usable sha256 for ${file}`);
      continue;
    }
    const bytes = read(file);
    if (bytes === null) {
      failures.push(`${file} is declared in schemas/crd/source.json but not present`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== expected) {
      failures.push(
        `schemas/crd/${file} does not match its recorded digest — ` +
          `sha256 ${actual.slice(0, 16)}…, source.json says ${expected.slice(0, 16)}…`,
      );
    }
  }

  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".yaml")) continue;
    if (!declared.has(file)) {
      failures.push(`schemas/crd/${file} is present but not declared in source.json`);
    }
  }

  return failures;
}

// ─────────────────────────── schema loading ───────────────────────────

function loadSchemas() {
  const source = loadSourceManifest();

  const readSchema = (file) => {
    const path = join(SCHEMA_DIR, file);
    return existsSync(path) ? readFileSync(path) : null;
  };

  const integrity = digestFailures(source, readSchema);
  if (integrity.length > 0) {
    console.error("\n  ✗ cannot validate: the vendored CRD schemas failed their integrity check:");
    for (const failure of integrity) console.error(`      - ${failure}`);
    console.error(
      "\n    These files are copies of controller-gen output in " +
        `${source.upstream.repository} — never edit them here.\n` +
        "    Fix upstream, then re-vendor:\n" +
        "      EKS_AGENT_PLATFORM_DIR=<checkout> npm run schemas:sync\n",
    );
    process.exit(1);
  }

  /** @type {Map<string, { kind: string, scope: string, schema: object, file: string }>} */
  const index = new Map();

  for (const { file } of source.files) {
    let crd;
    try {
      crd = parseYaml(readSchema(file).toString("utf8"));
    } catch (err) {
      abort(`schemas/crd/${file} is not parseable YAML — ${err.message}`);
    }
    if (crd?.kind !== "CustomResourceDefinition" || !crd?.spec?.versions) {
      abort(`schemas/crd/${file} is not a CustomResourceDefinition`);
    }

    const { group, names, scope, versions } = crd.spec;
    for (const version of versions) {
      const schema = version?.schema?.openAPIV3Schema;
      if (!schema) {
        abort(`schemas/crd/${file} version ${version?.name} carries no openAPIV3Schema`);
      }
      index.set(`${group}/${version.name}/${names.kind}`, {
        kind: names.kind,
        scope,
        schema,
        file,
      });
    }
  }

  return { source, index, readSchema };
}

// ─────────────────────────── the strict walker ───────────────────────────

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Walk `value` against an OpenAPI v3 `schema`, recording every deviation.
 * Unknown properties are errors: controller-gen omits
 * `additionalProperties: false`, so this is the only layer that catches a
 * typo'd or invented field before it reaches a cluster.
 */
function walk(value, schema, path, ctx) {
  if (schema["x-kubernetes-preserve-unknown-fields"]) return;

  const type = schema.type;

  if (type === "object") {
    if (typeName(value) !== "object") {
      record(ctx, `${path} should be an object, got ${typeName(value)}`);
      return;
    }
    for (const required of schema.required ?? []) {
      if (!(required in value)) {
        record(ctx, `${path}.${required} is required by the CRD schema but missing`);
      }
    }

    const properties = schema.properties;
    const additional = schema.additionalProperties;

    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties?.[key];
      if (childSchema) {
        walk(child, childSchema, `${path}.${key}`, ctx);
      } else if (additional && typeof additional === "object") {
        walk(child, additional, `${path}.${key}`, ctx);
      } else if (additional === true || !properties) {
        // Schema deliberately leaves this object open (e.g. `metadata`).
      } else {
        const known = Object.keys(properties).sort().join(", ");
        record(ctx, `${path}.${key} is not a field the CRD schema declares (known: ${known})`);
      }
    }
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      record(ctx, `${path} should be an array, got ${typeName(value)}`);
      return;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      record(ctx, `${path} needs at least ${schema.minItems} item(s), has ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        walk(item, schema.items, `${path}[${i}]`, ctx);
      });
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string") {
      record(ctx, `${path} should be a string, got ${typeName(value)}`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      record(ctx, `${path} is "${value}", not one of: ${schema.enum.join(", ")}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      record(ctx, `${path} is "${value}", which does not match ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      record(ctx, `${path} is shorter than the schema minimum of ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      record(ctx, `${path} is longer than the schema maximum of ${schema.maxLength}`);
    }
    return;
  }

  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      record(
        ctx,
        `${path} should be ${type === "integer" ? "an integer" : "a number"}, got ${typeName(value)}`,
      );
      return;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      record(ctx, `${path} is ${value}, below the schema minimum of ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      record(ctx, `${path} is ${value}, above the schema maximum of ${schema.maximum}`);
    }
    return;
  }

  if (type === "boolean" && typeof value !== "boolean") {
    record(ctx, `${path} should be a boolean, got ${typeName(value)}`);
  }
}

// ─────────────────────────── document validation ───────────────────────────

const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function validateDocument(doc, position, index) {
  const where = `doc ${position}`;

  if (typeName(doc) !== "object") {
    record(where, `document is ${typeName(doc)}, not a Kubernetes object`);
    return null;
  }
  const { apiVersion, kind } = doc;
  if (typeof apiVersion !== "string" || typeof kind !== "string") {
    record(where, "document is missing apiVersion or kind");
    return null;
  }

  const entry = index.get(`${apiVersion}/${kind}`);
  if (!entry) {
    record(
      where,
      `no vendored CRD schema for ${apiVersion} ${kind} — ` +
        `known: ${[...index.keys()].sort().join(", ")}`,
    );
    return null;
  }

  const ctx = `${kind}/${doc.metadata?.name ?? "<unnamed>"}`;

  walk(doc, entry.schema, kind, ctx);

  const name = doc.metadata?.name;
  if (typeof name !== "string" || name.length === 0) {
    record(ctx, "metadata.name is missing");
  } else if (!DNS_1123_SUBDOMAIN.test(name)) {
    record(ctx, `metadata.name "${name}" is not a DNS-1123 subdomain`);
  }

  const namespace = doc.metadata?.namespace;
  if (entry.scope === "Cluster" && namespace !== undefined) {
    record(
      ctx,
      `${kind} is cluster-scoped (${entry.file}) but the manifest sets ` +
        `metadata.namespace: ${namespace}`,
    );
  }
  if (entry.scope === "Namespaced" && (typeof namespace !== "string" || namespace.length === 0)) {
    record(
      ctx,
      `${kind} is namespaced (${entry.file}) but the manifest sets no metadata.namespace`,
    );
  }

  return { kind, doc, ctx };
}

// ─────────────────────────── cross-document wiring ───────────────────────────

function validateWiring(docs) {
  const manifestName = MANIFEST_LABEL;
  const byKind = (kind) => docs.filter((d) => d.kind === kind);

  const tenants = byKind("Tenant");
  const platforms = byKind("Platform");
  const budgets = byKind("BudgetPolicy");

  if (tenants.length === 0) record(manifestName, "declares no Tenant");
  if (platforms.length === 0) record(manifestName, "declares no Platform");

  const tenantNames = new Set(tenants.map((t) => t.doc.metadata?.name).filter(Boolean));

  for (const t of tenants) {
    const label = t.doc.metadata?.labels?.["agents.nanohype.dev/tenant"];
    if (label !== undefined && label !== t.doc.metadata?.name) {
      record(
        t.ctx,
        `label agents.nanohype.dev/tenant is "${label}" but metadata.name is ` +
          `"${t.doc.metadata?.name}"`,
      );
    }
  }

  for (const p of platforms) {
    const ref = p.doc.spec?.tenant;
    if (ref !== undefined && !tenantNames.has(ref)) {
      record(
        p.ctx,
        `spec.tenant is "${ref}" but the only Tenant declared here is ` +
          `${[...tenantNames].map((n) => `"${n}"`).join(", ") || "<none>"}`,
      );
    }

    const budgetName = p.doc.spec?.budget?.name;
    const budget = budgets.find(
      (b) =>
        b.doc.metadata?.name === budgetName &&
        b.doc.metadata?.namespace === p.doc.metadata?.namespace,
    );
    if (budgetName !== undefined && !budget) {
      record(
        p.ctx,
        `spec.budget.name is "${budgetName}" but no BudgetPolicy by that name exists in ` +
          `namespace "${p.doc.metadata?.namespace}"`,
      );
    }
  }

  for (const b of budgets) {
    const ref = b.doc.spec?.platformRef?.name;
    const platform = platforms.find(
      (p) =>
        p.doc.metadata?.name === ref && p.doc.metadata?.namespace === b.doc.metadata?.namespace,
    );
    if (ref !== undefined && !platform) {
      record(
        b.ctx,
        `spec.platformRef.name is "${ref}" but no Platform by that name exists in ` +
          `namespace "${b.doc.metadata?.namespace}"`,
      );
    }
  }

  return {
    tenantName: tenants[0]?.doc?.metadata?.name,
    platformName: platforms[0]?.doc?.metadata?.name,
  };
}

// ─────────────────────────── chart values wiring ───────────────────────────

function parseResourceAttributes(raw) {
  const out = {};
  for (const pair of String(raw).split(",")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

function validateChartValues({ tenantName, platformName }) {
  if (!existsSync(CHART_DIR)) return 0;

  const files = readdirSync(CHART_DIR)
    .filter((f) => f === "values.yaml" || (f.startsWith("values-") && f.endsWith(".yaml")))
    .sort();

  if (files.length === 0) {
    abort(
      "no chart values files found under chart/",
      "The OTel tenant-attribute check has nothing to compare against.",
    );
  }

  const expected = { "agents.tenant": tenantName, "agents.platform": platformName };

  for (const file of files) {
    const where = `chart/${file}`;
    const values = parseYaml(readFileSync(join(CHART_DIR, file), "utf8")) ?? {};

    const raw = values?.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (raw !== undefined) {
      const attrs = parseResourceAttributes(raw);
      for (const [key, want] of Object.entries(expected)) {
        if (want === undefined) continue;
        if (!(key in attrs)) {
          record(where, `env.OTEL_RESOURCE_ATTRIBUTES does not carry ${key}`);
        } else if (attrs[key] !== want) {
          record(
            where,
            `env.OTEL_RESOURCE_ATTRIBUTES sets ${key}=${attrs[key]}, but platform.yaml ` +
              `declares ${want}`,
          );
        }
      }
    }

    const declared = values?.otel?.resourceAttributes;
    if (declared && typeof declared === "object") {
      for (const [key, want] of Object.entries(expected)) {
        if (want === undefined || !(key in declared)) continue;
        if (declared[key] !== want) {
          record(
            where,
            `otel.resourceAttributes.${key} is ${declared[key]}, but platform.yaml ` +
              `declares ${want}`,
          );
        }
      }
    }
  }

  return files.length;
}

// ─────────────────────────── the gate, as a function ───────────────────────────

/**
 * Run every check over already-parsed documents and return the problems found.
 * Repeatable — the self-test calls it once per mutation — so the module-level
 * error list is reset on entry rather than accumulated across runs.
 *
 * @param {unknown[]} rawDocuments plain JS objects, one per YAML document
 * @returns {{ errors: string[], docs: object[], chartFileCount: number }}
 */
function gate(rawDocuments, index) {
  errors.length = 0;

  const docs = [];
  let position = 0;
  for (const value of rawDocuments) {
    position += 1;
    if (value === null || value === undefined) continue; // trailing `---`
    const validated = validateDocument(value, position, index);
    if (validated) docs.push(validated);
  }

  const names = validateWiring(docs);
  const chartFileCount = validateChartValues(names);

  return { errors: [...errors], docs, chartFileCount };
}

function parseManifest(path, label) {
  if (!existsSync(path)) abort(`${path} does not exist`);

  const parsed = parseAllDocuments(readFileSync(path, "utf8"));
  const documents = [];
  let position = 0;
  for (const document of parsed) {
    position += 1;
    if (document.errors.length > 0) {
      abort(
        `${label} doc ${position} is not valid YAML — ${document.errors[0].message}`,
        "Fix the syntax before the schema layer can say anything useful.",
      );
    }
    const value = document.toJS();
    if (value !== null) documents.push(value);
  }
  if (documents.length === 0) abort(`${label} contains no Kubernetes documents`);
  return documents;
}

// ─────────────────────────── self-test ───────────────────────────

/**
 * Break the committed inputs five ways in memory and assert each break is
 * rejected, then assert the untouched inputs are accepted. Nothing is written.
 *
 * Four cases cover the manifest layers; the fifth covers schema integrity,
 * because a gate that trusts a doctored schema is the failure mode that looks
 * most like success.
 */
function selfTest(documents, index, source, readSchema) {
  const clone = () => JSON.parse(JSON.stringify(documents));
  const find = (docs, kind) => docs.find((d) => d.kind === kind);

  const cases = [
    {
      name: "a field the CRD does not declare, on Tenant.spec",
      run: () => {
        const docs = clone();
        find(docs, "Tenant").spec.aggregateMonthlyBudget = "5000";
        return gate(docs, index).errors;
      },
      expect: /is not a field the CRD schema declares/,
    },
    {
      name: "a required field removed from Platform.spec",
      run: () => {
        const docs = clone();
        delete find(docs, "Platform").spec.budget;
        return gate(docs, index).errors;
      },
      expect: /budget is required by the CRD schema but missing/,
    },
    {
      name: "Platform.spec.tenant naming a Tenant that is not declared",
      run: () => {
        const docs = clone();
        find(docs, "Platform").spec.tenant = "marketing";
        return gate(docs, index).errors;
      },
      expect: /spec\.tenant is "marketing"/,
    },
    {
      name: "metadata.namespace set on the cluster-scoped Tenant",
      run: () => {
        const docs = clone();
        find(docs, "Tenant").metadata.namespace = "tenants-reliability";
        return gate(docs, index).errors;
      },
      expect: /is cluster-scoped .* but the manifest sets metadata\.namespace/,
    },
    {
      name: "a vendored CRD schema edited after it was vendored",
      run: () => {
        // Widen an enum the way a well-meaning edit would: still valid YAML,
        // still a parseable CRD, silently more permissive than upstream.
        const target = source.files[0].file;
        return digestFailures(source, (file) =>
          file === target
            ? Buffer.concat([readSchema(file), Buffer.from("\n# widened locally\n")])
            : readSchema(file),
        );
      },
      expect: /does not match its recorded digest/,
    },
  ];

  const failures = [];
  for (const { name, run, expect } of cases) {
    const found = run();
    const hit = found.find((f) => expect.test(f));
    console.log(`  ${hit ? "PASS" : "FAIL"}  rejects: ${name}`);
    if (hit) {
      console.log(`          → ${hit}`);
    } else {
      failures.push(`${name} — gate reported: ${found.join("; ") || "nothing"}`);
    }
  }

  const cleanIntegrity = digestFailures(source, readSchema);
  const clean = gate(clone(), index);
  const accepted = cleanIntegrity.length === 0 && clean.errors.length === 0;
  console.log(`  ${accepted ? "PASS" : "FAIL"}  accepts: the committed platform.yaml + schemas`);
  if (!accepted) {
    failures.push(`committed inputs rejected: ${[...cleanIntegrity, ...clean.errors].join("; ")}`);
  }

  return failures;
}

// ─────────────────────────── run ───────────────────────────

const { source, index, readSchema } = loadSchemas();
const documents = parseManifest(MANIFEST_PATH, MANIFEST_LABEL);

if (SELF_TEST) {
  console.log(`  platform.yaml gate — self-test (${MANIFEST_LABEL})`);
  const failures = selfTest(documents, index, source, readSchema);
  if (failures.length > 0) {
    console.error("\n  ✗ the gate did not catch what it claims to catch:");
    for (const failure of failures) console.error(`      - ${failure}`);
    console.error("");
    process.exit(1);
  }
  console.log("  ✓ self-test passed — every seeded defect was rejected");
  process.exit(0);
}

const result = gate(documents, index);

if (result.errors.length > 0) {
  console.error(
    `\n  ✗ ${MANIFEST_LABEL} failed validation (${result.errors.length} problem(s)):\n`,
  );
  for (const error of result.errors) console.error(`      - ${error}`);
  console.error(
    `\n    Schemas: schemas/crd/ vendored from ${source.upstream.repository}@` +
      `${source.upstream.ref.slice(0, 12)}\n`,
  );
  process.exit(1);
}

console.log(
  `  ✓ ${MANIFEST_LABEL}: ${result.docs.length} CR(s) valid against ${index.size} digest-verified ` +
    `CRD schema(s)` +
    (result.chartFileCount > 0
      ? `, tenant attributes consistent across ${result.chartFileCount} values file(s)`
      : ""),
);
