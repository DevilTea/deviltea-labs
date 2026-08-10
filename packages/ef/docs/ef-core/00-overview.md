# Engineering Files Core v1 Overview

Status: Accepted

## Purpose

Engineering Files (EF) is a file-based, Git-native system for maintaining
canonical engineering knowledge, decision history, and change provenance.

EF represents engineering truth as human-readable Markdown with structured YAML
frontmatter. The same files support human review, deterministic tooling, graph
queries, CI validation, and explicit composition into Agent context.

EF Core defines a project-independent ontology and integrity model. It does not
define product-specific approval processes, deployment workflows, project
management behavior, or semantic judgment by an LLM.

The numbered specifications linked below contain the normative details. This
overview summarizes their shared model; a numbered specification governs if a
summary here is less specific.

## Design Principles

EF Core v1 follows these principles:

- Authoritative state is stored in ordinary version-controlled files.
- Git records repository history; caches and indexes are replaceable derived
  state.
- Every Artifact has stable identity independent of title, path, and content.
- Issued identities are never reused and authoritative Artifact files are never
  physically deleted.
- Current truth, historical knowledge, and execution history remain distinct.
- Relations use a small explicit directed ontology rather than inferred links.
- Every authoritative mutation of active truth is attributed to exactly one
  completed CHG at the integration boundary.
- Supersession preserves historical identity and never silently retargets,
  inherits, or rewrites old content.
- Core validation and query operations are read-only, network-free, and
  independent of LLM semantic judgment.
- Query and context selection never resolve identities, traverse graphs, or load
  Resource bytes implicitly.
- Raw input is temporary by default; only selected provenance and evidence enter
  authoritative state.

## Conceptual Model

```text
temporary input normalization
            |
            v
   draft Artifacts and selected Resources
            |
            v
   explicit proposed commit tree
            |
            v
  CHG + transition validation + Git integration
            |
            v
 current canonical Artifact graph + immutable history
            |
            v
 explicit query, trace, and Agent context composition
```

Three classes of knowledge remain separate:

| Class | EF representation |
|---|---|
| Current engineering truth | Active PROJECT, PRD, REQ, ADR, and POL Artifacts |
| Decision and knowledge history | Superseded or retired Artifacts and Git history |
| Execution history | Completed or retired CHG Artifacts and Git history |

## Artifact Model

EF Core defines six Artifact types:

| Artifact | Identity | Purpose |
|---|---|---|
| PROJECT | `PROJECT` | Project vision, scope, non-goals, foundational context, and canonical domain terminology |
| PRD | `PRD-001` | Product problem, user need, desired outcome, and success criteria |
| REQ | `REQ-001` | Observable behavior, constraints, and acceptance criteria |
| ADR | `ADR-001` | Significant chosen solution, alternatives, and consequences |
| POL | `POL-001` | Cross-cutting recurring engineering rule and compliance expectations |
| CHG | `CHG-001` | Provenance and verification record for one engineering transaction |

Every Artifact explicitly contains the same nine core envelope fields:

```yaml
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: active
summary: Search results support explicit filtering by supported criteria.
tags: []
relations: []
resources: []
```

No core field is omitted. Empty collections are serialized as `[]`. `summary`
is required because it supports discovery and context selection without loading
the full Markdown body. Namespaced `x-*` fields may extend representation but
cannot change core identity, lifecycle, relation, Resource, or validation
semantics.

Each type has a small required Markdown body schema. Draft bodies may be
incomplete; active bodies must be complete and may not contain placeholders.

PROJECT contains a required `## Terminology` glossary table. The table may
initially contain no term rows; this explicitly means that the project has not
yet established canonical domain terminology. Accepted terms contain
definitions and wording to avoid or recognize as aliases. Terms remain
lightweight PROJECT content: they do not receive IDs, lifecycles, Resources, or
relations. PROJECT mutation and CHG history preserve glossary evolution.

## Identity and Retention

Artifact identity is project-scoped and immutable.

