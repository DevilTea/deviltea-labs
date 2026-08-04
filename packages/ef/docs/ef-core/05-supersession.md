# EF Core: Supersession and Canonical State

Status: Accepted

## Scope

This document defines EF Core v1 supersession topology, one-to-one,
one-to-many, many-to-one and many-to-many replacement, current canonical-state
resolution, replacement chains, historical preservation, relation behavior,
graph validation, and atomic supersession mutation.

It uses the lifecycle and `superseded-by` relation defined by earlier EF Core
specifications. It does not add revision numbers, canonical flags, replacement
group objects, or stored inverse edges.

## Definitions

### Supersession

Supersession is the atomic transition in which one or more active Artifacts stop
being current truth because one or more active Artifacts replace them.

Every replacement edge is stored in the historical Artifact:

```text
old Artifact --superseded-by--> replacement Artifact
```

### Supersession source

A supersession source is an Artifact that transitions from `active` to
`superseded`. After the transition it stores the complete outgoing
`superseded-by` replacement set and becomes frozen.

### Replacement set

The replacement set of a superseded Artifact is the non-empty set of its direct
`superseded-by` targets.

When the set contains more than one target, the targets collectively replace
the source. They are not alternatives, candidates, or an ordered preference
list. A consumer MUST NOT select one target as a winner.

### Direct replacement

A direct replacement is a target named by one `superseded-by` edge. It records
the next historical state transition, not necessarily the current end of a
later replacement chain.

### Current resolution

Current resolution traverses zero or more `superseded-by` edges and returns the
set of reachable active Artifacts. It does not rewrite or flatten the
authoritative relation graph.

### Current canonical set

The current canonical set of an EF project is every PROJECT, PRD, REQ, ADR, and
POL whose status is `active`. CHG is never part of this set.

The current canonical set is determined by lifecycle status, not by incoming
supersession edges or a second canonical flag.

## Schema

Supersession adds no frontmatter field or nested object. It uses only the
existing lifecycle status and relation entry:

```yaml
---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: superseded
summary: Search results support the original content-type filtering contract.
tags: []
relations:
  - type: superseded-by
    target: REQ-070
resources: []
---
```

The following fields are not part of EF Core v1:

```text
canonical
current
revision
replacement-group
supersedes
```

Canonical state and replacements are derived from `status` and
`superseded-by`.

## Rules

### Supersession invariants

A valid supersession MUST satisfy all of these conditions:

- Every source was `active` immediately before the transition.
- Every source is `superseded` immediately after the transition.
- Every source has at least one outgoing `superseded-by` edge afterward.
- Every direct replacement is `active` when the transition completes.
- Every source and each of its replacements have the same Artifact type.
- No PROJECT or CHG participates as a supersession source or replacement.
- The resulting `superseded-by` graph is acyclic.
- One completed CHG records the complete atomic transition.

A direct replacement MAY already be active before the transaction. A
supersession does not require every replacement to be newly created.

### One-to-one replacement

One source can have one direct replacement:

```text
REQ-031 --superseded-by--> REQ-070
```

```yaml
# REQ-031.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-070
```

Current resolution of `REQ-031` returns `REQ-070` while `REQ-070` is active.

### One-to-many replacement

One source can be split into multiple replacements:

```text
REQ-031 --superseded-by--> REQ-071
REQ-031 --superseded-by--> REQ-072
```

```yaml
# REQ-031.md
status: superseded
relations:
  - type: superseded-by
    target: REQ-071
  - type: superseded-by
    target: REQ-072
```

`REQ-071` and `REQ-072` are a collective replacement set. Current resolution
returns both. A consumer MUST NOT select only one unless a later specification
or explicit user query asks for a narrower result outside canonical resolution.

### Many-to-one replacement

Multiple sources can be consolidated into one replacement:

```text
REQ-014 --superseded-by--> REQ-070
REQ-022 --superseded-by--> REQ-070
REQ-041 --superseded-by--> REQ-070
```

Each source stores its own outgoing edge and transitions to `superseded` in the
same CHG transaction. Current resolution of any source returns `REQ-070` while
it remains active.

### Many-to-many replacement

The graph model naturally permits many-to-many replacement without an
additional replacement-group schema:

```text
REQ-014 --superseded-by--> REQ-070
REQ-014 --superseded-by--> REQ-071
REQ-022 --superseded-by--> REQ-070
REQ-022 --superseded-by--> REQ-072
```

Each source's outgoing target set collectively replaces that source. The CHG
binds the related source transitions and replacement activation into one
engineering transaction.

### Canonical-state predicate

An Artifact is current canonical truth exactly when:

```text
type is project, prd, requirement, decision, or policy
AND
status is active
```

