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

## Inherited EF Core documentation

`docs/ef-core/` is kept temporarily because much of the copied implementation still follows it and its deterministic parsing/validation rules remain useful implementation reference material.

It is **not** the canonical Spec product model. In particular, copied EF assumptions about identity, workspace layout, target/version workflow, Git authority boundaries, implementation linkage, and change transactions may be superseded by Discussion #65 before the implementation is updated.
