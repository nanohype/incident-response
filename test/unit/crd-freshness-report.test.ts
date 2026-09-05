/**
 * What `npm run schemas:freshness` SAYS, asserted by running it.
 *
 * ── Why the assertions are on bytes ─────────────────────────────────────────
 *
 * `.github/workflows/crd-schema-freshness.yml` runs the report weekly and copies
 * its output verbatim into an issue body, editing the same issue in place. The
 * body therefore refreshes every Monday and is read on whatever day someone
 * opens the issue. A commit id resolved during a run and printed there is
 * accurate for that run and is presented, unqualified, until the next one — so
 * an operator acting on it re-vendors to a ref that is no longer the newest and
 * closes an issue that should have stayed open. A wrong instruction that also
 * dismisses its own warning.
 *
 * That defect is invisible in the code that builds the report, which looks
 * correct: it prints what it just resolved. It is only visible in the emitted
 * bytes, read later. So these cases assert on the bytes, and the refusal is
 * structural — no commit id at all, rather than "not this one" — because a
 * structural refusal survives a rewrite that moves where the id is printed.
 *
 * ── Why a real git repository ───────────────────────────────────────────────
 *
 * Each case builds an upstream repository whose two commits it chose: the first
 * is what the fixture pins, the second changes a schema the way the operator's
 * CRDs actually changed (it gains a `pattern` bound on a model-id field). The
 * script is driven against it through `$EKS_AGENT_PLATFORM_DIR`, the same seam
 * `.github/workflows/ci.yml` uses to hand it a checkout. Nothing here reaches
 * the network, and the fixture knows the answer the script must not print.
 *
 * The last two cases are the point of the file taken together: the remediation
 * is correct, AND running it does what it says. A report naming a command that
 * resolves to the wrong commit would be no better than one naming a stale
 * commit outright.
 *
 * ── What this does not cover ────────────────────────────────────────────────
 *
 * It does not run GitHub Actions, so the step that copies the report into the
 * issue body is asserted only as the literal it contains, not as a rendered
 * issue. It does not exercise the raw.githubusercontent.com / api.github.com
 * resolution path — both cases drive the checkout seam, so a defect reachable
 * only without `$EKS_AGENT_PLATFORM_DIR` would pass here. And it says nothing
 * about whether the pin is behind in reality; that is the scheduled workflow's
 * question, deliberately kept off the blocking path.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "sync-crd-schemas.mjs");
const SOURCE_MANIFEST = path.join(REPO_ROOT, "schemas", "crd", "source.json");
const FRESHNESS_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "crd-schema-freshness.yml");

/** The file the fixture's second commit changes — the one that gains a bound. */
const DRIFTED = "agents.nanohype.dev_modelgateways.yaml";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  /** The commit the fixture's manifest pins. Legitimately nameable in output. */
  pin: string;
  /** Upstream's tip. The answer the report must not print. */
  head: string;
  /** Run the script against this fixture. Never throws — the exit code is data. */
  run(...args: string[]): { code: number; report: string };
  /** `upstream.ref` as it stands in the fixture's manifest right now. */
  pinnedRef(): string;
  /** A vendored schema's bytes as they stand in the fixture's tree right now. */
  vendored(file: string): string;
}

/**
 * An upstream repository plus a tree the script can run in.
 *
 * The tree is a copy rather than the repository itself because the script
 * resolves `schemas/crd/` from its OWN location — `join(SCRIPT_DIR, "..")` —
 * not from the working directory, so a case cannot simply chdir. Copying the
 * script beside a fixture `schemas/crd/` is what gives each case a manifest it
 * may rewrite without touching the committed one.
 *
 * The declared file list, repository and path come from the real manifest, so a
 * schema added to the vendored set appears here too rather than leaving this
 * fixture describing a shape the repository has left behind.
 *
 * Three commits, and the third is what keeps the `current` cases honest. Upstream's
 * tip is usually NOT the commit that last touched the vendored path — as of the
 * pin this repository ships, three commits have landed on
 * `operators/config/crd/bases` and the default branch has moved past all of them.
 * A fixture whose tip always equals its pin would make every "no commit id"
 * assertion on the current path vacuous, because the id it must not print and
 * the id it may print would be the same string.
 */
