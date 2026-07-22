#!/usr/bin/env node
/**
 * Vendor the eks-agent-platform CRD schemas into schemas/crd/, and — in
 * `--check` mode — prove the vendored copies still say what upstream says.
 *
 * The split of responsibility with the validator matters. The validator
 * (scripts/validate-platform-manifests.mjs) reads only the vendored copies and
 * verifies their SHA-256 digests against schemas/crd/provenance.json. That
 * makes it offline, deterministic, and unable to pass by failing to find its
 * schema — but it trusts a manifest that lives in the same commit, so a change
 * that edits a schema *and* its digest together would slip past it.
 *
 * This script closes that. `--check` reads upstream out of a git checkout and
 * asserts three things per file:
 *
 *   1. digest       — the bytes on disk hash to what provenance.json records
 *   2. pinned ref   — the bytes on disk are byte-identical to upstream at
 *                     provenance.json's `commit`. A hand-edited schema, or a
 *                     `commit` bumped without re-vendoring, fails here
 *   3. upstream tip — upstream at the pinned commit is byte-identical to
 *                     upstream at HEAD. A CRD that moved on since the pin
 *                     fails here, so a stale pin surfaces as a red check
 *                     instead of a schema quietly rotting
 *
 * Every failure to *reach* an answer — no checkout, not a git repository, the
 * pinned commit absent from the clone, a declared file missing upstream — exits
 * non-zero with a remedy. There is no skip path: a drift check that passes
 * because it could not look is the bug this exists to catch.
 *
 * Usage:
 *   EKS_AGENT_PLATFORM_DIR=../eks-agent-platform node scripts/sync-crd-schemas.mjs
 *   EKS_AGENT_PLATFORM_DIR=../eks-agent-platform node scripts/sync-crd-schemas.mjs --check
 *
 * The checkout resolves from $EKS_AGENT_PLATFORM_DIR, defaulting to a sibling
 * at ../eks-agent-platform. CI checks out nanohype/eks-agent-platform with full
 * history (`fetch-depth: 0`) so the pinned commit is reachable.
 *
 * Exit codes: 0 clean · 1 drift found · 2 cannot check.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const PROVENANCE_PATH = join(SCHEMA_DIR, "provenance.json");
const DEFAULT_UPSTREAM_DIR = resolve(REPO_ROOT, "..", "eks-agent-platform");

const CHECK_ONLY = process.argv.includes("--check");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** "I cannot answer the question" — never the same thing as "the answer is fine". */
function cannotCheck(message, remedy) {
  console.error(`\n  ✗ cannot check CRD schema drift: ${message}`);
  if (remedy) console.error(`    ${remedy}`);
  console.error("");
  process.exit(2);
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ─────────────────────────── provenance ───────────────────────────

if (!existsSync(PROVENANCE_PATH)) {
  cannotCheck(
    "schemas/crd/provenance.json is missing",
    "The vendored CRD schemas and their provenance travel together — restore both.",
  );
}

/**
 * @type {{
 *   repository: string, sourcePath: string, commit: string, generator: string,
 *   files: { file: string, sha256: string }[],
 * }}
 */
let provenance;
try {
  provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
} catch (err) {
  cannotCheck(`schemas/crd/provenance.json is not valid JSON — ${err.message}`);
}

if (!Array.isArray(provenance.files) || provenance.files.length === 0) {
  cannotCheck("schemas/crd/provenance.json declares no schema files");
}
if (typeof provenance.commit !== "string" || !/^[0-9a-f]{40}$/.test(provenance.commit)) {
  cannotCheck(
    "schemas/crd/provenance.json's `commit` is not a full 40-character SHA",
    "Pin an exact upstream commit — an abbreviation or a branch name is not a pin.",
  );
}

// ─────────────────────────── upstream checkout ───────────────────────────

const upstreamDir = resolve(process.env.EKS_AGENT_PLATFORM_DIR ?? DEFAULT_UPSTREAM_DIR);

if (!existsSync(upstreamDir) || !statSync(upstreamDir).isDirectory()) {
  cannotCheck(
    `no checkout at ${upstreamDir}`,
    `Set EKS_AGENT_PLATFORM_DIR to a checkout of ${provenance.repository}.`,
  );
}

try {
  git(upstreamDir, ["rev-parse", "--git-dir"]);
} catch {
  cannotCheck(
    `${upstreamDir} is not a git repository`,
    "The pinned-commit comparison reads upstream through git, so a plain directory is not enough.",
  );
}

/** Read `<ref>:<sourcePath>/<file>` as a Buffer, or null when the path is absent at that ref. */
function readAtRef(ref, file) {
  try {
    return git(upstreamDir, ["show", `${ref}:${provenance.sourcePath}/${file}`]);
  } catch {
    return null;
  }
}

// ─────────────────────────── re-vendor ───────────────────────────

if (!CHECK_ONLY) {
  // The recorded commit has to describe the bytes actually copied, so refuse to
  // vendor from a working tree that has uncommitted changes under sourcePath —
  // otherwise the pin would name a commit that never contained these schemas.
  const dirty = git(upstreamDir, ["status", "--porcelain", "--", provenance.sourcePath])
    .toString()
    .trim();
  if (dirty) {
    cannotCheck(
      `${upstreamDir}/${provenance.sourcePath} has uncommitted changes`,
      "Commit or stash them upstream first — the pin must name a commit that holds these bytes.",
    );
  }

  const head = git(upstreamDir, ["rev-parse", "HEAD"]).toString().trim();
  const vendored = [];

  for (const { file } of provenance.files) {
    const bytes = readAtRef("HEAD", file);
    if (bytes === null) {
      cannotCheck(
        `${provenance.sourcePath}/${file} does not exist at ${upstreamDir}#HEAD`,
        "The CRD was renamed or removed — reconcile schemas/crd/provenance.json with upstream.",
      );
    }
    writeFileSync(join(SCHEMA_DIR, file), bytes);
    vendored.push({ file, sha256: sha256(bytes) });
    console.log(`  ✓ vendored schemas/crd/${file}`);
  }

  writeFileSync(
    PROVENANCE_PATH,
    `${JSON.stringify({ ...provenance, commit: head, files: vendored }, null, 2)}\n`,
  );
  console.log(`  ✓ pinned to ${provenance.repository}@${head}`);
  process.exit(0);
}

// ─────────────────────────── check ───────────────────────────

try {
  git(upstreamDir, ["cat-file", "-e", `${provenance.commit}^{commit}`]);
} catch {
  cannotCheck(
    `${provenance.commit.slice(0, 12)} is not present in ${upstreamDir}`,
    "Check out nanohype/eks-agent-platform with full history (fetch-depth: 0) so the pinned commit is reachable.",
  );
}

const head = git(upstreamDir, ["rev-parse", "HEAD"]).toString().trim();

/** Vendored bytes that no longer match their pin — a hand edit, here or in the manifest. */
const tampered = [];
/** The pin itself has fallen behind upstream. */
const stale = [];

for (const { file, sha256: expected } of provenance.files) {
  const localPath = join(SCHEMA_DIR, file);

  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    cannotCheck(`schemas/crd/provenance.json records no usable sha256 for ${file}`);
  }
  if (!existsSync(localPath)) {
    tampered.push(`${file} — declared in provenance.json but not present on disk`);
    continue;
  }

  const local = readFileSync(localPath);
  const actual = sha256(local);
  if (actual !== expected) {
    tampered.push(
      `${file} — sha256 ${actual.slice(0, 16)}… on disk, provenance.json records ${expected.slice(0, 16)}…`,
    );
  }

  const atPin = readAtRef(provenance.commit, file);
  if (atPin === null) {
    cannotCheck(
      `${provenance.sourcePath}/${file} does not exist at ${provenance.repository}@${provenance.commit.slice(0, 12)}`,
      "The pin predates this CRD, or the file was renamed — re-vendor and repin.",
    );
  }
  if (!local.equals(atPin)) {
    tampered.push(
      `${file} — differs from ${provenance.repository}@${provenance.commit.slice(0, 12)}`,
    );
  }

  const atHead = readAtRef("HEAD", file);
  if (atHead === null) {
    stale.push(`${file} — removed or renamed upstream since the pin`);
    continue;
  }
  if (!atPin.equals(atHead)) {
    stale.push(`${file} — changed upstream between the pin and ${head.slice(0, 12)}`);
  }
}

if (tampered.length === 0 && stale.length === 0) {
  console.log(
    `  ✓ ${provenance.files.length} vendored CRD schemas match ${provenance.repository}@` +
      `${provenance.commit.slice(0, 12)}, and that pin is current with ${head.slice(0, 12)}`,
  );
  process.exit(0);
}

if (tampered.length > 0) {
  console.error("\n  ✗ vendored CRD schemas do not match their pin:");
  for (const line of tampered) console.error(`      - ${line}`);
  console.error(
    "\n    A vendored schema is a copy, never a source. Fix upstream and re-vendor:\n" +
      "      EKS_AGENT_PLATFORM_DIR=<checkout> npm run schemas:sync",
  );
}

if (stale.length > 0) {
  console.error(
    `\n  ✗ the pin ${provenance.commit.slice(0, 12)} is behind ${provenance.repository}@${head.slice(0, 12)}:`,
  );
  for (const line of stale) console.error(`      - ${line}`);
  console.error(
    "\n    Re-vendor, review the schema diff, and ship it with whatever platform.yaml\n" +
      "    change it implies:\n" +
      "      EKS_AGENT_PLATFORM_DIR=<checkout> npm run schemas:sync",
  );
}

console.error("");
process.exit(1);
