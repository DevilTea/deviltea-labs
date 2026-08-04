# EF Core: CHG Transaction Semantics

Status: Accepted

## Scope

This document defines when a CHG is required or may be omitted, CHG lifecycle
semantics, introduced, modified and retired effects, exactly-once effect
coverage, Resource mutation, completion criteria, rationale, source provenance,
verification attestation, failed and abandoned changes, Git integration, and
atomicity.

It also defines the boundary between deterministic validation of repository
facts and human or CI attestation of external engineering facts.

Exact Artifact body templates beyond the required CHG transaction sections are
defined by the Artifact body schema specification.

## Definitions

### Engineering transaction

An engineering transaction is one atomic transition from a valid authoritative
EF project state to another valid authoritative EF project state.

The transaction includes every Artifact, relation, lifecycle, Resource, and
provenance change required to make the resulting graph complete and valid.

### CHG

A CHG is the immutable provenance record of an engineering transaction after it
completes, or of an unfinished transaction after it is retired.

CHG does not contain current engineering truth. The current truth produced by a
completed CHG is stored in the affected canonical Artifacts and their owned
Resources.

### Authoritative integration boundary

The authoritative integration boundary is the point at which proposed Git work
enters the configured authoritative project history. Validation compares the
valid baseline commit before this boundary with one explicit proposed commit
after it.

Feature-branch commits may contain intermediate draft work. Every state that
enters authoritative integration history MUST satisfy the transaction and
graph invariants.

### Effect relation

An effect relation is a factual `introduces`, `modifies`, or `retires` relation
stored by a completed CHG. It records the net effect of that transaction on one
Artifact owner.

### Artifact aggregate state

For transaction diffing, an Artifact's aggregate state consists of:

- its complete Artifact file content, including envelope, body, and Resource
  descriptors;
- its owned local Resource file content and presence; and
- its identity-preserving repository presence.

A changed owned Resource changes the owner's aggregate state even when the
Artifact Markdown file itself is byte-identical.

The PROJECT aggregate additionally includes `.engineering/ef.yaml` and
`.engineering/.gitignore`. A change to either control file therefore changes
PROJECT aggregate state even when `PROJECT.md` is byte-identical.

### Verification attestation

A verification attestation is the CHG author's or CI system's declaration that
external verification passed or was not applicable. EF validates the
attestation's structure and supporting repository evidence, but does not claim
to prove every external engineering assertion automatically.

## Schema

### CHG envelope

CHG uses the common Artifact envelope:

```yaml
---
schema: ef/change@1
type: change
id: CHG-182
title: Replace the Search Filtering Contract
status: completed
summary: The original search requirement was replaced by one consolidated observable contract.
tags: []
relations:
  - type: introduces
    target: REQ-070
  - type: modifies
    target: REQ-031
resources: []
---
```

No CHG-specific top-level frontmatter fields are added by this specification.
Rationale, sources, human-readable changes, and verification are stored in
required Markdown sections. Machine-readable effects remain relation entries.

### Required completed-CHG body sections

A completed CHG body contains exactly one section with each of these level-two
headings:

```text
## Rationale
## Sources
## Changes
## Verification
```

The sections MAY contain natural Markdown. Only the minimal structures defined
below are parsed as machine markers.

### Verification result marker

The first non-empty paragraph in `## Verification` uses the exact form:

```text
Result: passed
```

or:

```text
Result: not-applicable
```

For a retired CHG it uses:

```text
Result: not-completed
```

For a draft CHG, the Verification section MAY be absent. If present before
completion, it MAY use:

```text
Result: pending
```

Result values are lowercase and case-sensitive. They are body-schema markers,
not additional lifecycle states.

## Rules

### CHG-required mutations

A CHG is required for every authoritative mutation of current canonical truth,
including:

- creation of an Artifact directly as active;
- `draft -> active`;
- `active -> superseded`;
- `active -> retired`;
- any content change to an active Artifact file;
- any active frontmatter, body, tag, relation, or Resource descriptor change;
- any content, location, addition, or removal change to a local Resource owned
  by an active Artifact;
- any PROJECT content or Resource change, including a change to canonical
  Terminology;
- any `.engineering/ef.yaml` or `.engineering/.gitignore` change, attributed to
  PROJECT; and