function fixture(pinnedAt: "behind" | "current" = "behind"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crd-freshness-"));
  roots.push(root);

  const manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, "utf8"));
  const { repository, path: upstreamPath } = manifest.upstream;
  const files: string[] = manifest.files.map((f: { file: string }) => f.file);

  const upstream = path.join(root, "upstream");
  const bases = path.join(upstream, upstreamPath);
  fs.mkdirSync(bases, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8" }).trim();

  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  git("config", "user.email", "fixture@invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");

  // `kind: CustomResourceDefinition` is not decoration — the script refuses any
  // upstream file without it, so a fixture missing it would fail for a reason
  // the case is not about.
  for (const file of files) {
    fs.writeFileSync(
      path.join(bases, file),
      `apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: ${file}\n`,
    );
  }
  git("add", "-A");
  git("commit", "-qm", "before the operator gained the bound");
  const firstCommit = git("rev-parse", "HEAD");

  // The drift the operator's CRDs actually took: a model-id field gains a
  // `pattern`, so a consumer still on the old pin keeps accepting manifests the
  // apiserver will reject.
  fs.appendFileSync(
    path.join(bases, DRIFTED),
    "                        pattern: ^(us\\.)?anthropic\\.[a-z0-9-]+-v[0-9]+:[0-9]+$\n",
  );
  git("add", "-A");
  git("commit", "-qm", "allowedModels admits a truncated model id");
  const schemasSettled = git("rev-parse", "HEAD");

  // Upstream moves for reasons that are none of this repository's business.
  fs.writeFileSync(path.join(upstream, "README.md"), "unrelated to the CRDs\n");
  git("add", "-A");
  git("commit", "-qm", "docs: unrelated to the vendored path");
  const head = git("rev-parse", "HEAD");

  const pin = pinnedAt === "current" ? schemasSettled : firstCommit;

  const tree = path.join(root, "tree");
  const schemaDir = path.join(tree, "schemas", "crd");
  fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tree, "scripts", path.basename(SCRIPT)));

  // Vendored at the pin, so the tree is a truthful copy of the commit it names
  // and the case's "behind" verdict comes from real drift rather than a
  // manufactured mismatch.
  for (const file of files) {
    fs.writeFileSync(
      path.join(schemaDir, file),
      git("show", `${pin}:${upstreamPath}/${file}`) + "\n",
    );
  }
  fs.writeFileSync(
    path.join(schemaDir, "source.json"),
    `${JSON.stringify(
      {
        upstream: { repository, path: upstreamPath, ref: pin },
        files: files.map((file) => ({
          file,
          sha256: createHash("sha256")
            .update(fs.readFileSync(path.join(schemaDir, file)))
            .digest("hex"),
        })),
      },
      null,
      2,
    )}\n`,
  );

  return {
    pin,
    head,
    run(...args) {
      const result = spawnSync(
        process.execPath,
        [path.join(tree, "scripts", path.basename(SCRIPT)), ...args],
        {
          encoding: "utf8",
          env: { ...process.env, EKS_AGENT_PLATFORM_DIR: upstream },
        },
      );
      return { code: result.status ?? -1, report: `${result.stdout}${result.stderr}` };
    },
    pinnedRef: () =>
      JSON.parse(fs.readFileSync(path.join(schemaDir, "source.json"), "utf8")).upstream.ref,
    vendored: (file) => fs.readFileSync(path.join(schemaDir, file), "utf8"),
  };
}

/**
 * Every spelling of a commit id the report is allowed to contain: the pin, and
 * only the pin.
 *
 * The pin is exempt because it is not resolved when the report runs. It is read
 * from the manifest in the commit under test, so it cannot describe a different
 * commit tomorrow than it did today — and naming it is how a reader knows which
 * commit the verdict is about. Everything else in the output was resolved during
 * the run and has been going stale ever since.
 */
function withoutThePin(report: string, pin: string): string {
  let stripped = report;
  for (let n = pin.length; n >= 7; n--) stripped = stripped.split(pin.slice(0, n)).join("");
  return stripped;
}

