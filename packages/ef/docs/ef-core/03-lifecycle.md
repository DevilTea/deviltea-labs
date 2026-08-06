# EF Core: Artifact Lifecycle

Status: Accepted

## Scope

This document defines the minimal EF Core v1 lifecycle vocabulary, the statuses
allowed for each Artifact type, legal transitions, current canonical state,
state-dependent immutability, retention, and lifecycle validation.

Review workflow, repository administration, deployment phases, and project
management states are outside the EF Core lifecycle.

## Definitions

### Lifecycle

Lifecycle describes whether an Artifact is being authored, is current
canonical engineering truth, or has reached a permanent historical state.

Lifecycle does not model review queues, approval mechanisms, implementation
progress, deployment, maintenance activity, or repository hosting state.

### Status vocabulary

EF Core v1 defines exactly five statuses:

| Status | Meaning |
|---|---|
| `draft` | The Artifact has not become current canonical truth. |
| `active` | The Artifact is current canonical truth. |
| `superseded` | The Artifact is no longer current because replacement Artifacts exist. |
| `retired` | The Artifact is closed and non-current without a replacement. |
| `completed` | A CHG transaction completed successfully. |

No aliases or case variants are valid.

### Current canonical state

An Artifact is current canonical engineering truth exactly when:

```text
type is project, prd, requirement, decision, or policy
AND
status is active
```

CHG is provenance and execution history. It is never current canonical truth,
regardless of status.

### Terminal state

`superseded`, `retired`, and `completed` are terminal states. A terminal
Artifact is frozen, remains in the authoritative files permanently, and has no
outgoing lifecycle transitions.

## Schema

### Status applicability

| Artifact | Allowed statuses |
|---|---|
| PROJECT | `active` |
| PRD | `draft`, `active`, `superseded`, `retired` |
| REQ | `draft`, `active`, `superseded`, `retired` |
| ADR | `draft`, `active`, `superseded`, `retired` |
| POL | `draft`, `active`, `superseded`, `retired` |
| CHG | `draft`, `completed`, `retired` |

A status that exists in the vocabulary but is not allowed for the Artifact type
is invalid. For example, an ADR uses `active`, not `accepted`, and a CHG cannot
use `active`.

### Transition sets

PRD, REQ, ADR, and POL allow exactly these transitions:

```text
draft  -> active
draft  -> retired
active -> superseded
active -> retired
```

CHG allows exactly these transitions:

```text
draft -> completed
draft -> retired
```

PROJECT has no lifecycle transition. It is created as `active` by project
initialization and remains `active`.

Setting a status to its existing value is not a lifecycle transition. Any
content mutation performed while the status is unchanged is governed by the
immutability rules below and by CHG transaction semantics.

### First authoritative appearance

An Artifact's change from absent in the trusted baseline to present in the
proposed authoritative state is its first authoritative appearance, not a
lifecycle transition.

- PRD, REQ, ADR, and POL MAY first appear as `draft` or `active`.
- A knowledge Artifact that first appears as `active` requires a completed CHG
  `introduces` effect, except during bootstrap.
- Knowledge Artifacts MUST NOT first appear as `superseded` or `retired`.
- A CHG MAY first appear as `draft`, `completed`, or `retired`; provisional
  authoring may have occurred outside authoritative history.
- PROJECT first appears only through the bootstrap rule below.

After first appearance, every status change follows the transition sets above.
The CHG self-effect exception still applies when a CHG first appears already
terminal.

## Rules

### `draft`

`draft` means that an Artifact is being authored and has never become current
canonical truth.

- Draft content MAY be edited without creating a CHG.
- Its `type` remains immutable.
- Its `id` remains immutable except for the pre-integration provisional
  collision-repair operation defined by Artifact Identity.
- Current-truth queries MUST exclude it.
- It MAY become `active`.
- It MAY become `retired` when work stops without activation.
- It MUST NOT be physically deleted after its identity is issued.

EF Core does not distinguish proposed, rejected, abandoned, or cancelled draft
workflow states. Review and approval can be enforced by Git workflow or POL.
The reason for retiring a draft belongs in the Artifact body or related CHG,
not in a lifecycle status.

### `active`

