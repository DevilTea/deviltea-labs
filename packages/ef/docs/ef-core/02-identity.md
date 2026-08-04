# EF Core: Artifact Identity

Status: Accepted

## Scope

This document defines EF Core Artifact identity, including identity scope, ID
syntax, type prefixes, immutability, filenames, PROJECT singleton behavior,
allocation, duplicate handling, non-reuse, branch collisions, and custom prefix
policy.

Lifecycle states, semantic immutability of Artifact content, supersession, and
filesystem layout are defined by later EF Core specifications. Cross-project
addressing is outside EF Core v1.

## Definitions

### Artifact identity

An Artifact ID is the stable machine-readable identity of one logical Artifact.
It is independent of the Artifact title, content, lifecycle state, and directory
path.

An ID identifies the same logical Artifact for its entire lifetime. It MUST NOT
be transferred to a different engineering concept.

### Identity scope

Artifact IDs are globally unique within one EF project knowledge graph. A bare
Artifact ID does not claim uniqueness across unrelated EF projects.

Any future cross-project reference would require a project locator in addition
to an Artifact ID. EF Core v1 defines no such locator or external Artifact
address and permits only project-local structured relation targets.

### Provisional ID

An ID allocated on work that has not entered the project's authoritative
integration history is provisional. A provisional ID can be replaced before
integration when required to resolve a branch collision. Replacing it MUST be
an atomic operation that updates the filename and every local reference.

A provisional ID is not considered permanently issued merely because it
appeared in a private or unintegrated branch.

### Issued ID

An ID becomes issued when its Artifact first enters the project's authoritative
integration history. An issued ID is immutable, permanently reserved, and can
never become provisional again.

The mechanism that identifies the authoritative integration history is part of
the filesystem and configuration specification. EF Core v1 uses the
first-parent history of the repository's configured integration ref.

## Schema

### ID forms

The PROJECT Artifact uses the exact ID:

```text
PROJECT
```

Every other core Artifact uses a type prefix, a hyphen, and a canonical decimal
sequence number:

```text
PRD-001
REQ-001
ADR-001
POL-001
CHG-001
```

The general lexical form is:

```regex
^(PRD|REQ|ADR|POL|CHG)-[0-9]{3,}$
```

The lexical form is necessary but not sufficient. The numeric component MUST
also use its canonical decimal representation.

### Type and prefix mapping

| Artifact | `type` | ID prefix or exact ID |
|---|---|---|
| PROJECT | `project` | `PROJECT` |
| PRD | `prd` | `PRD-` |
| REQ | `requirement` | `REQ-` |
| ADR | `decision` | `ADR-` |
| POL | `policy` | `POL-` |
| CHG | `change` | `CHG-` |

Prefixes are uppercase and case-sensitive. Aliases and case variants are not
valid.

### Canonical numeric component

The numeric component is a positive base-10 integer formatted as follows:

- values from 1 through 999 are left-padded to exactly three digits;
- values of 1000 or greater are written without leading zeroes; and
- zero is not a valid sequence number.

Examples:

| Value | Canonical suffix | Valid ID example |
|---:|---:|---|
| 1 | `001` | `REQ-001` |
| 42 | `042` | `REQ-042` |
| 999 | `999` | `REQ-999` |
| 1000 | `1000` | `REQ-1000` |

`REQ-1`, `REQ-01`, `REQ-000`, and `REQ-0001` are invalid.

The sequence number is an opaque identity component. It does not encode
priority, chronology, hierarchy, lifecycle, or semantic relationships. Tools
MUST NOT derive those meanings from numeric order.

## Rules

### PROJECT singleton

Every initialized EF project MUST contain exactly one PROJECT Artifact. Its ID
MUST be `PROJECT`, and its canonical filename MUST be `PROJECT.md`.

`PROJECT-001` and any other PROJECT ID are invalid. A second PROJECT Artifact is
invalid even if it uses a different filename or contains identical content.

The bootstrap operation that initializes an EF project MUST create the PROJECT
Artifact atomically with the minimum required project structure.

### ID immutability and permanent retention

Once an ID is issued:

