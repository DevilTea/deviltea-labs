# EF Core: Relations Ontology

Status: Accepted

## Scope

This document defines the EF Core v1 Artifact relation entry, relation
vocabulary, storage direction, source and target compatibility, ordering,
required relations, cycle constraints, lifecycle interaction, and relation
validation.

Resource references are represented by the Artifact `resources` field and are
not Artifact relations. Supersession resolution and complete CHG transaction
semantics are defined by later specifications.

## Definitions

### Relation

A relation is a typed, directed edge from one Artifact to another Artifact in
the same EF project knowledge graph:

```text
source --type--> target
```

The source is the Artifact whose `relations` array stores the edge. The target
is identified by Artifact ID.

Relations express machine-readable engineering semantics. A Markdown mention
or link does not create a relation unless a corresponding structured relation
entry exists.

### Semantic relation

A semantic relation expresses derivation, decision coverage, governance,
supersession, or an explicit informational reference between engineering
Artifacts.

EF Core v1 defines five semantic relation types:

```text
derived-from
addresses
governed-by
superseded-by
references
```

### CHG effect relation

A CHG effect relation records a state change that a completed CHG transaction
actually produced.

EF Core v1 defines three CHG effect relation types:

```text
introduces
modifies
retires
```

### Incoming edge

An incoming edge is an edge stored by another Artifact whose target is the
Artifact being inspected. Incoming edges are derived graph data. They are not
duplicated in the target Artifact frontmatter.

EF Core does not define stored inverse relation types. Query output can return
the original `source`, `type`, and `target` together with traversal direction.

## Schema

### Relation entry

Every relation entry is a mapping with exactly two required core fields:

```yaml
relations:
  - type: derived-from
    target: PRD-012
```

| Field | Type | Required | Empty allowed |
|---|---|---:|---:|
| `type` | string | Yes | No |
| `target` | Artifact ID string | Yes | No |

`type` MUST be one of the eight relation types defined by this specification.
Aliases and case variants are invalid.

`target` MUST contain the exact ID of an Artifact in the same EF project. A
path, filename, URL, resource path, title, query, or external project address is
not a valid v1 target.

Relation entries have no independent ID, title, lifecycle, or body. Their
identity within the source Artifact is the pair `(type, target)`.

### Relation extension fields

Relation entries MAY contain namespaced extension fields using the same name
and value rules as Artifact envelope extensions:

```yaml
relations:
  - type: governed-by
    target: POL-006
    x-acme-enforcement: ci
```

Extension fields follow `type` and `target` in bytewise lexicographic field
order. Unknown non-extension fields are invalid. Core tooling MUST preserve
unknown valid extensions but MUST NOT derive core relation semantics from them.

Extension fields do not participate in relation identity. Two entries with the
same `(type, target)` are duplicates even when their extension values differ.

## Rules

### Single stored direction

Every relation is stored only in its defined canonical direction. A producer
MUST NOT store an inverse copy in the target Artifact.

This prevents two authoritative representations of the same edge. Tools that
need reverse navigation build or query incoming edges from the authoritative
Artifact files.

### `derived-from`

`derived-from` means that the source Artifact's engineering content was
derived, decomposed, refined, or generalized from the target Artifact.

Canonical direction:

```text
derived Artifact --derived-from--> source Artifact
```

Allowed combinations:

| Source | Target |
|---|---|
| PRD | PRD |
| REQ | PRD, REQ |
| POL | REQ, POL |

Examples:

```text
REQ-031 --derived-from--> PRD-012
REQ-044 --derived-from--> REQ-031
POL-006 --derived-from--> REQ-014
POL-006 --derived-from--> REQ-022
```

Derivation does not replace or change the lifecycle state of the target.

### `addresses`

`addresses` means that an ADR records a chosen engineering decision that
addresses a REQ.

Canonical direction and only allowed combination:

```text
ADR --addresses--> REQ
```

Not every REQ requires an ADR. An ADR SHOULD use `addresses` when specific
requirements materially define its decision space.

### `governed-by`

`governed-by` means that the source Artifact is subject to the target POL.

Canonical direction:

```text
governed Artifact --governed-by--> POL
```

Allowed sources are PRD, REQ, ADR, and CHG. The target MUST be POL.

PROJECT does not point to project-local policies because membership in the EF
project is implicit. POL-to-POL governance is not part of v1; policy derivation
uses `derived-from`, and an informational dependency uses `references`.

### `superseded-by`

`superseded-by` means that the source Artifact is no longer current because the
target Artifact replaces it.

Canonical direction:

```text
old Artifact --superseded-by--> replacement Artifact
```

Only same-type replacement is allowed:

```text
PRD -> PRD
REQ -> REQ
ADR -> ADR
POL -> POL
```

PROJECT and CHG do not support supersession in EF Core v1.

