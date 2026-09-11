# EF Core: Input Normalization and Promotion

Status: Accepted

## Scope

This document defines the boundary between raw engineering input, temporary
normalization work, canonical EF state, retained source provenance, and
promotion through CHG transactions.

EF Core v1 does not define a persistent Raw Input identity, capture schema,
Engineering Statement schema, Raw lifecycle, or tracked Raw workspace.

## Definitions

### Raw input

Raw input is unnormalized source material that may contain facts, needs,
outcomes, candidate requirements, constraints, proposals, claimed decisions,
questions, ambiguity, duplication, or conflict.

Examples include conversations, interviews, tickets, issues, meeting notes,
regulations, research, benchmarks, incidents, existing implementation behavior,
external specifications, URLs, files, and images.

Raw input is not canonical engineering truth.

### Normalization

Normalization is the non-authoritative process of extracting, classifying, and
resolving engineering information before it is written into canonical EF
structures.

Normalization may distinguish categories such as:

```text
fact
need
outcome
requirement candidate
constraint
proposal
decision claim
question
```

These are processing concepts, not persistent EF Core entities or schemas. In
particular, a proposal is not a decision, and a source's decision claim is not
a canonical ADR until it has been reviewed and promoted.

### Temporary normalization workspace

A temporary normalization workspace is disposable local state used by a human,
agent, editor, or tool while processing raw input.

The conventional project-local location is:

```text
.engineering/.tmp/raw/
```

It is ignored by Git, is not authoritative, is not included in EF queries or
context composition, and may be rewritten or deleted at any time.

### Promotion

Promotion is the act of incorporating resolved engineering information into
canonical EF truth as PROJECT, PRD, REQ, ADR, POL, or an owned Resource.

Creating or editing a draft Artifact is staging, not completed promotion.
Promotion completes when the resulting truth becomes authoritative under the
existing lifecycle and CHG transaction rules.

### Retained source

A retained source is selected input that is deliberately preserved as CHG
provenance or as an owned Resource because it is needed for long-term audit,
offline access, continuing engineering context, or verification.

## Core Model

The EF Core input flow is:

```text
external or local input
  -> temporary extraction and resolution
  -> canonical Artifact and Resource changes
  -> completed CHG with source provenance
  -> discard temporary workspace
```

Only the resulting Artifacts, CHG, selected Resources, and source citations are
authoritative EF state.

EF Core v1 deliberately has no:

- `RAW-*` identity namespace;
- tracked `.engineering/raw/` directory;
- capture manifest;
- persistent statement identifier;
- raw-input lifecycle or disposition state;
- raw-input relation graph; or
- requirement to preserve all received input.

Temporary processors MAY use any internal representation. That representation
has no stable machine contract and MUST NOT be treated as canonical truth.

## Source Retention Rules

Raw input is not retained by default. A source is copied into authoritative EF
state only when at least one of these purposes applies:

- long-term audit;
- offline preservation;
- reproducible or reviewable verification;
- continuing engineering context; or
- normative content that must remain available with an Artifact.

When none applies, the CHG records an adequate human-readable origin or stable
external reference and the temporary copy is discarded.

Retaining a source does not make every statement in it accepted or canonical.
The owning Artifact body, Resource descriptor, CHG effects, and lifecycle state
determine EF meaning.

### CHG-owned source

A source SHOULD be owned by the CHG when its continuing purpose is to explain,
audit, or verify that engineering transaction.

Examples include:

- a redacted customer request that motivated the change;
- an incident excerpt used as transaction evidence;
- verification output captured for the completed change; or
- a snapshot of an external issue needed for audit.

Such a Resource is normally non-normative and uses the `evidence` or `reference`
role.

### Artifact-owned source

A source SHOULD be owned by an affected PROJECT, PRD, REQ, ADR, or POL when it
has continuing value as part of that Artifact's current context, evidence,
explanation, or contract.

Examples include:

- a benchmark that continues to support an ADR;
- an external standard referenced by a POL;
- a machine-readable contract owned by a REQ; or
- research that remains useful PRD context.

A normative source MUST be copied into a local Artifact-owned Resource.
External HTTP or HTTPS Resources are always non-normative under the Resource
Schema.

### Ownership choice

Every retained local file has one Resource owner. A source MUST NOT be placed in
a shared raw store or assigned to multiple owners.

If both transaction history and continuing Artifact context need the source,
choose the Artifact as owner and cite that retained material in the CHG's
`## Sources` explanation. Duplicate authoritative copies SHOULD be avoided
unless they intentionally preserve different evidence states.

Once captured as a Resource, the ordinary exclusive-ownership, lifecycle,
immutability, path, and historical non-reuse rules apply. Resource ownership is
not later transferred from a CHG to an Artifact or between Artifacts.

## Source Provenance

Every completed or retired CHG continues to contain at least one origin item in
`## Sources` under the CHG Transaction Semantics specification.

Source provenance uses existing EF mechanisms:

- an EF Artifact source uses a CHG `references` relation;
- a stable external URL may be retained as a non-normative CHG-owned or
  Artifact-owned Resource;