- its value MUST NOT change;
- it MUST NOT be assigned to another Artifact;
- it remains reserved in every lifecycle state;
- retirement or supersession MUST NOT release it; and
- its Artifact MUST remain in the authoritative files rather than be physically
  deleted to release or conceal the identity.

Changing a title, body, status, relation, resource, or directory path does not
change Artifact identity. Whether such content changes are legal in a given
lifecycle state is defined by the lifecycle and change-transaction
specifications.

An operation that fails before creating a valid Artifact transaction does not
issue an ID. Temporary files used to implement an atomic creation operation are
not Artifacts and do not reserve identity.

### No reuse

An issued ID MUST never be reused, including when its Artifact is no longer
current. There is no reusable pool of retired or superseded numbers.

Because issued Artifacts remain in authoritative files, current-graph identity
validation is the required v1 mechanism for preventing reuse. Git-history reuse
detection MAY be provided as an additional strict integrity check, but is not a
required v1 validation step.

### Filename and path

The canonical filename of an Artifact is its exact ID followed by lowercase
`.md`:

```text
<ID>.md
```

Examples:

```text
PROJECT.md
PRD-012.md
REQ-031.md
ADR-022.md
POL-006.md
CHG-182.md
```

The basename MUST match the frontmatter `id` byte for byte. Title slugs and
other suffixes are forbidden. The extension MUST be lowercase `.md`.

The directory path is not part of identity, but EF Core v1 defines exactly one
canonical path for each Artifact type. A path change that leaves an Artifact
outside that canonical location is invalid.

Each formal Artifact file MUST contain exactly one Artifact.

### Rename rules

Changing `title` does not rename the file because the filename is derived only
from `id`.

An issued ID has no rename or rekey operation. Correcting an identity mistake
after integration requires a new Artifact identity and the appropriate
lifecycle or supersession treatment for the old Artifact.

A provisional ID MAY be replaced solely before authoritative integration. The
replacement operation MUST update, as one atomic change:

- the frontmatter `id`;
- the filename;
- every relation targeting or originating from the provisional ID;
- every CHG reference to the provisional ID; and
- any other structured reference governed by EF.

The complete mutation transaction is validated before it replaces the original
provisional state.

### Allocation

Sequence numbers are allocated independently for `PRD`, `REQ`, `ADR`, `POL`,
and `CHG`.

The default allocator MUST:

1. inspect every authoritative and current provisional Artifact visible in the
   working graph for the requested prefix;
2. find the greatest canonical numeric component;
3. select the next integer;
4. verify that the candidate ID and filename are unused; and
5. create the Artifact atomically.

The allocator MUST NOT fill numeric gaps. For example, if `REQ-041`, `REQ-042`,
and `REQ-044` exist, the next allocated requirement ID is `REQ-045`, not
`REQ-043`.

Numeric comparison and increment use arbitrary-precision positive decimal
integers. An implementation MUST NOT impose a machine-integer limit that would
make the next canonical ID differ across implementations. If it cannot process
the greatest visible component exactly, allocation is incomplete and does not
issue an ID.

Lifecycle state does not affect allocation. A retired or superseded
`REQ-045` still contributes to the maximum and remains reserved.

Allocation state, counters, caches, and indexes are derived data. They MUST NOT
become an authoritative identity registry separate from Artifact files.

Explicit ID assignment, legacy import, and identity migration are not EF Core
v1 operations. A non-Core import tool MAY prepare proposed files, but its result
MUST satisfy all uniqueness, canonical form, prefix, and non-reuse requirements
before integration. General interactive creation MUST use the default allocator.

### Parallel branch collisions

Sequential allocation cannot guarantee collision-free provisional IDs across
offline or parallel branches. Two branches can independently create the same
candidate ID:

```text
branch A: REQ-045
branch B: REQ-045
```

Such a collision MUST block integration. Tooling MUST NOT select a winner based
on path, timestamp, Git order, content, or lifecycle state.

The Artifact integrated first issues the ID. Before another colliding branch
can integrate, its still-provisional Artifact MUST receive the next available
ID through the atomic replacement operation. All affected references MUST be
updated and the complete graph MUST be revalidated.

This provisional collision repair does not violate issued-ID immutability or
non-reuse because the losing candidate never entered authoritative integration
history.

### Duplicate handling