- Numeric IDs use a type prefix and canonical positive decimal number.
- Allocation advances from the greatest issued number and never fills gaps.
- IDs created on branches are provisional until authoritative integration.
- Parallel-branch collisions must be repaired before integration.
- Once issued, an ID is never reused for another Artifact.
- Canonical filename is exactly `<ID>.md`.
- Titles and paths are not identity.
- Issued Artifact files remain in authoritative history and are never physically
  deleted.

EF preserves history through lifecycle, CHG, and Git rather than by creating a
new identity for every edit.

## Lifecycle and Immutability

The lifecycle vocabulary is:

```text
draft
active
superseded
retired
completed
```

Allowed transitions are:

```text
PRD / REQ / ADR / POL:
  draft -> active
  draft -> retired
  active -> superseded
  active -> retired

CHG:
  draft -> completed
  draft -> retired

PROJECT:
  always active
```

An Artifact is current canonical engineering truth exactly when it is PROJECT
or an active PRD, REQ, ADR, or POL. Drafts are editable but non-canonical.

`superseded`, `retired`, and `completed` are terminal and byte-frozen. Active
truth may change only through a CHG-backed engineering transaction. Even a
committed formatting or typo correction to active content requires CHG because
core validation does not attempt to infer whether a byte change is semantically
important.

## Relation Graph

Relations are stored once in canonical direction. Incoming relations are
derived by query rather than duplicated in target files.

Semantic relations are:

| Relation | Canonical meaning |
|---|---|
| `derived-from` | Source content is derived, refined, decomposed, or generalized from target content |
| `addresses` | An ADR records a decision addressing a REQ |
| `governed-by` | A PRD, REQ, ADR, or CHG is subject to a POL |
| `superseded-by` | A terminal historical Artifact is replaced by same-type Artifact(s) |
| `references` | Source explicitly cites target without stronger semantics |

Completed CHGs additionally use factual effect relations:

```text
introduces
modifies
retires
```

There is no stored inverse relation and no generic `related-to`. Relation
targets are exact historical identities unless a caller explicitly requests
current resolution.

## Supersession and Current Resolution

Supersession stores pointers from old knowledge to its direct same-type
replacement set:

```text
REQ-031 --superseded-by--> REQ-070
```

One-to-one, one-to-many, many-to-one, and many-to-many replacement are allowed.
For each source, all outgoing replacement targets form one collective set.

Current resolution follows complete replacement chains and returns every active
leaf. It does not choose one winner, flatten historical pointers, mutate the
graph, or copy metadata and relations into replacements. Cycles and invalid
replacement topology fail without partial results.

## Resources

A Resource is a supporting contract, representation, example, reference,
prototype, asset, or evidence item owned by exactly one Artifact.

Every descriptor explicitly contains:

```text
type
location
role
media_type
normative
description
```

Local Resources are stored under:

```text
.engineering/resources/<OWNER-ID>/...
```

They are part of the owner's aggregate state and follow the owner's lifecycle.
A historical local path cannot be transferred to a different owner. External
HTTP or HTTPS Resources are references, are never fetched by deterministic
validation, and cannot be normative. Normative Resource content must be local.

Resources have no separate Artifact ID, status, relation graph, or Markdown
body.

## Engineering Transactions and CHG

An engineering transaction is one atomic transition from a valid authoritative
project state to another. A completed CHG records its rationale, sources,
changes, verification attestation, and exact Artifact-level net effects.

Required completed-CHG sections are:

```markdown
## Rationale
## Sources
## Changes
## Verification
```

A CHG classifies each affected Artifact aggregate exactly once:

| Before/after effect | Relation |
|---|---|
| Artifact absent before and present after | `introduces` |
| Artifact present before and changed after | `modifies` |
| Artifact transitions to retired | `retires` |

Resource changes are attributed to their owner rather than assigned Resource
effect identities. `.engineering/ef.yaml` and `.engineering/.gitignore` belong
logically to the PROJECT aggregate, so a control-file mutation is a
`modifies PROJECT` effect.

CHG truthfulness, frozen-state preservation, exact effect coverage, and
supersession atomicity are established by comparing a trusted baseline tree
with the complete tree of an explicit proposed commit. Git provides the authoritative integration
boundary and derived commit provenance. Authoritative EF states begin at the
bootstrap commit on the configured integration branch and continue along its
first-parent sequence; each adjacent pair of EF states defines one ordinary
integration transition.