Therefore:

| Status or type | Current canonical truth |
|---|---:|
| PROJECT with `active` | Yes |
| PRD, REQ, ADR, or POL with `active` | Yes |
| `draft` | No |
| `superseded` | No |
| `retired` | No |
| CHG with any status | No |

An incoming `superseded-by` edge does not itself make a replacement current.
The replacement must be `active`.

### Current-resolution algorithm

For PRD, REQ, ADR, and POL, current resolution is defined recursively:

```text
resolve-current(A):
  if A.status is active:
    return {A}

  if A.status is superseded:
    return union(resolve-current(T) for each direct replacement T)

  if A.status is draft or retired:
    return {}
```

Additional requirements:

- Results MUST be deduplicated by Artifact ID.
- Results MUST be returned in bytewise Artifact ID order.
- Multiple results are expected and MUST NOT be collapsed to one result.
- PROJECT does not require supersession traversal because PROJECT is always
  active in v1.
- CHG is not canonical knowledge; current resolution of CHG is an unsupported
  operation.
- An invalid or incomplete graph causes resolution to fail rather than return a
  partial result that appears authoritative.

The stable machine-output representation is defined by the query and trace
specification.

### Replacement chains

A replacement may later be superseded:

```text
REQ-031 --superseded-by--> REQ-070
REQ-070 --superseded-by--> REQ-091
```

Current resolution follows the complete chain:

```text
resolve-current(REQ-031) = {REQ-091}
```

The edge from `REQ-031` to `REQ-070` MUST remain unchanged. Tooling MUST NOT
flatten it to point directly to `REQ-091`. Each edge preserves the actual
historical transition.

### Retired replacement leaves

A replacement can later be retired without another replacement:

```text
REQ-031 --superseded-by--> REQ-070
REQ-070 status: retired
```

Current resolution of `REQ-031` then returns an empty set. This is valid and
means that the engineering truth represented by the chain is no longer current
and has no current replacement.

`REQ-031` remains `superseded`, because the historical fact is that `REQ-070`
replaced it. The later retirement of `REQ-070` does not rewrite the earlier
transition.

### Cycle prohibition

Self-replacement and every direct or indirect supersession cycle are invalid:

```text
REQ-031 -> REQ-031
REQ-031 -> REQ-070 -> REQ-031
REQ-031 -> REQ-070 -> REQ-091 -> REQ-031
```

Cycle validation MUST use the complete graph that would exist after the
transaction. If a cycle exists, the transaction is invalid, its CHG MUST NOT be
completed, and current resolution MUST fail.

### Atomic supersession mutation

A supersession transaction MUST make all of these changes visible atomically:

- every source status changes from `active` to `superseded`;
- every source receives its complete direct replacement set;
- every direct replacement is active;
- relation compatibility and target existence hold;
- the resulting graph is acyclic;
- the CHG effects match the before-and-after graph; and
- the CHG becomes `completed`.

There MUST be no authoritative intermediate state in which a superseded source
has no replacement, a replacement is not active, only part of a collective set
exists, or CHG provenance disagrees with the graph.

For a newly created one-to-one replacement, a typical completed graph is:

```text
CHG-182 --introduces------> REQ-070
CHG-182 --modifies--------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

When the replacement already exists and is not modified, the CHG records only
the source modification:

```text
CHG-183 --modifies--------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

Filesystem implementation of atomic mutation is defined by later phases. Every
authoritative committed state MUST satisfy the completed invariants.

### Complete and immutable replacement set

The complete direct replacement set MUST be established by the supersession
transaction. After the transition completes, the source is terminal and frozen.
Its outgoing replacement set MUST NOT be added to, removed from, reordered, or
retargeted.

An error discovered after integration cannot be repaired by rewriting the
frozen historical source. It requires a new engineering transition that
corrects the current replacement chain while preserving the recorded history.

This immutability can require an additional replacement Artifact in a
correction scenario. That cost is intentional: accepted historical transitions
are not silently rewritten.

### Historical preservation

After supersession:

- every source file remains in the authoritative repository;
- each source preserves its historical title, summary, body, resources, and
  non-supersession relations;
- the terminal transition adds only its final status, complete replacement set,
  and required transition rationale or provenance;
- the source becomes fully frozen after the transition;
- old edges are never flattened to the latest active leaves;
- replacement content is not copied into historical sources; and
- previous CHG records are never rewritten.

Derived indexes MAY cache incoming edges, replacement paths, and active leaves.
Those caches are not authoritative and can always be rebuilt from Artifact
files.

### No implicit inheritance

A replacement does not implicitly inherit any source data or semantics,
including:

- `derived-from`, `addresses`, `governed-by`, or `references` relations;
- tags;
- resources;
- title or summary; or
- Markdown body content.