The source MUST be `superseded`. Each target MUST be `active` when the atomic
supersession transition is applied. A target may later become superseded, in
which case canonical resolution follows the next outgoing `superseded-by`
edge.

The direction is stored on the historical Artifact so a standalone discovery
context can identify and load its replacement without an incoming-edge index.
The source's status and replacement pointers are written in the same atomic
transition and then frozen together.

The inverse statement, such as "REQ-070 supersedes REQ-031," is obtained by an
incoming-edge query. `supersedes` is not a stored v1 relation type.

### `references`

`references` means that the source explicitly cites the target without
asserting derivation, decision coverage, governance, or replacement semantics.

Any Artifact type MAY reference any other Artifact type. A more specific
relation MUST be used when its semantics apply.

Selecting the semantically appropriate relation is an author and reviewer
obligation. Core validation checks the stored relation's vocabulary, direction,
source-target compatibility, lifecycle constraints, and graph invariants; it
does not infer from prose whether a different relation would have been more
appropriate. Optional authoring lint MAY advise on likely misuse without
changing Core validity.

`references` is directed, is not transitive, does not affect lifecycle or
canonical-state resolution, and may participate in cycles.

EF Core v1 does not define `related-to`. A generic symmetric relation is too
ambiguous for reliable engineering queries. General context can be expressed
in the body; a structured informational citation uses `references`.

### `introduces`

`introduces` records that a completed CHG added a previously absent Artifact to
the authoritative graph.

Canonical direction:

```text
CHG --introduces--> newly added Artifact
```

Allowed targets are PRD, REQ, ADR, and POL. PROJECT is created by project
bootstrap, and one CHG does not introduce another CHG.

Introduction is about presence in the authoritative graph, not current
canonical state. The introduced Artifact may be draft or active according to
the transaction.

### `modifies`

`modifies` records that a completed CHG changed an Artifact that existed before
and after the transaction.

Canonical direction:

```text
CHG --modifies--> existing Artifact
```

Allowed targets are PROJECT, PRD, REQ, ADR, and POL.

Modification includes semantic content changes, activation of an existing
draft, relation or resource changes, and transition of an active Artifact to
`superseded`.

### `retires`

`retires` records that a completed CHG transitioned an Artifact to `retired`.

Canonical direction:

```text
CHG --retires--> retired Artifact
```

Allowed targets are PRD, REQ, ADR, and POL. Draft retirement does not require a
CHG, while retirement of active truth does.

### CHG effect truthfulness

`introduces`, `modifies`, and `retires` describe effects that actually occurred,
not planned work.

- Their source MUST be a `completed` CHG.
- A `completed` CHG MUST contain at least one effect relation.
- A draft or retired CHG MUST NOT contain effect relations.
- A CHG MUST NOT declare more than one effect type for the same target.
- The declared effect MUST match the authoritative before-and-after graph.

A draft CHG records planned effects in its body or in transaction-specific
draft structures defined by the CHG specification, not as factual relation
edges.

For a supersession transaction, the graph is represented as:

```text
CHG-182 --introduces------> REQ-070
CHG-182 --modifies--------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

### Source and target compatibility

The complete compatibility matrix is:

| Relation | Source | Target |
|---|---|---|
| `derived-from` | PRD | PRD |
| `derived-from` | REQ | PRD, REQ |
| `derived-from` | POL | REQ, POL |
| `addresses` | ADR | REQ |
| `governed-by` | PRD, REQ, ADR, CHG | POL |
| `superseded-by` | PRD, REQ, ADR, POL | Same type as source |
| `references` | Any Artifact | Any Artifact |
| `introduces` | CHG | PRD, REQ, ADR, POL |
| `modifies` | CHG | PROJECT, PRD, REQ, ADR, POL |
| `retires` | CHG | PRD, REQ, ADR, POL |

### Required relations

Relations are optional unless an Artifact state or transaction semantics
requires them. EF Core does not require every REQ to derive from a PRD, every
ADR to address a REQ, or every Artifact to name a governing POL.

The v1 requirements are:

- Every `superseded` Artifact MUST contain at least one `superseded-by` edge.
- A `superseded-by` edge MUST NOT originate from an Artifact whose status is not
  `superseded`.
- Every `completed` CHG MUST contain at least one `introduces`, `modifies`, or
  `retires` edge.
- A non-completed CHG MUST contain no CHG effect edges.

Further provenance requirements are defined by the supersession and CHG
transaction specifications.

### Self-relations and cycles

Self-relations are invalid for every relation type, including `references`.

The graph formed by `derived-from` edges MUST be acyclic. The graph formed by
`superseded-by` edges MUST be acyclic.

`references` cycles are allowed because reference edges are non-transitive and
do not affect canonical-state resolution. Other relation types cannot form a
same-ontology cycle under the v1 compatibility matrix.

Cycle validation operates over the complete project graph.

### Lifecycle interaction and frozen Artifacts

A relation can target a draft, active, or terminal Artifact when the relation's
specific rules permit it. Targeting a frozen Artifact does not modify the
target file.

An incoming edge may be added without changing a frozen target Artifact. A
frozen Artifact cannot gain, remove, or change an outgoing edge because its
frontmatter is immutable.

`superseded-by` is added during the source's terminal transition before the
source becomes frozen. The complete replacement set MUST be established by the
atomic supersession transaction.

### Canonical ordering and duplicates

Relation entries MUST be sorted by this tuple using bytewise lexicographic
ordering:

```text
(type, target)
```

Within each entry, fields are ordered as:

```text
type
target
x-* fields in bytewise lexicographic order
```

Two entries with the same `(type, target)` are duplicates and invalid. Tools
MUST NOT merge duplicate extension values implicitly.

## Examples

### Requirement traceability

```yaml
relations:
  - type: derived-from
    target: PRD-012
  - type: governed-by
    target: POL-006