## Repository and Workspace Model

The Git worktree whose root directly contains `.engineering/` is the project
repository. It may contain EF state and implementation code together.

Canonical layout is:

```text
<project-root>/
└── .engineering/
    ├── ef.yaml
    ├── .gitignore
    ├── PROJECT.md
    ├── prd/
    ├── req/
    ├── adr/
    ├── pol/
    ├── chg/
    └── resources/
```

A single-repository project uses:

```yaml
linked_repositories: []
```

A composite workspace declares independent named Git worktree slots such as
frontend, backend, or management. In EF Core v1 every slot is located beneath
the project root; sibling and absolute external worktrees are unsupported.
Project discovery can ascend across their Git boundaries to the nearest
`.engineering/ef.yaml`, then verifies that the current worktree matches a
declared slot. Core does not attest remote repository identity.

Linked-repository IDs provide named workspace slots and provenance context;
Core does not attest remote repository identity or manage branches,
merges, releases, deployments, cloning, or credentials. Physical transaction
atomicity covers only the project repository.

## Input Normalization

Raw input is non-authoritative and is not retained by default. EF Core defines
no `RAW-*` identity, capture manifest, persistent statement schema, or tracked
raw-input directory.

Tools may use disposable ignored state under:

```text
.engineering/.tmp/raw/
```

Only material needed for long-term audit, offline preservation, continuing
engineering context, or verification is copied into authoritative state:

- transaction-specific evidence is normally CHG-owned;
- continuing context, evidence, or contracts are Artifact-owned; and
- every retained local file remains exclusively owned by one Artifact.

CHG Sources preserve adequate provenance. Temporary extraction and conflict
resolution are review activities, not canonical EF entities.

## Validation

EF has three core validation scopes:

- `snapshot` validates one complete current project state;
- `transition` compares a trusted valid baseline commit with one explicit
  proposed commit;
- `range` validates every authoritative boundary between a captured
  pre-integration ref tip and one explicit proposed commit.

Bootstrap validation handles creation of the initial EF project state.
Workspace validation is an additive check for declared linked repositories.

Transition validation is required for authoritative integration because a
snapshot alone cannot prove lifecycle legality, non-deletion, terminal
immutability, Resource mutation consistency, CHG effect truthfulness, or
exactly-once coverage. Transition validation requires an externally supplied
full baseline commit OID and full proposed commit OID. The baseline's
configuration identifies the fixed local integration branch, and publication
uses an atomic compare-and-swap from the baseline to that proposed commit.

Range validation extends that requirement to a candidate that adds more than one
new first-parent commit. Every adjacent authoritative boundary in the
candidate's first-parent sequence is independently validated, a commit that does
not change `.engineering` is an identity boundary rather than a skipped commit,
and publication of the validated range is still one atomic compare-and-swap,
from the range baseline to the range tip. No ref is mutated per intermediate
commit.

Bootstrap is the sole no-baseline exception. It is valid only when the proposed
integration branch's existing first-parent history contains no
`.engineering/ef.yaml` path. The proposed bootstrap is still a complete valid
snapshot; it may establish initial draft or active knowledge without a CHG,
but it cannot claim terminal knowledge or CHG history that EF did not observe.

Core validation is deterministic, read-only, network-free, and reports stable
structured diagnostics. Strict mode treats warnings as failing and requires
every Core check for the requested scope to be available. It does not silently
strengthen snapshot into transition scope.

Stable process outcomes are:

```text
0  complete and successful
1  complete evaluation rejected by domain findings
2  requested operation incomplete
3  internal implementation failure
```

## Query, Trace, and Context Composition

EF Core defines exact lookup, structured list, literal search, direct relations,
transitive trace, explicit current resolution, potential-impact traversal, and
history lookup.

Queries are deterministic and read-only. They never repair invalid state,
return unsafe partial graphs, apply relevance ranking, or use semantic search.

Agent context is assembled explicitly:

```text
lookup full PROJECT for project context and terminology
  -> list / search / impact
  -> select exact Artifact IDs
  -> optionally resolve current identities
  -> load full Artifact bodies
  -> explicitly read selected Resource content
```