describe("the CRD schema freshness report", () => {
  it("reports the pin is behind, and says so with the exit code the workflow branches on", () => {
    const fx = fixture();
    const { code, report } = fx.run("--freshness");
    expect(code, report).toBe(2);
    expect(report).toContain("is behind");
  });

  it("names no commit but the pin", () => {
    const fx = fixture();
    const { report } = fx.run("--freshness");
    const stripped = withoutThePin(report, fx.pin);

    // Specific: not the commit this fixture knows the run resolved, at any
    // abbreviation git would print — %h defaults to seven characters.
    for (let n = fx.head.length; n >= 7; n--) {
      expect(
        stripped,
        `the report names upstream HEAD abbreviated to ${n} characters`,
      ).not.toContain(fx.head.slice(0, n));
    }

    // Structural: no commit id at all, so a rewrite cannot reintroduce the
    // staleness by printing a different one, or by printing it somewhere else.
    expect(stripped, "the report names a commit id resolved at run time").not.toMatch(
      /[0-9a-f]{12,}/,
    );
  });

  it("names the pin, so the verdict says which commit is behind", () => {
    const fx = fixture();
    const { report } = fx.run("--freshness");
    // Without this the case above passes against a report that names nothing.
    expect(report).toContain(fx.pin.slice(0, 12));
  });

  it("remediates with a command that resolves upstream HEAD when it runs", () => {
    const fx = fixture();
    const { report } = fx.run("--freshness");
    expect(report).toContain("npm run schemas:sync -- --ref=latest");
  });

  it("leaves no placeholder for the reader to fill from a stale line above it", () => {
    const fx = fixture();
    const { report } = fx.run("--freshness");
    // `--ref=<sha>` prints no commit itself, which is how it reads as safe. The
    // only sha within reach of someone holding this report is the one the run
    // resolved, so the placeholder routes them to it just as surely.
    expect(report).not.toContain("--ref=<sha>");
  });

  it("moves the pin onto upstream HEAD when the remediation is run", () => {
    const fx = fixture();
    expect(fx.pinnedRef()).toBe(fx.pin);
    const { code, report } = fx.run("--ref=latest");
    expect(code, report).toBe(0);
    expect(fx.pinnedRef()).toBe(fx.head);
  });

  it("vendors the bytes at the commit it resolved, not the ones it was pinned to", () => {
    const fx = fixture();
    fx.run("--ref=latest");
    // A pin that moved while the copies did not is the divergence `--check`
    // exists to catch, and it would make the remediation a lie in the direction
    // that matters: an adopted bound that is not actually enforced here.
    expect(fx.vendored(DRIFTED)).toContain("pattern:");
  });

  it("vendors and pins the ref it was handed, not whatever the checkout sits on", () => {
    const fx = fixture();
    // This is what makes the case above a test rather than a coincidence. In a
    // checkout, upstream's tip and `git rev-parse HEAD` are the same commit, so
    // a resolver that returned nothing useful would still appear to land on it.
    // Asking for a ref that is NOT the tip is the only way to observe whether
    // the ref decides anything: if it does not, `--ref=latest` lands correctly
    // by accident and would go on doing so after the resolver broke.
    const { code, report } = fx.run(`--ref=${fx.pin}`);
    expect(code, report).toBe(0);
    expect(fx.pinnedRef()).toBe(fx.pin);
    expect(fx.vendored(DRIFTED)).not.toContain("pattern:");
  });

  it("closes the verdict that named it", () => {
    const fx = fixture();
    expect(fx.run("--freshness").code).toBe(2);
    fx.run("--ref=latest");
    const after = fx.run("--freshness");
    expect(after.code, after.report).toBe(0);
    expect(after.report).toContain("is current");
  });

  it("names no commit but the pin when the pin is current either", () => {
    // Pinned to the commit that last changed the schemas, while upstream's tip
    // has moved past it for unrelated reasons — so "current" and "the tip" are
    // different commits here, and a report naming the tip has somewhere to be
    // caught.
    const fx = fixture("current");
    const { code, report } = fx.run("--freshness");
    expect(code, report).toBe(0);
    expect(report).toContain("is current");
    expect(withoutThePin(report, fx.pin)).not.toMatch(/[0-9a-f]{12,}/);
  });

  it("refuses a --ref that is neither `latest` nor a full commit SHA", () => {
    const fx = fixture();
    // `latest` is a single literal, not a licence for branch names: a pin that
    // could be `main` would make every gate reading it a verdict about whenever
    // it last ran.
    const before = fx.vendored(DRIFTED);
    const { code, report } = fx.run("--ref=main");
    expect(code, report).toBe(1);
    expect(fx.pinnedRef()).toBe(fx.pin);
    // Refusing has to mean changing nothing. A run that vendored the branch's
    // bytes and only then refused to record the name leaves the copies
    // describing a commit the manifest does not claim — the divergence
    // `--check` exists to catch, manufactured by the guard meant to prevent it.
    expect(fx.vendored(DRIFTED)).toBe(before);
  });

  it("pins a commit SHA, never a name that would resolve differently later", () => {
    const fx = fixture();
    fx.run("--ref=latest");
    expect(fx.pinnedRef()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the drift issue the freshness workflow files", () => {
  const workflow = fs.readFileSync(FRESHNESS_WORKFLOW, "utf8");

  it("tells the reader to run the command, not to supply a commit", () => {
    expect(workflow).toContain("npm run schemas:sync -- --ref=latest");
  });

  it("carries no placeholder the reader would fill from the report above it", () => {
    // The body interpolates the report verbatim, so the only sha an operator
    // reading this issue can reach is the one that run resolved. A `<sha>`
    // placeholder here points at it.
    expect(workflow).not.toContain("--ref=<sha>");
  });
});
