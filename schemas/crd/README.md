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

`source.json` records the upstream repository, path, and the commit the copies
were taken from.

## Why vendored rather than fetched

The validator runs on every pull request, including from forks and on runners
that have no network egress policy of ours. Fetching the schema at gate time
makes the gate's verdict depend on a third party being reachable, and the
tempting failure handler — skip validation when the fetch fails — is the exact
shape of bug this gate exists to catch. Reading the schema out of the working
tree makes the result a pure function of the commit under test.

Freshness is a separate concern, handled by a separate signal: the `ci`
workflow's `crd-schema-drift` job checks out `nanohype/eks-agent-platform` at
its default branch and diffs it against these copies, so an upstream API change
surfaces as a failing check rather than as a schema that quietly rots.

## Refreshing

Point the sync script at a local `eks-agent-platform` checkout and re-copy:

```sh
EKS_AGENT_PLATFORM_DIR=../eks-agent-platform npm run schemas:sync
```

Then update `source.json`'s `ref` to the upstream commit you copied from. Fixes
belong upstream — never hand-edit a file in this directory.

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