- any atomic supersession operation.

Any committed serialized-content change to an active Artifact requires CHG,
including spelling, grammar, formatting, canonical reordering, or other
editorial corrections. EF Core does not ask a validator to decide whether an
editorial change altered semantics.

Multiple related editorial corrections MAY be batched into one coherent CHG.

### CHG-optional mutations

A CHG is not required for:

- creation or editing of a draft Artifact;
- `draft -> retired`;
- creation or editing of a draft CHG;
- `draft CHG -> retired`;
- atomic project bootstrap;
- provisional ID collision repair before authoritative integration; or
- rebuilding derived caches, indexes, search data, or rendered output.

A CHG MAY record introduction or retirement of draft work when provenance is
useful. If it does, every declared effect MUST still match the actual
transaction. Draft work that is validly omitted from CHG coverage does not
violate exactly-once coverage.

The bootstrap exception applies only to the first EF state admitted by Phase 9
bootstrap validation. That initial state MAY establish draft or active PRD,
REQ, ADR, and POL Artifacts and their Resources without CHG effects. It MUST
NOT contain terminal knowledge Artifacts or any CHG Artifact. After bootstrap
integration, all ordinary CHG-required mutation rules apply.

Terminal Artifacts and their local Resources cannot be edited, with or without
a new CHG.

### Strict editorial policy

There is no typo, formatting, comment-only, or editorial exemption for active
content. This rule is intentionally strict so that humans, agents, CLI tools,
and CI all apply the same deterministic boundary.

A formatter MUST NOT silently rewrite active files. It can propose a CHG-backed
mutation or report that canonical formatting is required.

### CHG lifecycle

CHG permits only:

```text
draft -> completed
draft -> retired
```

A draft CHG describes planned work and is mutable. It is not execution history
and MUST NOT contain factual effect relations.

A completed CHG records a successful transaction. Its effects are factual, and
its frontmatter, body, and owned Resources are frozen after integration.

A retired CHG records unfinished work that will not complete. It is frozen,
MUST NOT contain factual effect relations, and MUST NOT claim that any planned
authoritative effects occurred.

Failed, cancelled, rejected, and abandoned changes all use CHG status
`retired`. The body records the reason; they are not separate lifecycle states.

### Net-effect classification

Each Artifact target in one completed CHG has at most one effect relation. Its
effect is classified from the transaction's net before-and-after aggregate
state.

#### `introduces`

Use `introduces` when the target Artifact was absent before the transaction and
exists afterward:

```text
before: absent
after:  present
effect: introduces
```

The introduced target may be draft or active. Creating a draft without CHG is
also permitted; `introduces` is required only when the introduction belongs to
the recorded transaction or when the Artifact is introduced directly as
active.

#### `retires`

Use `retires` when an existing target ends the transaction with status
`retired`:

```text
before: present and not retired
after:  retired
effect: retires
```

If the transaction changes other content before retirement, its net effect is
still `retires`.

#### `modifies`

Use `modifies` when the target exists before and after, its aggregate state
changes, and it does not transition to `retired`:

```text
before: present
after:  present and changed, not newly retired
effect: modifies
```

This includes:

- activation of an existing draft;
- active Artifact content changes;
- relation or Resource changes;
- active-to-superseded transition; and
- PROJECT changes.

An Artifact newly introduced and then edited within one transaction has the net
effect `introduces`, not both `introduces` and `modifies`.

### Supersession effects

CHG does not define a separate `supersedes` effect. Supersession is represented
by the source's lifecycle and relation change plus ordinary net effects:

