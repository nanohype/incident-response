#!/usr/bin/env node
/**
 * Validate platform.yaml against the eks-agent-platform CRD schemas.
 *
 * Three layers:
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
 * Usage:
 *   node scripts/validate-platform-manifests.mjs [manifest] [--no-chart-values]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const SOURCE_MANIFEST = join(SCHEMA_DIR, "source.json");
const CHART_DIR = join(REPO_ROOT, "chart");

const args = process.argv.slice(2);
const checkChartValues = !args.includes("--no-chart-values");
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

// ─────────────────────────── schema loading ───────────────────────────

function loadSchemas() {
  if (!existsSync(SOURCE_MANIFEST)) {
    abort(
      `schemas/crd/source.json is missing`,
      "Restore the vendored CRD schemas; see schemas/crd/README.md.",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8"));
  } catch (err) {
    abort(`schemas/crd/source.json is not valid JSON — ${err.message}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    abort("schemas/crd/source.json declares no schema files");
  }

  /** @type {Map<string, { kind: string, scope: string, schema: object, file: string }>} */
  const index = new Map();

  for (const file of manifest.files) {
    const path = join(SCHEMA_DIR, file);
    if (!existsSync(path)) {
      abort(
        `${file} is declared in schemas/crd/source.json but not present`,
        "Re-vendor with: EKS_AGENT_PLATFORM_DIR=<checkout> npm run schemas:sync",
      );
    }

    let crd;
    try {
      crd = parseYaml(readFileSync(path, "utf8"));
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

  return { manifest, index };
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

// ─────────────────────────── run ───────────────────────────

const { manifest, index } = loadSchemas();

if (!existsSync(MANIFEST_PATH)) {
  abort(`${MANIFEST_PATH} does not exist`);
}

const parsed = parseAllDocuments(readFileSync(MANIFEST_PATH, "utf8"));
const docs = [];
let position = 0;

for (const document of parsed) {
  position += 1;
  if (document.errors.length > 0) {
    for (const err of document.errors) {
      record(`doc ${position}`, `YAML error — ${err.message}`);
    }
    continue;
  }
  const value = document.toJS();
  if (value === null) continue; // trailing `---`
  const validated = validateDocument(value, position, index);
  if (validated) docs.push(validated);
}

if (docs.length === 0 && errors.length === 0) {
  abort(`${MANIFEST_LABEL} contains no Kubernetes documents`);
}

const names = validateWiring(docs);
const chartFileCount = checkChartValues ? validateChartValues(names) : 0;

if (errors.length > 0) {
  console.error(`\n  ✗ ${MANIFEST_LABEL} failed validation (${errors.length} problem(s)):\n`);
  for (const error of errors) console.error(`      - ${error}`);
  console.error(
    `\n    Schemas: schemas/crd/ vendored from ${manifest.upstream.repository}@` +
      `${manifest.upstream.ref.slice(0, 12)}\n`,
  );
  process.exit(1);
}

console.log(
  `  ✓ ${MANIFEST_LABEL}: ${docs.length} CR(s) valid against ${index.size} vendored CRD schema(s)` +
    (chartFileCount > 0
      ? `, tenant attributes consistent across ${chartFileCount} values file(s)`
      : ""),
);
