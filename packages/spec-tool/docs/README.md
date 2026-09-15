# Spec Tool documentation authority

The canonical design authority for Spec / `@deviltea/spec-tool` / `spec` is:

- GitHub Discussion #65 — `spec-tool: canonical design discussion`
  https://github.com/DevilTea/deviltea-labs/discussions/65

Design precedence is intentionally explicit:

1. The current accepted direction recorded in Discussion #65.
2. Shipped code and tests, which describe current implementation behavior but do not define future product direction.
3. `docs/ef-core/`, retained as inherited EF implementation/history reference while Spec is redesigned.
4. Historical issues and archived EF design material, including issues #63 and #11.

When these sources conflict, the higher-precedence source wins.

Standalone planning documents are intentionally not maintained in this package. New design exploration, alternatives, and accepted decisions belong in Discussion #65 so there is one canonical continuation point.

## Spec-native implementation

The current MVP is rooted at `.spec/` and uses the Spec-native UUIDv7/kind
model. It does not read or migrate `.engineering/` workspaces. The core slice
currently provides `spec init`, `spec validate`, and `spec version`; artifact
CRUD, query, lifecycle mutation, relation mutation, and Resource mutation are
later slices.

## Inherited EF Core documentation

`docs/ef-core/` is retained as historical EF implementation reference. It is
**not** the Spec product model. Its assumptions about identity, workspace
layout, lifecycle orchestration, Git authority, implementation linkage, and
change transactions must not be imported into Spec runtime behavior.
