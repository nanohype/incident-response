# Vendored CRD schemas

Byte-identical copies of the `controller-gen` output in
[`nanohype/eks-agent-platform`](https://github.com/nanohype/eks-agent-platform)
under `operators/config/crd/bases/`. They are the schemas
`scripts/validate-platform-manifests.mjs` checks `platform.yaml` against.

| File                                          | Kind           | Scope      |
| --------------------------------------------- | -------------- | ---------- |
| `platform.nanohype.dev_tenants.yaml`           | `Tenant`       | Cluster    |
| `platform.nanohype.dev_platforms.yaml`         | `Platform`     | Namespaced |
| `governance.nanohype.dev_budgetpolicies.yaml`  | `BudgetPolicy` | Namespaced |

`provenance.json` records the upstream repository, the source path, the commit
the copies were taken from, the `controller-gen` version that generated them,
and a SHA-256 for each file.

## Why vendored rather than fetched

The validator runs on every pull request, including from forks and on runners
that have no network egress policy of ours. Fetching the schema at gate time
makes the gate's verdict depend on a third party being reachable, and the
tempting failure handler — skip validation when the fetch fails — is the exact
shape of bug this gate exists to catch. Reading the schema out of the working
tree makes the result a pure function of the commit under test.

## Two checks, because one is not enough

A vendored schema is a copy. It has no authority of its own, so the gate has to
be able to tell the difference between a copy and an edit — in both directions.

**Integrity, offline.** `scripts/validate-platform-manifests.mjs` hashes every
file here and matches it against `provenance.json` before parsing anything, and
refuses a `.yaml` in this directory that `provenance.json` does not declare. An
enum widened by hand, a `required` quietly dropped, a fourth schema slipped in:
all fail before a single CR is looked at. This needs no network, so it runs in
the same job as the rest of the gate.

**Provenance, against upstream.** The digest lives in the same commit as the
file it describes, so an edit that updates both would satisfy the check above.
`scripts/sync-crd-schemas.mjs --check` closes that in the `crd-schema-drift` CI
job, which checks out `nanohype/eks-agent-platform` with full history and
asserts:

- the bytes here are byte-identical to upstream at `provenance.json`'s `commit`
  — a hand-edited schema fails, and so does a `commit` bumped without
  re-vendoring
- upstream at that commit is byte-identical to upstream at the branch tip — so a
  pin left behind by an API change surfaces as a red check rather than as a
  schema rotting in place

Everything that stops the script from *reaching* an answer — no checkout, not a
git repository, the pinned commit missing from a shallow clone, a declared file
gone upstream — exits `2` with a remedy. There is no path where it passes
without having looked.

## Refreshing

Point the sync script at a local `eks-agent-platform` checkout and re-copy. It
reads upstream at `HEAD`, rewrites the files here, and rewrites
`provenance.json`'s `commit` and digests in one step, so the pin can never
disagree with the bytes:

```sh
EKS_AGENT_PLATFORM_DIR=../eks-agent-platform npm run schemas:sync
```

It refuses to run when the upstream working tree has uncommitted changes under
`operators/config/crd/bases` — the recorded commit has to name something that
actually holds these bytes. Fixes belong upstream; never hand-edit a file in
this directory.

Verify without writing (what CI runs):

```sh
EKS_AGENT_PLATFORM_DIR=../eks-agent-platform npm run schemas:check
```

## What the gate does and does not enforce

`controller-gen` emits OpenAPI v3 schemas without `additionalProperties: false`,
so an off-the-shelf JSON Schema validator accepts any invented field. The
validator therefore walks the schema itself and rejects properties that are not
declared, alongside the usual `required` / `type` / `enum` / `pattern` /
bounds checks, and asserts each kind's scope.

It does not evaluate `x-kubernetes-validations` CEL rules (for example
`Platform.spec.identity`'s mutual exclusion of `allowedModels` and
`allowedModelFamilies`). Those are enforced by the API server at admission.

`npm run platform:selftest` seeds five defects — an undeclared field, a missing
required field, a `Platform.spec.tenant` pointing at no declared `Tenant`, a
namespace on the cluster-scoped `Tenant`, and an edited vendored schema — and
fails unless each one is rejected and the committed inputs are accepted. It runs
on every CI build as part of `platform:validate`, so a gate that has decayed
into a no-op cannot pass quietly.