```text
CHG-182 --introduces------> REQ-070
CHG-182 --modifies--------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

When the replacement already exists and remains unchanged:

```text
CHG-183 --modifies--------> REQ-031
REQ-031 --superseded-by---> REQ-070
```

### Exactly-once effect coverage

Every mutation that requires CHG MUST be attributed to exactly one completed
CHG at the authoritative integration boundary.

- A changed required target without an effect is invalid.
- A claimed effect without the corresponding net change is invalid.
- One CHG cannot declare multiple effect types for one target.
- Multiple CHGs completing at the same integration boundary cannot claim the
  same target.
- An unchanged target cannot be listed merely as context; context uses
  `references` instead.

Valid draft-only mutations that do not require CHG MAY coexist at the same
integration boundary and remain outside effect coverage.

### CHG self-effects and other CHGs

A CHG does not declare an effect on itself. Its own creation, status transition,
body, and owned evidence are part of the transaction record.

Consequently, a CHG may first enter authoritative history already `completed`
or `retired`. That first appearance is validated as the transaction record's
self-exempt lifecycle, not as an effect requiring another CHG.

A CHG MUST NOT use `introduces`, `modifies`, or `retires` against another CHG.
Draft CHG retirement is handled by that CHG's own lifecycle transition, and
completed or retired CHGs are frozen.

### Resource mutation

Resource effects are attributed to the owning Artifact. Resources have no
independent effect identity.

For example, changing:

```text
.engineering/resources/REQ-031/search-filter.schema.json
```

requires:

```yaml
relations:
  - type: modifies
    target: REQ-031
```

even when `REQ-031.md` itself is byte-identical.

A completed CHG `## Changes` section MUST describe added, modified, removed,
moved, or descriptor-changed Resources in human-readable form. The effect
relation identifies the owner, while repository diff and Resource validation
provide authoritative file-level facts.

Resource file and descriptor changes MUST become valid together. A local file
without a descriptor is orphaned; a descriptor without its local file is
missing. Historical ownership cannot transfer, and frozen-owner Resources
cannot change.

Resources owned by the CHG itself, including verification evidence, do not
create a CHG self-effect. They freeze with the completed or retired CHG.

### Completed-CHG structural requirements

For a completed CHG:

- `## Rationale` MUST appear exactly once and contain non-empty Markdown.
- `## Sources` MUST appear exactly once and contain at least one non-empty list
  item.
- `## Changes` MUST appear exactly once and contain at least one non-empty list
  item.
- `## Verification` MUST appear exactly once.
- The first non-empty Verification paragraph MUST be `Result: passed` or
  `Result: not-applicable`.

For `Result: passed`, Verification MUST contain at least one non-empty list item
describing a performed check.

For `Result: not-applicable`, Verification MUST contain a non-empty rationale
paragraph after the result marker. Deterministic EF structural and graph
validation still applies; `not-applicable` refers to external or behavioral
verification, not to EF integrity validation.

### Retired-CHG structural requirements

A retired CHG contains no factual effect relations and MUST explain why the
transaction did not complete.

Its final body contains the same four level-two sections so that the frozen
historical record remains understandable:

- `## Rationale` explains why work began or why it was stopped.
- `## Sources` contains at least one source or origin item.
- `## Changes` states that no authoritative effects were applied and MAY
  describe planned or attempted work.
- `## Verification` begins with `Result: not-completed` and explains the
  incomplete or failed outcome.

Draft CHG section requirements remain flexible until completion or retirement.
Exact Artifact body ordering and additional optional sections are defined by
the Artifact body schema specification.

### Validation boundary

CHG validation has three distinct levels.

#### Structural validation

Deterministic structural validation checks:

- required headings and uniqueness;
- required non-empty content and list items;
- verification result marker syntax and lifecycle compatibility;
- effect relation structure; and
- referenced Artifact and Resource integrity.

#### Repository-state consistency

Deterministic state validation checks:

- effect relations against before-and-after aggregate state;
- exactly-once effect coverage;
- schema, lifecycle, relation, supersession, and Resource validity;
- frozen-state preservation;
- deletion prohibition; and
- complete atomic post-transaction graph validity.

#### Semantic attestation

EF Core does not claim to prove automatically that:

- a rationale is adequate;
- a human source description is true;
- an external test was actually executed;
- external evidence is sufficient; or
- a `not-applicable` rationale is correct.

These are author, reviewer, or CI attestations. EF preserves them, validates
their required structure and repository references, and can strengthen them
with captured evidence and deterministic validator hooks.

### Sources and provenance

Every completed or retired CHG records at least one source or origin in
`## Sources`. Sources may include product input, customer reports, incidents,
issues, pull requests, existing implementation behavior, research, regulations,
or direct maintainer decisions.

Machine-resolvable provenance uses existing EF structures:

- an Artifact source uses a CHG `references` relation;
- a PR, Issue, or external source URL uses a CHG-owned or affected
  Artifact-owned non-normative Resource;
