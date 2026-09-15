---
name: review-engineering-change
description: Review the current Spec-native `.spec/` workspace with the read-only `spec validate` command. Use for deterministic layout and structural validation; Git transition and provider review semantics are outside this MVP slice.
---

# Review Spec Workspace

Run the validator from the workspace or a nested directory:

```text
spec validate --format json --no-input
```

Report `valid`, `complete`, and every returned diagnostic. A passing result
proves deterministic current-workspace structure only. It does not establish
natural-language adequacy, Git publication authority, lifecycle history
immutability, or relation semantics beyond this slice's structural checks.

This skill is read-only. Do not edit files, run migration logic, or inspect an
`.engineering/` tree as part of Spec validation.
