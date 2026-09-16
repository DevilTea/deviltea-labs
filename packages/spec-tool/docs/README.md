# Spec Tool documentation authority

The canonical design authority for Spec / `@deviltea/spec-tool` / `spec` is:

- GitHub Discussion #65 — `spec-tool: canonical design discussion`
  https://github.com/DevilTea/deviltea-labs/discussions/65

Design precedence is intentionally explicit:

1. The current accepted direction recorded in Discussion #65.
2. Shipped code and tests, which describe current implementation behavior but do not define future product direction.
3. `docs/ef-core/`, retained only as inherited EF implementation/history reference.
4. Historical issues and archived EF design material.

When these sources conflict, the higher-precedence source wins. Standalone
planning documents are intentionally not maintained in this package; new design
exploration, alternatives, and accepted decisions belong in Discussion #65.

## Current Spec-native MVP

The implemented MVP is rooted at `.spec/` and uses UUIDv7 Artifact identities
with the Spec-native kind model. It provides:

- workspace initialization and current-workspace validation;
- Artifact create/get/update/delete/list;
- lifecycle activate/complete/retire/supersede;
- relation add/remove/list with graph invariants;
- local and HTTPS Resource descriptors plus local-only Resource reads;
- deterministic title/body search;
- deterministic `refines` trace in `up`, `down`, or `both` directions;
- stable human and versioned JSON command results.

The MVP does not read or migrate `.engineering/` workspaces and does not carry
EF schema aliases, sequential IDs, linked-repository semantics, integration-ref
or Git transition/range/bootstrap authority, CHG exactly-once effects, or
implementation-linkage behavior.

Published Agent Skills are `maintain-spec-workspace` and
`review-spec-workspace`. They describe the complete current MVP rather than the
inherited EF workflow.

## Inherited EF Core documentation

`docs/ef-core/` is historical source material only. It is **not** the Spec
product model, is not included in the published npm package, and must not be
used to override Discussion #65 or current Spec behavior. Its assumptions about
identity, workspace layout, lifecycle orchestration, Git authority,
implementation linkage, and change transactions are intentionally non-binding.
