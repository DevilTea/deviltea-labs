---
name: author-engineering-files
description: Initialize and validate a Spec-native workspace with @deviltea/spec-tool. Use for `.spec/` setup and deterministic structural validation; artifact CRUD, query, lifecycle mutation, relation mutation, and Resource mutation are outside this MVP slice.
---

# Author Spec Files

This skill covers the Spec-native MVP core. The canonical workspace root is
`.spec/`; there is no `.engineering/` compatibility or migration path in
`@deviltea/spec-tool`.

Use the CLI as the deterministic primitive:

```text
spec init --format json --no-input
spec validate --format json --no-input
```

`spec init` creates the exact `spec/config@1` config, all canonical
kind-directories, and one active PROJECT with a UUIDv7 identity. `spec
validate` checks the current workspace's layout, envelope, identity, status,
body-section, relation, and Resource structure.

Do not infer natural-language semantic correctness from a passing structural
validation. Do not use this skill to implement artifact or graph mutation
commands; those belong to later MVP slices.