```

### ADR coverage

```yaml
relations:
  - type: addresses
    target: REQ-031
  - type: addresses
    target: REQ-044
  - type: governed-by
    target: POL-009
```

### One-to-one supersession

```yaml
# REQ-031.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-070
```

### One-to-many split

```yaml
# REQ-031.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-071
  - type: superseded-by
    target: REQ-072
```

### Many-to-one consolidation

```yaml
# REQ-014.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-070
```

```yaml
# REQ-022.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-070
```

```yaml
# REQ-041.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-070
```

### Canonically ordered relations

```yaml
relations:
  - type: addresses
    target: REQ-031
  - type: addresses
    target: REQ-044
  - type: governed-by
    target: POL-006
  - type: references
    target: ADR-010
```

### Invalid unknown target

```yaml
relations:
  - type: derived-from
    target: PRD-999
```

This relation is invalid when `PRD-999` does not exist in the authoritative
project graph.

### Invalid compatibility

```yaml
# A REQ cannot address an ADR.
relations:
  - type: addresses
    target: ADR-022
```

### Invalid duplicate

```yaml
relations:
  - type: references
    target: REQ-031
  - type: references
    target: REQ-031
    x-acme-note: duplicate
```

Extension fields do not make the second edge distinct.

### Invalid factual effect on draft CHG

```yaml
status: draft
relations:
  - type: modifies
    target: REQ-031
```

Planned work is not a factual CHG effect.

## Validation

Relation validation checks individual entry shape and the complete Artifact
graph. Diagnostics use these stable codes:

| Code | Severity | Condition |
|---|---|---|
| `EF-REL-001` | error | Unknown relation type or case variant |
| `EF-REL-002` | error | Relation entry is not a mapping or lacks a required field |
| `EF-REL-003` | error | Target Artifact does not exist |
| `EF-REL-004` | error | Source and target types are incompatible with relation type |
| `EF-REL-005` | error | Self-relation |
| `EF-REL-006` | error | Duplicate `(type, target)` relation |
| `EF-REL-007` | warning | Non-canonical relation or relation-field ordering |
| `EF-REL-008` | error | `derived-from` cycle |
| `EF-REL-015` | error | Unknown relation field or invalid extension field |
| `EF-REL-017` | error | New `addresses` edge targets a non-active REQ |
| `EF-REL-018` | error | New `governed-by` edge targets a non-active POL |

This namespace validates relation representation and the general relation
graph. Supersession invariants use `EF-SUP-*`, CHG effect semantics use
`EF-CHG-*`, and whole-Artifact frozen-state violations use `EF-LIFE-*`; the
relation validator does not emit aliases for those findings.

A standalone file validator can check entry shape, vocabulary, ordering, and
the source side of compatibility. Target existence, target type, cycles,
lifecycle consistency, incoming edges, and CHG effect truthfulness require the
complete graph or previous authoritative state.

## Deferred

- Transitive canonical replacement resolution, one-to-many and many-to-one
  canonical state, replacement chains, and atomic supersession mutation are
  defined in [Supersession and Canonical State](05-supersession.md).
- CHG planned-effect representation, completion criteria, effect diffing,
  resource mutation, and Git/PR/Issue provenance are defined in [CHG Transaction Semantics](07-change-transactions.md).
- Relation requirements specific to each Artifact body are defined in [Artifact Body Schemas](08-artifact-schemas.md).
- Graph loading, previous-state comparison, strict mode, and diagnostic process
  behavior are defined in [Validation and Integrity](09-validation.md).
- Incoming-edge queries, transitive trace, impact traversal, and stable JSON
  output are defined in [Query and Trace](10-query-and-trace.md).
- Cross-project relation targets are not part of EF Core v1. External sources
  and references are represented as Resources; a future specification may
  define namespaced external Artifact addresses.
- `related-to`, stored inverse relations, custom core relation types, and
  relation-level lifecycle are not part of EF Core v1.