Summary metadata is sufficient for initial discovery. Resource bytes and
transitive graph context are never loaded automatically.

## CLI Surface

EF Core v1 keeps the CLI deliberately small:

```text
ef init
ef artifact create
ef validate
ef query
ef resource read
```

`init` creates a new EF project, while `artifact create` creates only new draft
Artifacts. General edit, delete, lifecycle, supersession, and CHG-completion
commands are not part of Core v1; files remain directly authorable.

Human output is not a machine contract. JSON commands produce one stable result
object, never prompt, and use the common exit-code model. Mutations support
dry-run and explicit non-interactive authorization. CLI atomic publication is
limited to a new `.engineering` directory or one new draft file; multi-file
engineering atomicity is enforced at Git transition integration.

## Typical Workflow

```text
1. Discover an existing EF project or initialize one.
2. Load PROJECT, including its canonical Terminology glossary.
3. Inspect summaries with list or literal search.
4. Load exact current or historical context explicitly.
5. Create and refine draft Artifacts directly or with `artifact create`.
6. Prepare a draft CHG for changes to active truth.
7. Edit every affected Artifact and selected Resource in one proposed tree.
8. Complete CHG rationale, sources, effects, changes, and verification.
9. Create the proposed commit or commit sequence without updating the authoritative integration ref.
10. Run strict transition or range validation with explicit full baseline and proposed commit OIDs.
11. Atomically publish the validated commit or validated range tip to the integration ref.
12. Query current truth, impact, trace, and history from authoritative files.
```

## Specification Index

1. [Artifact Envelope](01-artifact-envelope.md) — common frontmatter fields,
   extensions, ordering, and representation.
2. [Artifact Identity](02-identity.md) — IDs, allocation, filenames,
   immutability, retention, and collision repair.
3. [Artifact Lifecycle](03-lifecycle.md) — statuses, transitions, current truth,
   terminal state, and deletion rules.
4. [Relations Ontology](04-relations.md) — semantic edges, CHG effects,
   direction, compatibility, and graph integrity.
5. [Supersession and Canonical State](05-supersession.md) — replacement sets,
   chains, current resolution, preservation, and atomicity.
6. [Resource Schema](06-resources.md) — descriptors, local and external content,
   ownership, normative rules, and lifecycle.
7. [CHG Transaction Semantics](07-change-transactions.md) — transaction scope,
   effect truthfulness, provenance, verification, and Git integration.
8. [Artifact Body Schemas](08-artifact-schemas.md) — required Markdown sections,
   lifecycle completeness, and semantic boundaries.
9. [Validation and Integrity](09-validation.md) — snapshot and transition
   validation, diagnostics, policies, determinism, and CI.
10. [Query and Trace](10-query-and-trace.md) — lookup, filters, literal search,
    traversal, impact, history, and stable results.
11. [Filesystem and Configuration](11-filesystem-and-config.md) — canonical
    layout, config, discovery, linked repositories, paths, and migration.
12. [Input Normalization and Promotion](12-input-normalization.md) — temporary
    source processing, selective retention, provenance, and promotion.
13. [CLI Contract](13-cli-contract.md) — command surface, JSON transport,
    authorization, exits, CI, editor integration, and write safety.

Companion: [Diagnostic Registry](diagnostic-registry.md) — central index of
stable diagnostic codes, ownership, severity, scope, exit treatment, and
reserved numeric slots.

## Explicit Non-goals

EF Core v1 does not provide:

- a database or remote service as a second source of truth;
- semantic truth determination or mandatory LLM processing;
- fuzzy, relevance-ranked, or semantic search;
- implicit relation traversal, supersession resolution, or Resource loading;
- cross-project Artifact identities or relations;
- persistent raw-input identity or sentence-level derivation history;
- independent terminology-entry IDs, relations, or automatic natural-language
  enforcement;
- general approval, issue tracking, release, or deployment workflows;
- cross-repository physical transactions;
- repository cloning, credentials, or Git-hosting orchestration;
- general-purpose Artifact mutation commands; or
- automatic repair or migration during reads, queries, or validation.

These boundaries keep EF Core small enough to remain inspectable, portable,
deterministic, and usable by both people and tools.