- selected local evidence becomes a CHG-owned or Artifact-owned Resource; and
- a human, offline, or non-addressable origin is described in the CHG Sources
  list.

EF Core does not introduce a raw-source relation target or a special source URI
scheme.

A citation is sufficient when preservation is unnecessary. A local copy is not
required merely because a source participated in normalization.

## Promotion Rules

Normalization and temporary workspace changes do not require CHG because they
do not mutate authoritative EF state.

Draft Artifact creation and editing follow the existing CHG-optional draft
rules. A draft derived from input is still non-canonical and MUST NOT be
reported as completed promotion.

After bootstrap integration, promotion that creates or changes active canonical
truth follows the ordinary CHG transaction rules without exception. The same
project-repository transaction contains:

- the introduced, modified, retired, or superseded Artifact aggregates;
- any selected retained Resources;
- a completed CHG with exact net-effect relations; and
- adequate source provenance in `## Sources`.

Canonical destination is determined by engineering meaning:

| Resolved information | Canonical destination |
|---|---|
| Fundamental project context or canonical domain terminology | PROJECT |
| User or business problem and desired outcome | PRD |
| Observable behavior or acceptance condition | REQ |
| Cross-cutting recurring rule | POL |
| Significant chosen solution and alternatives | ADR |
| Supporting contract, representation, or evidence | Resource |
| Engineering state transition | CHG |

Promotion may be many-to-many: one input can affect multiple Artifacts, and one
Artifact change can synthesize multiple inputs. EF records the resulting CHG
effects and retained provenance; it does not require a persistent sentence-level
derivation graph.

### Terminology discovery

An Agent or human MAY inspect an existing codebase and its documentation to
propose candidate canonical terms, definitions, and aliases. Candidates remain
normalization output rather than authoritative EF state. They MUST NOT be added
to PROJECT merely because they were discovered; a human decides which terms and
definitions become canonical.

Before the first EF state enters authoritative integration history, accepted
rows and other accepted initial draft or active knowledge MAY be added to the
proposed bootstrap after `ef init`; after the resulting tree is committed, that
explicit commit MUST pass bootstrap validation. After bootstrap integration, adding, changing, or
removing a terminology row mutates the active PROJECT and follows the ordinary
CHG rules. A project may retain a header-only Terminology table until useful
canonical terms are identified.

## Examples

### Stable external source without a local copy

A stable issue URL can appear in the CHG Sources list. If machine-resolvable
retention is useful, it can instead be declared as a non-normative external
Resource owned by that CHG. EF does not fetch it during core validation.

### CHG-owned audit snapshot

```yaml
resources:
  - type: reference
    location: .engineering/resources/CHG-042/customer-request-redacted.md
    role: evidence
    media_type: text/markdown
    normative: false
    description: Redacted customer request retained for long-term change audit.
```

### Artifact-owned continuing evidence

```yaml
resources:
  - type: benchmark
    location: .engineering/resources/ADR-022/filter-benchmark.csv
    role: evidence
    media_type: text/csv
    normative: false
    description: Benchmark evidence supporting the selected filtering design.
```

The CHG introducing or modifying `ADR-022` cites the benchmark's origin in
`## Sources`. The file remains owned by `ADR-022`; it is not also copied into a
CHG Resource directory.

## Validation

Deterministic EF validation checks only authoritative results:

- the temporary normalization workspace is excluded from authoritative
  discovery;
- CHG source-section structure is valid;
- retained Resource descriptors, locations, ownership, and files are valid;
- Resource mutations match CHG effects on their owners;
- normative and external Resource rules are satisfied; and
- canonical Artifacts, relations, lifecycle, and transaction state are valid.

Core validation does not determine whether:

- extraction found every meaningful statement;
- a source was interpreted correctly;
- conflicting input was resolved adequately;
- retained evidence is sufficient;
- a citation will remain externally available; or
- discarded raw input should have been retained.

Those are review, policy, or optional semantic-lint concerns. Core validation is
network-free and does not fetch sources.

## Security and Data Minimization

Content copied into an authoritative Resource becomes subject to Git retention
and EF immutability. Before retention, authors MUST remove secrets,
credentials, prohibited personal data, and content they are not authorized to
store.

EF Core does not use ordinary Resource deletion as a redaction mechanism. A
credential or privacy incident may require exceptional repository-history
rewriting outside EF lifecycle semantics.

Keeping normalization temporary reduces this risk and avoids duplicating source
systems without an engineering need.

## Deferred

- Extraction assistants, LLM prompts, semantic classification, conflict
  resolution interfaces, and interactive review are implementation concerns.
- Organization-specific retention, privacy, copyright, and audit policies may
  require stricter rules through policy or validation hooks.
- Content hashing, notarization, external archive integration, and source-system
  APIs are outside EF Core v1.
- [CLI Contract](13-cli-contract.md) intentionally defines no persistent ingestion or
  Resource-capture command in EF Core v1; temporary processors may remain
  implementation-specific.
