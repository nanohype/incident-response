#!/usr/bin/env node
/**
 * Sync the vendored copies this repo carries from the nanohype repo — the
 * single source of truth. Same consumption model as nanohype's
 * scripts/sync-library.mjs: copies are byte-identical to their source, fixes
 * propagate outward (land in nanohype first, then re-copy), and a copy that
 * drifts from the source is the defect.
 *
 * Vendored surfaces:
 *   - chart/charts/tenant-chart-base   ← templates/tenant-chart-base/skeleton/chart
 *   - src/vendor/runtime/*.ts          ← library/runtime/src/<module>.ts
 *
 * Usage:
 *   node scripts/sync-vendored.mjs            # re-copy from the nanohype checkout
 *   node scripts/sync-vendored.mjs --check    # CI gate: exit 1 if any copy drifted
 *
 * The nanohype checkout is resolved from $NANOHYPE_DIR, defaulting to a
 * sibling checkout at ../nanohype (CI checks out nanohype/nanohype and points
 * NANOHYPE_DIR at it).
 */
import { readdir, readFile, rm, cp, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NANOHYPE_DIR = process.env['NANOHYPE_DIR'] ?? join(ROOT, '..', 'nanohype');
const CHECK = process.argv.includes('--check');

/** Runtime modules this app consumes. Tests stay upstream (library/runtime/src/*.test.ts). */
const RUNTIME_MODULES = [
  'circuit-breaker.ts',
  'logger.ts',
  'metrics.ts',
  'pii.ts',
  'resilience.ts',
  'workos-directory.ts',
];

/** Recursively list files under a dir, relative to it (sorted). */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p));
  }
  return out.sort();
}

async function readOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** @returns {Promise<number>} count of drifted files (check mode) or 0 after copying. */
async function syncDir(srcDir, destDir) {
  const rel = relative(ROOT, destDir);
  if (CHECK) {
    const srcFiles = await listFiles(srcDir);
    let copyFiles;
    try {
      copyFiles = await listFiles(destDir);
    } catch {
      copyFiles = null;
    }
    const sameList = copyFiles !== null && copyFiles.join('\n') === srcFiles.join('\n');
    const sameBytes =
      sameList &&
      (
        await Promise.all(
          srcFiles.map(
            async (f) =>
              (await readFile(join(srcDir, f), 'utf8')) === (await readOrNull(join(destDir, f))),
          ),
        )
      ).every(Boolean);
    if (sameBytes) {
      console.log(`ok  ${rel}`);
      return 0;
    }
    console.error(`DRIFT  ${rel} — run \`npm run sync:vendored\``);
    return 1;
  }
  await rm(destDir, { recursive: true, force: true });
  await cp(srcDir, destDir, { recursive: true });
  console.log(`vendored ${rel}`);
  return 0;
}

/** @returns {Promise<number>} count of drifted files (check mode) or 0 after copying. */
async function syncFiles(srcDir, destDir, files) {
  let drift = 0;
  if (!CHECK) await mkdir(destDir, { recursive: true });
  for (const f of files) {
    const rel = relative(ROOT, join(destDir, f));
    if (CHECK) {
      const src = await readFile(join(srcDir, f), 'utf8');
      const copy = await readOrNull(join(destDir, f));
      if (src === copy) {
        console.log(`ok  ${rel}`);
      } else {
        console.error(`DRIFT  ${rel} — run \`npm run sync:vendored\``);
        drift++;
      }
    } else {
      await copyFile(join(srcDir, f), join(destDir, f));
      console.log(`vendored ${rel}`);
    }
  }
  return drift;
}

/** @returns {Promise<number>} drift count for one renamed file (org-canonical configs). */
async function syncFile(srcPath, destPath) {
  const rel = relative(ROOT, destPath);
  if (CHECK) {
    const src = await readFile(srcPath, 'utf8');
    const copy = await readOrNull(destPath);
    if (src === copy) {
      console.log(`ok  ${rel}`);
      return 0;
    }
    console.error(`DRIFT  ${rel} — run \`npm run sync:vendored\``);
    return 1;
  }
  await copyFile(srcPath, destPath);
  console.log(`vendored ${rel}`);
  return 0;
}

async function main() {
  try {
    await stat(NANOHYPE_DIR);
  } catch {
    console.error(`nanohype checkout not found at ${NANOHYPE_DIR} — set NANOHYPE_DIR`);
    process.exit(2);
  }
  let drift = 0;
  drift += await syncDir(
    join(NANOHYPE_DIR, 'templates', 'tenant-chart-base', 'skeleton', 'chart'),
    join(ROOT, 'chart', 'charts', 'tenant-chart-base'),
  );
  drift += await syncFiles(
    join(NANOHYPE_DIR, 'library', 'runtime', 'src'),
    join(ROOT, 'src', 'vendor', 'runtime'),
    RUNTIME_MODULES,
  );
  drift += await syncFile(
    join(NANOHYPE_DIR, 'library', 'config', 'prettierrc.json'),
    join(ROOT, '.prettierrc.json'),
  );
  if (CHECK && drift > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