- selected local evidence uses a CHG-owned or affected Artifact-owned local
  Resource; and
- a human or offline origin is described in the Sources list.

The Markdown list explains provenance but does not duplicate effect relations
as a second machine-readable transaction record.

### Git provenance

A Git commit hash is not required inside CHG metadata or body. A CHG commonly
enters history in the commit whose hash does not exist until after the CHG is
written.

Git commit provenance is derived from repository history:

```text
CHG file path -> Git history -> introducing or completing commit
```

Known PR, Issue, or external URLs MAY be captured before completion as Resources
or body content. A completed CHG cannot later be edited merely to add a URL.

### Completion criteria

A CHG can transition to `completed` only when all of these are true:

1. Its envelope and completed body structure are valid.
2. It contains at least one effect relation.
3. Every effect matches the before-and-after aggregate state.
4. Every CHG-required mutation has exactly one effect owner.
5. Every resulting Artifact schema and lifecycle state is valid.
6. Relation targets, compatibility, ordering, and cycles are valid.
7. Supersession replacement sets and canonical resolution are valid.
8. Local Resources exist, match their encoded owners, and pass every required
   validator.
9. No frozen Artifact or Resource was modified or removed.
10. No issued Artifact was physically deleted.
11. Rationale and source provenance are structurally present.
12. Verification declares `passed` or `not-applicable` with required detail.
13. Every required deterministic EF validator succeeds.
14. The complete post-transaction project graph is valid.
15. The transition can enter authoritative history as one atomic state.

Failure of any criterion prevents completion.

### Atomicity and Git commits

CHG is a logical engineering transaction, not a requirement for one particular
feature-branch commit shape.

A branch MAY use multiple commits to author drafts. The authoritative update
MUST nevertheless add exactly one next first-parent commit for one validated
transition. A merge commit can preserve authoring commits as non-first-parent
history, and a squash can produce one commit whose parent is the baseline.
A fast-forward containing multiple new first-parent commits is valid only when
each adjacent commit is independently valid and transition-validated; one
baseline-to-final-tree validation does not validate its intermediate commits.
Authoritative EF integration states begin at the bootstrap commit on the
configured integration branch and continue along its first-parent history. One
ordinary boundary is the tree transition between two adjacent EF-bearing
first-parent commits. Earlier repository commits contain no authoritative EF
state. Commits reachable only through a merge commit's non-first parents are
authoring history, not separate authoritative integration states.

The configured integration boundary MUST expose a valid before state through
the externally supplied full baseline commit OID and a complete valid after
state through the externally supplied full proposed commit OID, without
authoritative partial intermediate states. The proposed commit's first parent
MUST be the baseline OID. Publication is an atomic compare-and-swap of the
configured integration ref from that baseline to that proposed commit;
otherwise validation is stale or does not describe the actual integration
boundary, and the transition MUST be revalidated.

One integration boundary MAY complete multiple CHGs when their effect target
sets are disjoint and every changed owner is attributed unambiguously. When two
CHGs claim the same target, they must be combined or integrated as separate
ordered authoritative transactions.

The physical write, locking, temporary-file, and integration-ref mechanisms
are defined by filesystem and configuration specifications.

### Failed and partial changes

A retired CHG asserts that it produced no authoritative effects. It can preserve
planned work, failure rationale, research, references, and owned evidence, but
its effect relation set is empty.

If partial effects have already entered authoritative history, changing the CHG
to `retired` does not erase them. The repository is in integrity violation and
must either complete the original transaction or apply an explicit corrective
transaction that restores a valid state.

Unintegrated partial feature-branch work may be corrected or removed before it
enters authoritative history, subject to provisional identity and draft
retention rules.

## Examples

### Completed semantic change

```yaml
---
schema: ef/change@1
type: change
id: CHG-182
title: Replace the Search Filtering Contract
status: completed
summary: The original search requirement was replaced by one consolidated observable contract.
tags: []
relations:
  - type: introduces
    target: REQ-070
  - type: modifies
    target: REQ-031
  - type: references
    target: PRD-012
resources: []
---

## Rationale

The filtering requirements were consolidated to remove overlapping definitions
and establish one observable contract.

## Sources

- Product intent recorded in PRD-012.
- Existing behavior described by REQ-031.
- Direct maintainer decision to consolidate duplicate requirements.

## Changes

- Introduced REQ-070.
- Superseded REQ-031 with REQ-070.
- Added the canonical search-filter JSON Schema.

## Verification

Result: passed

- EF schema, relation, lifecycle, and graph validation passed.
- The JSON Schema validator passed.
- Search integration tests passed.
```

