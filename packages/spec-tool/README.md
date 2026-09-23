# @deviltea/spec-tool

Git-native, file-backed semantic specifications for agents and developers. Spec Tool owns **specification authority**, not implementation planning, task management, test execution, or code generation. Its normalized, read-only graph is designed for reliable downstream tooling.

The canonical product design is [Discussion #65, Thread 4](https://github.com/DevilTea/deviltea-labs/discussions/65). This package implements the frozen v1 model; there is **no compatibility mode** for the previous Artifact/lifecycle/Resource ontology.

Requires Node.js `^22.14.0 || ^24.0.0`.

## Quick start

Install the package or run the repository's `spec` binary. Initialize an empty workspace at an existing repository root:

```sh
spec workspace init --root .
spec workspace validate --root .
spec graph export --root .
```

Initialization creates **only** `.spec/spec.yaml` with exactly:

```yaml
formatVersion: 1
```

Empty storage directories are optional. The workspace is valid even when it contains no semantic units.

Commands use **JSON on stdin** for structured requests. JSON is the default output format; `--format human` is explicit opt-in. Successful operations write JSON to stdout and exit 0; errors write JSON to stderr and exit nonzero. A failed `workspace validate` writes its `valid: false` diagnostics to stderr.

To create a Feature, copy the current revision from `spec graph export` or `spec workspace validate`, then submit:

```sh
printf '%s\n' '{"title":"Search","summary":"Find matching items","expectedRevision":"<current-sha256>"}' \
  | spec feature create --root .
```

Each successful mutation returns `revision`, `changedNodes[]`, `deletedIds[]`, and `changedEdges: { added: [], removed: [] }`. Refresh `expectedRevision` after a semantic change. A stale revision returns `revision_conflict`; do not blindly retry without rereading the graph.

## Semantic model

| Semantic unit | Purpose | Persistence |
| --- | --- | --- |
| Story | Actor, goal, and user value | `.spec/stories/<uuid>.md` |
| Feature | Capability semantics and invariants | `.spec/features/<uuid>.md` |
| Rule | Stable-addressable behavioral obligation owned by one Feature | Embedded in its Feature's `rules[]` |
| Scenario | Ordered observable interaction, not test execution status | `.spec/scenarios/<storage-uuid>.feature` |
| Contract | Independently governed cross-Feature normative authority | `.spec/contracts/<uuid>.md` |
| Clause | Stable-addressable obligation owned by one Contract | Embedded in its Contract's `clauses[]` |

Every semantic unit has a **workspace-global canonical lowercase UUIDv7**. File paths, display titles, Rule/Clause array order, and Scenario container filenames do not define semantic identity. A Scenario's semantic UUID is independent of its storage UUID, and imported `.feature` files may contain multiple Scenarios.

Create standalone Contracts only when authority both crosses Feature boundaries **and** requires separate ownership/lifecycle. Local Feature obligations are Rules; a shared use alone does not automatically justify a Contract. A Use Case may inform design, but it is **not** a persisted v1 semantic unit.

### Canonical relations

| From | Relation | Allowed targets | Cardinality |
| --- | --- | --- | --- |
| Story | `motivates` | Feature | 1..N |
| Scenario | `demonstrates` | Rule, Clause, Feature, Contract | 1..N |
| Contract | `constrains` | Feature | 1..N |
| Clause | `constrains` | Feature, Rule | Inherit or nonempty override |

Relations are source-owned and persist **target UUIDs only**. Clause `constrains` omitted from its YAML object means inherit its owning Contract's Feature scope. An explicit nonempty array completely **replaces**, not unions with, the inherited scope. `graph set-relation-targets` accepts `targets: null` only for Clause `constrains`, restoring inheritance. Effective inherited edges are materialized in the normalized graph.

`demonstrates` records specification meaning, **not** a claim that a test ran, passed, or covered a target. Prefer demonstrating an existing Rule/Clause; use Feature/Contract directly only when that authority is indivisible.

### Restricted Gherkin

Scenario files use a strict English subset: one `Feature:` header, then one or more `Scenario:` blocks. Each Scenario has a metadata group, ordered `Given* → When+ → Then+` steps, and ≥1 demonstrates target. `And`/`But` inherit the preceding effective step phase; normalized IR exposes only `given`, `when`, `then`. Background, Scenario Outline, tables, Doc Strings and arbitrary tags are unsupported.

```gherkin
Feature: Search experience
  @spec:id:<scenario-uuid>
  @spec:demonstrates:<rule-or-feature-uuid>
  Scenario: A user searches
    Given searchable items exist
    When the user submits a query
    Then matching results appear
```

The `@spec:demonstrates` UUIDs must be sorted. Gherkin comments and the storage-only Feature header do not enter the semantic revision.

## Public operations

The resource-first CLI namespaces are `workspace`, `graph`, `story`, `feature`, `rule`, `scenario`, `contract` and `clause`. Run `spec --help` for the full operation list.

```text
workspace init | validate
graph export | get | list | incoming | outgoing | set-relation-targets
story create | update | delete
feature create | update | delete | delete-with-children
rule create | update | delete | reorder | reparent | promote
scenario create | update | delete
contract create | update | delete | delete-with-children
clause create | update | delete | reorder | reparent | demote
```

All mutations require the current `expectedRevision`. Create operations allocate UUIDv7 automatically; no caller-selected ID. Rule/Clause reorder requires **the complete current ordered child-ID set**. Reparent keeps the UUID and appends to its new owner's array.

Cross-kind conversion is explicit: `rule promote` requires `{ id, newOwnerId, relations: { constrains: null | UUID[] }, expectedRevision }`; `clause demote` requires `{ id, newOwnerId, relations: {}, expectedRevision }`. Conversion refuses any incompatible inbound references rather than silently cleaning up relations. Feature/Contract ordinary delete refuses attached children. `delete-with-children` needs `{ ownerId, childIds, expectedRevision }`, and `childIds` must exactly equal all current children; owner/child inbound references block the entire operation.

### TypeScript API

```ts
import { createSpecClient, SpecError } from '@deviltea/spec-tool'

const client = createSpecClient('/absolute/repository/root')
const { revision, data } = await client.graph.export()

const feature = await client.feature.create({
	title: 'Search',
	summary: 'Return matching items',
	expectedRevision: revision,
})

const rule = await client.rule.create({
	ownerId: feature.changedNodes[0]!.id,
	statement: 'Results are deterministic',
	expectedRevision: feature.revision,
})

const graph = await client.graph.export()
console.log(rule.changedNodes, graph.data.edges)

try {
	await client.workspace.validate()
}
catch (error) {
	if (error instanceof SpecError)
		console.error(error.toJSON())
}
```

The public runtime exports are `createSpecClient`, `SpecClient` and `SpecError`. Public TypeScript request/response, normalized IR and diagnostic types are exported from the package root.

## Files, validation, and concurrency

`.spec/` is closed-world: only `spec.yaml` and the four flat semantic roots are allowed. Markdown files carry exact, ordered YAML frontmatter; their explanatory bodies are noncanonical and preserved during unrelated semantic rewrites. Rule and Clause identities are global even though their records are embedded.

`workspace validate` returns `{valid, revision?, issues[]}`, including stable source paths and diagnostic reasons. Invalid workspaces have **no semantic revision** and block general semantic reads/writes. Repair invalid persistence externally and validate again; v1 provides no repair or migration API.

The graph exposes deterministic UUID-sorted nodes and source/type/target-sorted edges. A semantic SHA-256 revision excludes `source.path`, Scenario grouping/storage UUIDs, Markdown notes, comments and presentation-only child ordering; it includes normalized semantic fields, ownership and effective relation edges. Reordering alone is a no-op semantically.

Spec Tool's ephemeral repository-root `.spec-tool-v1.lock` and `.spec-tool-v1.readers` coordinate its own readers/writers across processes. Mutations perform optimistic revision checks under the lock and roll back normally failed writes. A process crash or power loss is **not** guaranteed crash-atomic across files; stale tokens fail closed and require operator verification before manual cleanup. Direct external file edits do not participate in the locks.

For detailed commands and persistence examples see [full v1 documentation](https://github.com/DevilTea/deviltea-labs/tree/main/packages/spec-tool/docs). Agent-facing workflows are in the shipped `maintain-spec-workspace` and `review-spec-workspace` skills.