Two files with the same Artifact ID are invalid even when their contents are
identical. Duplicate identity is always an error.

While an ID is duplicated:

- relations to that ID are ambiguous;
- graph validation MUST NOT resolve the ID to either file;
- tooling MUST NOT infer a canonical copy; and
- integration MUST be blocked.

Resolution requires an explicit choice. An issued Artifact retains its ID. A
colliding provisional Artifact must be atomically assigned a new candidate ID.

The same numeric component under different type prefixes is not a duplicate;
for example, `REQ-001` and `ADR-001` are distinct IDs.

### Custom prefixes

EF Core v1 does not permit custom aliases or replacements for core prefixes.
Configuration MUST NOT change `REQ-` to `R-`, `ADR-` to `DEC-`, or otherwise
alter the type-to-prefix mapping.

Extension fields do not create new Artifact types or identity prefixes. Future
custom Artifact types require a separate namespaced extension specification.

## Examples

### Valid identities

```yaml
---
schema: ef/project@1
type: project
id: PROJECT
title: Engineering Files
status: active
summary: Engineering Files manages authoritative engineering knowledge as Git-native files.
tags: []
relations: []
resources: []
---
```

```yaml
---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
---
```

### Invalid prefix for type

```yaml
schema: ef/requirement@1
type: requirement
id: ADR-031
```

The ID uses the decision prefix for a requirement.

### Invalid filename

For an Artifact with `id: REQ-031`, these filenames are invalid:

```text
search-result-filtering.md
REQ-031-search-result-filtering.md
req-031.md
REQ-031.MD
```

The only valid basename is `REQ-031.md`.

### Invalid reuse

An issued `REQ-031` originally describes payment timeout behavior and later
becomes superseded. A new search-filtering requirement MUST NOT use `REQ-031`.
It receives a new ID even though the earlier requirement is no longer current.

### Valid allocation with gaps

Given:

```text
REQ-041  active
REQ-042  superseded
REQ-043  retired
REQ-044  active
```

The next ID is `REQ-045`. Neither lifecycle state nor non-current status makes a
number reusable.

## Validation

Identity validation operates over the complete authoritative project graph,
not only an individual file. It MUST check syntax, type compatibility,
filenames, singleton constraints, and graph-wide uniqueness.

The identity diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-ID-001` | error | Missing or malformed Artifact ID |
| `EF-ID-002` | error | ID prefix does not match Artifact type |
| `EF-ID-003` | error | Non-canonical or zero numeric component |
| `EF-ID-004` | error | Duplicate Artifact ID |
| `EF-ID-005` | error | Filename does not exactly match Artifact ID |
| `EF-ID-006` | error | More than one PROJECT Artifact |
| `EF-ID-007` | error | Missing PROJECT Artifact in an initialized project |
| `EF-ID-008` | error | PROJECT uses an ID other than `PROJECT` |
| `EF-ID-009` | error | Issued ID was transferred or reused |
| `EF-ID-010` | error | Issued Artifact ID was changed |
| `EF-ID-011` | error | Unsupported or customized core prefix |
| `EF-ID-012` | error | Provisional branch collision blocks integration |
| `EF-ID-013` | error | ID replacement did not update all structured references atomically |

Tools SHOULD report all files participating in a duplicate and SHOULD identify
whether an authoritative issued Artifact or only provisional candidates are
involved when integration context is available.

## Deferred

- The configured authoritative integration history and repository root are
  defined in Phase 11: Filesystem and Configuration.
- Lifecycle states, allowed content mutation, terminal-state immutability, and
  retirement are defined in Phase 3: Lifecycle.
- Supersession identity continuity and replacement graphs are defined in Phase
  5: Supersession and Canonical State.
- Atomic CHG mutation requirements are defined in Phase 7: CHG Transaction
  Semantics.
- Cross-project locators and external Artifact address formats are not part of
  EF Core v1.
- Import, identity migration, and explicit legacy-ID assignment are not part of
  EF Core v1.
- Full Git-history identity reuse auditing is optional, has no standard Core v1
  policy or CLI, and does not replace current-graph retention and transition
  validation.
- Namespaced custom Artifact types and their identity policy are not part of EF
  Core v1.