`active` means that PROJECT, PRD, REQ, ADR, or POL is authoritative current
engineering truth.

- Current-truth queries MUST include it.
- Every serialized-content mutation MUST be applied through a CHG transaction.
- It MAY become `superseded` when explicit replacements exist.
- It MAY become `retired` when it stops applying without a replacement.
- It MUST NOT return to `draft`.

For ADR, `active` means that the decision is accepted and currently applicable.
The separate status `accepted` is intentionally not part of EF Core.

EF Core does not define a `deprecated` status. An Artifact remains `active`
while its engineering contract is still in force. Migration intent, discouraging
new dependencies, and planned sunset behavior are expressed in canonical
Artifacts and policies. The Artifact becomes `superseded` or `retired` only
when it ceases to be current truth.

### `superseded`

`superseded` means that an Artifact was active and has been replaced by one or
more Artifacts.

- It is not current canonical truth.
- It MUST have a valid replacement relation established by the same atomic
  transition that changes its status.
- It MUST have previously been `active`.
- It is terminal and frozen.
- It MUST remain in the authoritative files permanently.

Replacement topology, relation vocabulary, one-to-many and many-to-one cases,
and canonical-state resolution are defined by the relations and supersession
specifications.

### `retired`

`retired` means that an Artifact is closed, is not current canonical truth, and
has no replacement.

- A draft MAY be retired without ever becoming current truth.
- An active Artifact MAY be retired when it stops applying without a
  replacement.
- A CHG MAY be retired when it will not complete.
- It MUST NOT declare a direct replacement; an Artifact with replacements is
  superseded instead.
- It is terminal and frozen.
- It MUST remain in the authoritative files permanently.

EF Core intentionally uses `retired` for rejected, abandoned, cancelled, and
formerly-active work that closes without replacement. The detailed reason is
preserved in the body, relations, CHG provenance, or Git history.

### `completed`

`completed` applies only to CHG. It means that the transaction successfully and
atomically produced the authoritative state it records.

- Partial success MUST NOT be marked `completed`.
- A completed CHG is execution history, not current canonical truth.
- It is terminal and frozen.
- It MUST remain in the authoritative files permanently.

Completion criteria, verification evidence, failed transactions, and atomic
mutation behavior are defined in the CHG transaction specification.

### PROJECT lifecycle

Project initialization MUST create PROJECT directly as `active` in the same
atomic operation that establishes a valid EF project. PROJECT is not exposed as
a formal `draft` Artifact.

PROJECT remains `active` for the lifetime of the EF project. Repository
archival, paused maintenance, ownership changes, and similar administrative
conditions do not change PROJECT status. They do not change the last
authoritative project definition stored by EF.

### State-dependent immutability

Lifecycle has three mutation classes:

| State | Content mutation policy |
|---|---|
| `draft` | Mutable during authoring; `id` and `type` remain immutable. |
| `active` | Every serialized-content mutation requires a CHG transaction. |
| `superseded`, `retired`, `completed` | Fully frozen after the terminal transition completes. |

The terminal transition itself MAY atomically add the status, required
relations, rationale, and transaction metadata. Once that transaction
completes, neither frontmatter nor body may be edited in place.

How purely editorial changes to active Artifacts are recorded is defined by the
CHG transaction specification. Identity fields remain governed by the stricter
identity rules in every lifecycle state.

### Retention and deletion

An issued formal Artifact MUST NOT be physically deleted. Lifecycle transition
is the only supported removal mechanism:

| Intent | Required result |
|---|---|
| Stop unfinished work | `draft -> retired` |
| Activate current truth | `draft -> active` |
| Replace current truth | `active -> superseded` |
| End current truth without replacement | `active -> retired` |
| Finish a CHG successfully | `draft -> completed` |
| Close a CHG without completion | `draft -> retired` |

Provisional identity collision repair remains governed by the identity
specification and occurs before an ID enters authoritative integration history.

### Transition atomicity

A lifecycle transition and every invariant required by its destination state
MUST become visible atomically.

For example, an active Artifact MUST NOT be committed as `superseded` before
its replacement relation and replacement Artifacts are valid. A CHG MUST NOT be
committed as `completed` before all state changes and required evidence are
consistent with its record.