Every relation, resource, and statement that remains applicable MUST be written
explicitly into the replacement Artifact as part of the transaction.

For example:

```text
REQ-031 --governed-by-----> POL-006
REQ-031 --superseded-by---> REQ-070
```

does not imply:

```text
REQ-070 --governed-by-----> POL-006
```

The latter edge exists only if it is explicitly stored in `REQ-070`.

### No implicit retargeting

Existing relations to a source remain exact historical references and are not
automatically changed to its replacements.

For example:

```text
ADR-022 --addresses-------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

does not imply or create:

```text
ADR-022 --addresses-------> REQ-070
```

A query MAY report that `REQ-031` currently resolves to `REQ-070`, but creating
a new `addresses` edge requires an explicit valid mutation. This rule preserves
the fact that ADR-022 originally addressed REQ-031 and avoids modifying frozen
historical Artifacts.

The same rule applies to `derived-from`, `governed-by`, and `references`.

### Lifecycle of relation targets

Relation validity at creation time is distinct from a target's later lifecycle
transition.

- `references` MAY target any lifecycle state.
- `derived-from` MAY target superseded or retired history because derivation is
  provenance.
- A newly created `addresses` edge MUST target an active REQ.
- A newly created `governed-by` edge MUST target an active POL.
- A newly created `superseded-by` edge MUST target an active same-type Artifact.

If an `addresses` or `governed-by` target later becomes non-current, the
existing edge remains historically valid. It is not automatically retargeted,
and its source is not retroactively invalidated. Any new current semantic
relationship must be recorded explicitly.

## Examples

### Split with later independent evolution

Initial split:

```text
REQ-031 --superseded-by--> REQ-071 active
REQ-031 --superseded-by--> REQ-072 active
```

Later, `REQ-071` is replaced:

```text
REQ-071 --superseded-by--> REQ-091 active
```

Current resolution is:

```text
resolve-current(REQ-031) = {REQ-072, REQ-091}
```

`REQ-031` remains unchanged and continues pointing to its direct replacements.

### Converging paths

```text
REQ-031 -> REQ-071 -> REQ-091
        -> REQ-072 -> REQ-091
```

Both paths reach the same active leaf. Current resolution deduplicates the
result:

```text
resolve-current(REQ-031) = {REQ-091}
```

### No current replacement

```text
REQ-031 superseded-by REQ-070
REQ-070 retired
```

```text
resolve-current(REQ-031) = {}
```

This is not an integrity error.

### Existing active consolidation target

Before:

```text
REQ-031 active
REQ-070 active
CHG-183 draft
```

After:

```text
REQ-031 superseded-by REQ-070
REQ-031 superseded
REQ-070 active and unchanged
CHG-183 completed, modifies REQ-031
```

No new replacement Artifact is required.

## Validation

Supersession validation checks the complete current graph and, for mutation
validation, the previous authoritative graph and the proposed atomic result.

The supersession diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-SUP-001` | error | Superseded Artifact has no direct replacement |
| `EF-SUP-002` | error | Non-superseded Artifact declares `superseded-by` |
| `EF-SUP-003` | error | Source and replacement Artifact types differ |
| `EF-SUP-004` | error | Direct replacement was not active when transition completed |
| `EF-SUP-005` | error | Direct or indirect supersession cycle |
| `EF-SUP-007` | error | Frozen direct replacement set was modified |
| `EF-SUP-013` | error | Existing relation was implicitly retargeted during supersession |

Validation MUST NOT treat multiple active leaves as ambiguity. Multiple leaves
are the expected result of one-to-many and many-to-many replacement.

Validation of historical target state at the moment of transition requires
repository integration history or a trusted previous-state snapshot. A
standalone current-graph validator can still check current IDs, types, edges,
cycles, and terminal source invariants.

## Deferred

- Resource ownership and replacement-resource handling are defined in [Resource Schema](06-resources.md). Resources remain non-inherited unless that specification
  explicitly defines a narrower rule.
- CHG completion criteria, before-and-after comparison, supersession rationale,
  correction transactions, and filesystem atomicity are defined in [CHG Transaction Semantics](07-change-transactions.md).
- Artifact-specific replacement rationale sections are defined in [Artifact Body Schemas](08-artifact-schemas.md).
- Repository-history validation, previous-state snapshots, diagnostic modes,
  and integration checks are defined in [Validation and Integrity](09-validation.md).
- Stable current-resolution output, replacement paths, trace traversal, and
  impact queries are defined in [Query and Trace](10-query-and-trace.md).
- Physical atomic-write strategy and integration-ref configuration are
  defined in [Filesystem and Configuration](11-filesystem-and-config.md).
