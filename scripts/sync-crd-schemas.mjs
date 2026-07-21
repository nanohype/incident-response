#!/usr/bin/env node
/**
 * Copy the eks-agent-platform CRD schemas into schemas/crd/, or verify the
 * copies already there are byte-identical to upstream (`--check`).
 *
 * The validator (scripts/validate-platform-manifests.mjs) reads only the
 * vendored copies, so it never depends on this script or on network access.
 * This script is the freshness half: run in `--check` mode against a checkout
 * of nanohype/eks-agent-platform, it turns an upstream API change into a
 * failing CI job instead of a schema that silently drifts out of date.
 *
 * Usage:
 *   EKS_AGENT_PLATFORM_DIR=../eks-agent-platform node scripts/sync-crd-schemas.mjs
 *   EKS_AGENT_PLATFORM_DIR=../eks-agent-platform node scripts/sync-crd-schemas.mjs --check
 */

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const SOURCE_MANIFEST = join(SCHEMA_DIR, "source.json");
const DEFAULT_UPSTREAM_DIR = resolve(REPO_ROOT, "..", "eks-agent-platform");

const CHECK_ONLY = process.argv.includes("--check");

function die(message, remedy) {
  console.error(`\n  ✗ ${message}`);
  if (remedy) console.error(`    ${remedy}`);
  console.error("");
  process.exit(1);
}

if (!existsSync(SOURCE_MANIFEST)) {
  die(
    `schemas/crd/source.json is missing`,
    "The vendored CRD schemas and their provenance manifest travel together — restore both.",
  );
}

/** @type {{ upstream: { repository: string, path: string, ref: string }, files: string[] }} */
const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8"));

const upstreamDir = resolve(process.env.EKS_AGENT_PLATFORM_DIR ?? DEFAULT_UPSTREAM_DIR);
const upstreamCrdDir = join(upstreamDir, manifest.upstream.path);

if (!existsSync(upstreamCrdDir) || !statSync(upstreamCrdDir).isDirectory()) {
  die(
    `no ${manifest.upstream.path} directory under ${upstreamDir}`,
    `Set EKS_AGENT_PLATFORM_DIR to a checkout of ${manifest.upstream.repository}.`,
  );
}

const drifted = [];
const copied = [];

for (const file of manifest.files) {
  const from = join(upstreamCrdDir, file);
  const to = join(SCHEMA_DIR, file);

  if (!existsSync(from)) {
    die(
      `${file} does not exist upstream at ${from}`,
      "The CRD was renamed or removed — reconcile schemas/crd/source.json with upstream.",
    );
  }

  const upstreamBytes = readFileSync(from);
  const vendoredBytes = existsSync(to) ? readFileSync(to) : null;

  if (vendoredBytes !== null && upstreamBytes.equals(vendoredBytes)) continue;

  if (CHECK_ONLY) {
    drifted.push(vendoredBytes === null ? `${file} (missing locally)` : file);
    continue;
  }

  copyFileSync(from, to);
  copied.push(file);
}

if (CHECK_ONLY) {
  if (drifted.length > 0) {
    console.error(`\n  ✗ vendored CRD schemas differ from ${manifest.upstream.repository}:`);
    for (const file of drifted) console.error(`      - ${file}`);
    console.error(
      `\n    Re-vendor and update schemas/crd/source.json's ref:\n` +
        `      EKS_AGENT_PLATFORM_DIR=<checkout> npm run schemas:sync\n`,
    );
    process.exit(1);
  }
  console.log(
    `  ✓ ${manifest.files.length} CRD schemas byte-identical to ${manifest.upstream.repository}`,
  );
  process.exit(0);
}

if (copied.length === 0) {
  console.log(`  ✓ CRD schemas already up to date with ${upstreamDir}`);
} else {
  console.log(`  ✓ re-vendored ${copied.length} CRD schema(s) from ${upstreamDir}:`);
  for (const file of copied) console.log(`      - ${file}`);
  console.log(`\n    Update schemas/crd/source.json's ref to the upstream commit you copied.`);
}
