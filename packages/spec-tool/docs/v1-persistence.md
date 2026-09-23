# Frozen-v1 canonical persistence and graph

[Discussion #65, Thread 4](https://github.com/DevilTea/deviltea-labs/discussions/65) is the design authority. This describes deterministic persistence and derived read-only IR, not extra file-management APIs.

## Workspace and identity

An existing repository becomes a Spec workspace with exactly `.spec/spec.yaml` containing `formatVersion: 1` and a terminal newline. Only the following flat canonical roots are allowed; create them lazily:

```text
.spec/
  spec.yaml
  stories/<semantic-uuid>.md
  features/<semantic-uuid>.md
  contracts/<semantic-uuid>.md
  scenarios/<storage-uuid>.feature
```

Each semantic ID is workspace-global canonical lowercase UUIDv7, **including embedded** Rule and Clause IDs. Story/Feature/Contract filename stem equals frontmatter `id`. Scenario storage UUID is independent of all Scenario semantic IDs, even when a single file stores multiple Scenarios. Titles are not unique; rename, reordering, storage moves and wording edits do not allocate fresh identities.

No extra files, subdirectories, symlinks or unknown frontmatter fields are legal. An empty workspace needs **only** its manifest and remains valid.

## Canonical Markdown frontmatter

Story (exact key order `id,title,actor,goal,value,motivates`):

```yaml
---
id: <uuid-v7>
title: Find an item
actor: Buyer
goal: Find matching items
value: Save time
motivates:
  - <feature-uuid>
---
```

Feature (exact key order `id,title,summary,rules`):

```yaml
---
id: <uuid-v7>
title: Search
summary: Find matching items
rules:
  - id: <rule-uuid>
    statement: Results use stable ordering
---
```

Contract (exact key order `id,title,summary,clauses,constrains`):

```yaml
---
id: <uuid-v7>
title: Shared protocol
summary: Cross-feature external obligations
clauses:
  - id: <inherited-clause-uuid>
    statement: Responses remain interoperable
  - id: <overridden-clause-uuid>
    statement: Search latency is bounded
    constrains:
      - <feature-or-rule-uuid>
constrains:
  - <feature-uuid>
---
```

Rule records have exact keys `id,statement`. Clause records have exact keys `id,statement` and optional `constrains` **last**. An omitted Clause `constrains` inherits the owning Contract's scope; a present nonempty array is a complete, independent Feature/Rule override. Persisting an empty or null Clause `constrains` field is invalid. Contract `constrains` always contains ≥1 Feature. Relation UUID arrays are unique and lexicographically sorted; `rules[]` and `clauses[]` preserve authored presentation order.

When a Feature or Contract has no child records, persist the explicit empty array `rules: []` or `clauses: []`. No default or implicit owner children exist. The optional Markdown body after closing `---` is **noncanonical** human explanation, outside IR and revision; unrelated semantic writes retain its exact bytes.

## Scenario restricted Gherkin

`.spec/scenarios/<storage-uuid>.feature` contains a single `Feature:` display header and one or more independently identified `Scenario:` blocks. Its strict accepted subset uses English `Given/When/Then/And/But` only; `And`/`But` inherit the effective phase of the previous step. Every Scenario needs canonical metadata (`@spec:id` first, then ≥1 UUID-sorted `@spec:demonstrates`), a nonempty title, and `Given* → When+ → Then+` steps. Blocks have a single blank line separator.

```gherkin
Feature: Search interactions
  @spec:id:<first-scenario-uuid>
  @spec:demonstrates:<rule-or-feature-uuid>
  Scenario: An item is found
    Given searchable items exist
    When the buyer searches
    Then matching items appear

  @spec:id:<second-scenario-uuid>
  @spec:demonstrates:<clause-or-contract-uuid>
  Scenario: A second interaction
    When another operation runs
    Then an observable result is returned
```

Arbitrary newlines/Unicode line separators within semantic titles or step text, unsupported Scenario Outline/Background/Doc Strings/tables and arbitrary tags are rejected. Comments and the Feature display header do not affect revision. Updates preserve unrelated sibling Scenarios and explanatory comments. New Scenarios are created in separate containers; v1 does **not** expose container repacking.

## Normalized graph and semantic revision

`client.graph.export()` derives `{formatVersion:1,nodes:[],edges:[]}` from validated source files. Node schemas are closed-world:

| Kind | Semantic node fields (followed by `source:{path}`) |
| --- | --- |
| Story | `id,kind,title,actor,goal,value` |
| Feature | `id,kind,title,summary` |
| Rule | `id,kind,statement,ownerId` |
| Scenario | `id,kind,title,steps` |
| Contract | `id,kind,title,summary` |
| Clause | `id,kind,statement,ownerId` |

`steps` is an ordered array of `{type:given|when|then,text}` with `And/But` normalized to effective phases. Edges contain exactly `{from,type,to}` with legal `motivates`, `demonstrates` and `constrains` combinations. Even an inheriting Clause produces its own **effective** `constrains` edges in IR. Nodes sort by ID, edges by `from,type,to`.

The lowercase SHA-256 `revision` hashes a deterministic canonical JSON projection of the normalized semantic state with source paths removed, and includes workspace/IR format state, node semantic content, Rule/Clause ownership, normalized Scenario steps and **effective** edges. Body notes, comments, display-only reordering, Scenario container IDs/grouping and storage moves do not change revision. `expectedRevision` on every mutation prevents stale semantic writes.

## Validation and concurrency

`workspace validate` accepts an invalid workspace and reports `valid:false` plus `issues[]`, with repository-relative POSIX source paths, diagnostic field paths and stable reasons (`missing`, `empty`, `invalid_format`, `unsupported`, `duplicate`, `unresolved`, `invariant`). Invalid workspaces expose **no** revision or partial normalized IR; other semantic reads/writes are blocked until externally repaired.

Spec Tool coordinates **its own** processes with transient repository-root `.spec-tool-v1.lock` and `.spec-tool-v1.readers`, checks expected revision under the exclusive writer lock and performs exception rollback after normal write/validation failures. Direct external edits, a process crash or power loss are outside cross-file crash-atomic guarantees. A crashed process may leave stale tokens; verify no process owns them before manual cleanup. They are not canonical `.spec/` semantic content and should not be committed to Git.