Activation, mutation of active truth, supersession, and active retirement MUST
be traceable through CHG. Project bootstrap and the lifecycle of CHG itself are
the necessary exceptions; a CHG does not require another CHG to complete its
own transaction.

Draft editing and `draft -> retired` do not require CHG because the Artifact
never became canonical truth. A project or POL MAY impose stronger governance.

## Examples

### Draft requirement

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

The requirement is a formal Artifact with an issued identity, but it is not
current canonical truth.

### Active ADR

```yaml
---
schema: ef/decision@1
type: decision
id: ADR-022
title: Use SQLite for the Local Relation Index
status: active
summary: The derived local relation index uses SQLite for transactional updates and portable queries.
tags: []
relations: []
resources: []
---
```

`active` means that this ADR is accepted and currently applicable.

### Superseded requirement

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

The relation entry is illustrative until the relations and supersession
specifications define its final vocabulary and shape.

### Retired draft

```yaml
---
schema: ef/decision@1
type: decision
id: ADR-024
title: Store the Canonical Graph in SQLite
status: retired
summary: This proposal considered SQLite as the authoritative graph store instead of repository files.
tags: []
relations: []
resources: []
---

## Context

## Decision

## Alternatives

## Consequences

## Lifecycle

The proposal was closed because repository files remain the sole authoritative
source of truth.
```

This Artifact never became active. EF does not need a distinct rejected or
abandoned status to preserve the outcome. The required core headings remain
present under the body schema; a draft retired before activation may leave
their content incomplete.

### Completed CHG

```yaml
---
schema: ef/change@1
type: change
id: CHG-182
title: Replace the Search Filtering Contract
status: completed
summary: The search filtering requirement was replaced with a consolidated observable contract.
tags: []
relations:
  - type: introduces
    target: REQ-070
  - type: modifies
    target: REQ-031
resources: []
---

## Rationale

Replace overlapping filtering requirements with one observable contract.

## Sources

- Direct maintainer review of the existing filtering requirements.

## Changes

- Introduced REQ-070 as the consolidated filtering contract.
- Superseded REQ-031 with REQ-070.

## Verification

Result: passed

- EF transition validation passed.
```

The complete effect relation semantics are defined by the CHG transaction and
relations specifications.

### Invalid transitions

All of these transitions are invalid:

```text
active     -> draft
retired    -> active
superseded -> active
completed  -> draft
draft CHG  -> active
active REQ -> completed
```

## Validation

Lifecycle validation checks both the current graph and, when validating a
mutation, the transition from the previous authoritative state.

The lifecycle diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-LIFE-001` | error | Unknown lifecycle status |
| `EF-LIFE-002` | error | Status is not allowed for the Artifact type |
| `EF-LIFE-003` | error | Illegal lifecycle transition or prohibited first authoritative status |
| `EF-LIFE-004` | error | Frozen terminal Artifact was modified |
| `EF-LIFE-009` | error | Issued Artifact was physically deleted |

Supersession topology uses `EF-SUP-*` diagnostics. CHG completion, provenance,
and effect coverage use `EF-CHG-*` diagnostics. This namespace does not emit a
second alias for those findings.

A standalone file validator can check status vocabulary and type compatibility.
Transition, mutation, provenance, deletion, and supersession validation require
the previous authoritative graph or repository integration context.

## Deferred

- Relation vocabulary and the representation of replacement relations are
  defined in [Relations Ontology](04-relations.md).
- Supersession topology, canonical replacement resolution, and cycle rules are
  defined in [Supersession and Canonical State](05-supersession.md).
- CHG completion criteria, active editorial changes, provenance, and atomic
  transaction behavior are defined in [CHG Transaction Semantics](07-change-transactions.md).
- Required lifecycle rationale sections are defined in [Artifact Body Schemas](08-artifact-schemas.md).
- Previous-state discovery, Git-aware validation, diagnostic aggregation, and
  exit behavior are defined in [Validation and Integrity](09-validation.md).
- Repository archival and administrative maintenance state are outside the
  Artifact lifecycle. Their configuration, if needed, belongs to [Filesystem and Configuration](11-filesystem-and-config.md).
- Review and approval requirements are project governance expressed through
  Git workflow or POL, not additional EF Core lifecycle states.
