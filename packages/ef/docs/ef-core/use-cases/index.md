# EF Core User Stories and Use Cases

Status: Draft

## Purpose

This directory turns the accepted EF Core v1 specifications into an ordered,
test-ready catalogue of user-facing behaviour. It is a planning and test-design
companion: the numbered EF Core specifications remain normative when there is
a conflict.

The order follows an engineering journey from establishing a project through
authoring, integration, validation, retrieval, and automation. Case IDs are
stable references for future test plans. `Happy path` identifies the primary
flow; `Guardrails` identifies required rejection or non-implicit behaviour.

## Conventions

- **User Story** uses the form: *As a ..., I want ..., so that ...*.
- **Preconditions** are facts required before a flow starts.
- **Success assertions** are observable outcomes suitable for acceptance tests.
- **Guardrails** are negative, boundary, or non-goal scenarios; they should
  normally become separate negative tests.
- An Artifact ID is exact and case-sensitive. “Current” means the lifecycle
  predicate defined by EF Core, not a title, filename, or inferred latest item.
- Git publication is outside the current Core CLI, but its required
  validate-then-compare-and-swap integration boundary is included because it
  governs authoritative EF state.

## Journey map

```text
UC-001..004  Establish and locate an EF project
        -> UC-010..019  Create and model draft knowledge
        -> UC-020..025  Normalize input, retain evidence, and migrate deliberately
        -> UC-030..039  Change, complete, retire, or supersede knowledge
        -> UC-040..045  Validate and publish one authoritative transition
        -> UC-050..055  Find, trace, resolve, and load explicit context
        -> UC-060..064  Use the CLI safely in people, editor, and CI flows
```

## Catalogue

| Order | File | Cases | Primary actors |
|---:|---|---|---|
| 1 | [01-project-and-workspace.md](01-project-and-workspace.md) | UC-001–UC-004 | Project maintainer, workspace contributor, CI |
| 2 | [02-draft-authoring.md](02-draft-authoring.md) | UC-010–UC-019 | Product/engineering author, reviewer |
| 3 | [03-input-and-resources.md](03-input-and-resources.md) | UC-020–UC-025 | Researcher, author, verifier |
| 4 | [04-engineering-transactions.md](04-engineering-transactions.md) | UC-030–UC-034 | Change author, reviewer, integrator |
| 5 | [05-terminal-state-and-supersession.md](05-terminal-state-and-supersession.md) | UC-035–UC-039 | Change author, consumer, reviewer |
| 6 | [06-validation-and-publication.md](06-validation-and-publication.md) | UC-040–UC-045 | CI, integrator, editor |
| 7 | [07-query-trace-and-context.md](07-query-trace-and-context.md) | UC-050–UC-055 | Engineer, agent, reviewer |
| 8 | [08-cli-and-automation.md](08-cli-and-automation.md) | UC-060–UC-064 | CLI user, editor, CI, tool author |

## Specification coverage

| EF Core specification | Cases that exercise it |
|---|---|
| 00 Overview | All; especially UC-001, UC-030, UC-040, UC-055 |
| 01 Artifact Envelope | UC-010–UC-013, UC-041 |
| 02 Identity | UC-001, UC-010, UC-011, UC-042 |
| 03 Lifecycle | UC-012, UC-030–UC-039, UC-042 |
| 04 Relations | UC-014, UC-030, UC-035–UC-039, UC-052–UC-054 |
| 05 Supersession | UC-035–UC-039, UC-053 |
| 06 Resources | UC-015, UC-020–UC-024, UC-031, UC-055 |
| 07 CHG Transaction Semantics | UC-030–UC-034, UC-040–UC-044 |
| 08 Artifact Body Schemas | UC-012–UC-013, UC-030, UC-034–UC-036 |
| 09 Validation | UC-004, UC-040–UC-045, UC-061–UC-064 |
| 10 Query and Trace | UC-050–UC-055, UC-063 |
| 11 Filesystem and Configuration | UC-001–UC-004, UC-025, UC-031, UC-040–UC-045, UC-060 |
| 12 Input Normalization | UC-020–UC-022 |
| 13 CLI Contract | UC-001, UC-010, UC-040, UC-050–UC-055, UC-060–UC-064 |

## Test-suite extension model

Use the case ID as the shared root for tests and fixtures, for example
`UC-035.one-to-many.valid` or `UC-042.transition.missing-baseline`. A useful
test matrix adds these dimensions without changing this catalogue:

| Dimension | Values to vary |
|---|---|
| Invocation | human, JSON, `--no-input`, `--dry-run`, `--yes` |
| State | bootstrap, draft, active, superseded, retired, completed |
| Graph shape | no edge, direct edge, incoming edge, split, consolidation, cycle |
| Repository | working snapshot, trusted baseline/proposed commits, stale ref |
| Result | successful, domain rejection (exit 1), incomplete (exit 2), internal failure (exit 3) |

Each future automated test should cite both its UC ID and the governing
specification section or diagnostic code. This preserves the distinction
between a valid flow, a deliberately rejected state, and an unavailable
operation.
