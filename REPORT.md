# Cross-repository findings

Defects found while repairing the CRD freshness report's remediation in this
repository, in code this repository may not edit. Each names the repository and
file that owns the fix.

---

## 1. `sync-vendored.mjs --freshness` prints a resolved commit inside the command it tells you to run

**Owner:** `nanohype/nanohype`, `library/scripts/sync-vendored.mjs`
**Vendored here as:** `scripts/sync-vendored.mjs` (`scripts/vendored.json`, entry
`library/scripts/sync-vendored.mjs` → `scripts/sync-vendored.mjs`), pinned at
`88c07323182dc650e0044771e715fe5eb6068da3`. `node scripts/sync-vendored.mjs --check`
in CI rejects any edit made here, which is the correct behaviour and why this is a
report rather than a commit.

### The defect

`runFreshness` emits, on a behind verdict:

```js
`    Adopt the newer library when convenient: \`npm run sync:vendored -- --ref=${tip}\`,\n`
```

`tip` is `git rev-parse HEAD` of the upstream checkout, resolved during the run.
It is interpolated **unabbreviated**, inside backticks, as a finished runnable
command — so what the report hands the reader is not a placeholder they must
resolve but an answer they can paste. The verdict line above it carries the same
commit abbreviated to twelve characters, and the current-verdict line carries it
too.

This is the same defect this repository just repaired in `sync-crd-schemas.mjs`,
one degree worse: the CRD twin leaked its resolved commit into prose and offered
a `<sha>` placeholder, which at least forces a lookup. This one is built to spare
the reader that lookup, which is exactly what gets it pasted unread.

### Why it is a defect even though nothing files an issue

`.github/workflows/vendored-freshness.yml` in this repository grants
`contents: read` and has no `gh issue` step: a behind verdict goes red in a
scheduled run and that is the whole notification. No durable artifact carries the
stale command, so the harm here is smaller than the CRD twin's — no issue closes
itself on a wrong instruction.

It is still a defect, for two reasons that do not depend on this repository's
workflow:

- The report is written for deferred action — "Adopt the newer library **when
  convenient**". A reader is invited to come back later, and later is exactly
  when the commit it names has stopped being the newest. A pin adopted from a
  three-week-old run log is behind on the day it merges, and the next scheduled
  run reports the repository behind again: the check instructs you to do a thing
  that leaves the check red.
- It is library code. `vendored.json` copies this file verbatim into every
  repository that vendors from nanohype, so its output contract has to hold under
  any consumer's workflow, not just under one that keeps the report ephemeral.
  The CRD workflow in this same repository is the existence proof that a consumer
  will pipe a freshness report into a durable, self-closing GitHub issue — and
  the reasoning recorded in that workflow's header says why they will. A consumer
  who adds `issues: write` inherits the bug rather than writing it.

### The change

Mirror what `scripts/sync-crd-schemas.mjs` now does: the remediation names
`--ref=latest`, the verdict names the repository rather than the commit, and
`latest` resolves upstream's tip when the re-vendor runs.

Three things do not port cleanly and the upstream change has to settle them:

- **There is no network seam.** `bindUpstream` requires a real checkout, so
  `latest` can only mean a local HEAD. Bare `rev-parse HEAD` would resolve to
  whatever branch a developer's sibling checkout sits on — `UPSTREAM_DIR`
  defaults to `../nanohype` — and `--ref=latest` would then vendor WIP and pin
  it. Resolve the default branch explicitly, and say which in the error when it
  cannot be resolved. Without that, `latest` is not safe to add and the honest
  fix is the verdict rewrite alone.
- **`movePin` writes its argument verbatim.** The literal `latest` reaching it
  would write `"ref": "latest"` into `vendored.json`, which `readManifest`
  rejects on the next run — bricking the repository until someone hand-edits it
  back. Resolve before binding, and refuse to write a pin that is not a SHA.
  `sync-crd-schemas.mjs` now asserts this immediately before the write rather
  than relying on the next run's read to catch it.
- **A ref genuinely named `latest`** would resolve under `git cat-file -e
  latest^{commit}`. Resolving the sentinel before it reaches any ref-taking call
  is what keeps it from being mistaken for one.

### A second defect in the same function

`runFreshness` returns `1` for "the pin is behind", and it is dispatched through
`process.exit(await runFreshness(...))`. `die` throws a `GateError` the top-level
handler also exits `1` on, so "the check could not run" — an unreachable
upstream, a checkout that is not a checkout — is indistinguishable from confirmed
drift to any caller.

`sync-crd-schemas.mjs` splits them deliberately: exit 2 for behind, exit 1 for
could-not-determine, because collapsed into one code a month of failed lookups
reads as a month of confirmed drift. Any consumer adding issue-filing to the
vendored freshness check needs this split first, so it belongs in the same
upstream change.

### What the existing `--self-test` covers

Nothing here. `runFreshness` is referenced twice in the file — its definition and
its dispatch — and `runSelfTest` never calls it. Every case concerns the manifest
and the copies (a branch name where a SHA is required, an abbreviated SHA, a pin
no checkout contains, an edited copy, an unexpected or deleted file in a vendored
tree, an undeclared module in an exclusive directory). The report's output is
unasserted, which is why this defect could sit in a file that self-tests
seventeen ways.

The gate added here — `test/unit/crd-freshness-report.test.ts` — is the shape
that would catch it: build an upstream repository whose HEAD the fixture chose,
run the report against it through the checkout seam, and assert on the emitted
bytes rather than on the code that builds them.

---

## 2. Two verdicts that change with no commit, and only one of them is a defect

**Owner:** an estate-wide distinction, recorded here because this repository met both
failure modes in the same evening and mistook the second for the first.

### The observation

Two checks in this repository's CI can go from green to red with no commit in between:

- the format step, when `editorconfig-checker` resolved a release through the GitHub API
  and downloaded a binary at check time;
- `npm audit --omit=dev --audit-level=high`, which queries the advisory database when it
  runs.

Both were verified on a lockfile and a tree that had not changed. The audit case was
confirmed against `main`'s own lockfile in a scratch tree: identical findings, on a commit
whose CI run was green.

### The distinction

They differ in what is fetched, and the difference decides whether a red build is a defect
to fix or a gate to obey.

**`editorconfig-checker` fetched the TOOL.** When the fetch failed, nothing had been
learned about the tree — the verdict was unavailable — and it printed as a FORMAT failure,
which reads as a claim that files are malformed. A gate that cannot run is not a gate, and
a gate that reports a tree defect when it never read the tree is worse than absent. That is
unavailability wearing a verdict's clothes.

**`npm audit` fetches the DATA.** When the answer changes, something new and true has been
learned: the world's knowledge of these dependencies moved. The tree did not change and its
risk did, because risk was never a property of the bytes — it is a property of the bytes
plus what is known about them.

So "a verdict that can change with no commit" is a defect when what changed is whether a
download succeeded, and is the entire point when what changed is what the world knows.

**The tell is what a red build tells you to do.** Editorconfig red said to fix a formatting
defect that did not exist, and sent the reader nowhere. Audit red said to take a fix that
exists, and sent the reader somewhere real.

### What follows from it

The advisory clock belongs to whoever publishes advisories. This is why the estate's
Renovate preset opens a CVE pull request the moment a fix exists rather than waiting for a
scheduled scan: a gate whose input moves on someone else's schedule needs a channel that
moves on the same schedule, not a slower one.

### The corollary: two overrides wearing the same button

The distinction decides more than how to read a red build. It decides whether
overriding one is an act at all.

A gate that could not run has produced no verdict, so overriding it overrides
nothing — it records that a check was unavailable, which was already true. A gate
that ran and objected has produced a verdict, and overriding it discards evidence
someone gathered. Those are different acts behind the same button, and the button
does not distinguish them.

That is not a licence to use the first one. An override leaves no record that a
decision was made: the next reader at the same wall re-derives it, or does not, and
the repository says nothing about which way it went. Where the two failures can be
fixed together instead, fixing them is strictly better than overriding either,
because the reasoning ends up somewhere the next reader will find it.

Which is the case this repository met. Two defects reached `main` independently and
neither was fixable alone — a branch carrying either fix still failed the merge gate
on the other, because `Merge Gate` needs both `lint` and `security-audit`. "A branch
fixes one thing" serves reviewability, and two defects coupled by one gate are one
change from that gate's perspective, so keeping them apart served nothing. The
combined branch names the JOB rather than the two defects, which is what makes a
two-argument diff legible rather than arbitrary.

It also sets what a fix has to clear. The audit reports what the database knows, so
satisfying the audit and being fixed are different conditions, and they came apart here:
`fast-uri` 3.1.6 patches the four advisories the audit reported, while 3.1.7 — a security
release published the same day — fixes two more that return 404 from the global advisory
API. Taking the version the audit is satisfied by would have produced a green gate over a
tree with two known high-severity defects. Read the release notes at the boundary; the
audit's silence is the database's coverage, not a verdict.