### Completed editorial change

```markdown
## Rationale

Correct a spelling error without changing the observable requirement.

## Sources

- Direct maintainer review of REQ-044.

## Changes

- Corrected spelling in REQ-044.

## Verification

Result: not-applicable

No runtime implementation or observable behavior changed. EF structural and
graph validation passed.
```

The CHG still contains a `modifies REQ-044` effect because active serialized
content changed.

### Retired change

```yaml
---
schema: ef/change@1
type: change
id: CHG-184
title: Migrate Search Storage to the Upstream Index
status: retired
summary: The proposed storage migration was stopped after the upstream index was discontinued.
tags: []
relations: []
resources: []
---

## Rationale

The migration was stopped after the upstream indexing service was discontinued.

## Sources

- Upstream service discontinuation notice reviewed by the maintainers.

## Changes

No authoritative changes were applied. A prototype was evaluated before the
transaction was retired.

## Verification

Result: not-completed

The prototype failed the compatibility check and the migration did not proceed.
```

### PR as a Resource

```yaml
resources:
  - type: reference
    location: https://github.com/acme/search/pull/42
    role: reference
    media_type: text/html
    normative: false
    description: Pull request that implemented and verified this transaction.
```

The URL must be known before CHG completion because the completed CHG is frozen.

## Validation

CHG validation requires the current graph and, for transition effect and
atomicity checks, the explicit trusted baseline and proposed commit states.

The CHG diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-CHG-002` | error | Completed CHG has no effect relations |
| `EF-CHG-003` | error | Effect does not match the before-and-after aggregate state |
| `EF-CHG-004` | error | One CHG declares conflicting effects for one target |
| `EF-CHG-005` | error | Changed required target is not covered exactly once |
| `EF-CHG-006` | error | Unchanged target is incorrectly declared as an effect |
| `EF-CHG-007` | error | Multiple completing CHGs claim the same target |
| `EF-CHG-008` | error | Draft or retired CHG contains a factual effect relation |
| `EF-CHG-010` | error | A structurally valid Verification result is incompatible with CHG lifecycle or completion |
| `EF-CHG-012` | error | Resource mutation and owner effect are inconsistent |
| `EF-CHG-017` | error | CHG declares an effect on itself or another CHG |

CHG body syntax and Verification marker syntax use `EF-BODY-*`; frozen
Artifact deletion and mutation use `EF-LIFE-*`; frozen Resource mutation uses
`EF-RES-*`. CHG validation consumes those valid structures to evaluate the
transaction and does not emit duplicate aliases.

Structural validation can operate on one CHG file. Effect truthfulness,
exactly-once coverage, Resource diffing, frozen-state preservation, deletion,
and atomicity require project and previous-state context.

No diagnostic asserts that EF has automatically proved the adequacy of a human
rationale or the truth of an external verification claim. Those statements are
attestations unless supported by deterministic hooks or captured evidence.

## Deferred

- Complete CHG body ordering, optional sections, source-item conventions, and
  Artifact-specific Markdown validation are defined in Phase 8: Artifact Body
  Schemas.
- Repository baseline selection, diff normalization, Git-aware deletion and
  ownership comparison, validation modes, and exit behavior are defined in
  Phase 9: Validation and Integrity.
- Stable CHG lookup, effect queries, source trace, and machine-output schemas
  are defined in Phase 10: Query and Trace.
- Project-root discovery, authoritative integration configuration, atomic file
  replacement, locking, temporary files, and Git integration are defined in
  Phase 11: Filesystem and Configuration.
- Temporary input normalization, selective source retention, and promotion into
  CHG provenance are defined in Phase 12: Input Normalization and Promotion.
- Cryptographic attestations, CI-provider APIs, command execution, deployment
  orchestration, and automatic external truth verification are outside EF Core
  v1.
