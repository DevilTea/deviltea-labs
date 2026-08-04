# EF Core: Validation and Integrity

Status: Accepted

## Scope

This document defines EF Core v1 validation scopes, validation phases,
deterministic integrity checks, diagnostics, severity, cascading-error handling,
strict mode, warnings-as-errors, CI behavior, exit codes, and the boundary
between Core validation and semantic authoring lint.

Stable CLI command syntax and its complete JSON response envelope are defined
by the CLI contract. This specification fixes the validation semantics those
interfaces expose.

## Definitions

### Snapshot validation

Snapshot validation validates one complete current EF project state without a
previous-state comparison. It can prove current syntax, schema, graph, Resource,
body, lifecycle-state, and canonical-resolution integrity.

Snapshot validation cannot prove transition history, CHG effect truthfulness,
immutability across a mutation, or deletion prohibition because those checks
require a trusted previous state.

### Transition validation

Transition validation compares a trusted valid baseline commit with one
explicit proposed commit. It performs complete snapshot validation on both
trees and additionally checks lifecycle transitions, immutability, deletion,
CHG effects, exactly-once coverage, Resource mutation and immutability,
supersession atomicity, and transaction completion.

Authoritative project integration MUST use transition validation.

### Validation finding

A validation finding is a deterministic diagnostic about repository content or
representation. Findings have `error`, `warning`, or `info` severity.

### Validation completeness

A validation run is complete when the validator had the context and capability
required by its requested scope and policy and produced every conclusion that
can reliably follow from the repository content. A domain finding may block
dependent checks without making the run incomplete. For example, a parse error
can make graph checks for that file unsafe while still producing a complete
invalid result.

Completeness is distinct from validity. Missing execution context or capability
makes a run incomplete; an evaluated repository-contract violation makes it
complete but invalid.

### Strict mode

Strict mode requires every Core check for the requested scope to be available,
and treats every warning as a failing finding. Strict mode does not change the
requested validation scope.

### Warnings-as-errors

Warnings-as-errors changes validation outcome without rewriting warning
severity. It does not require optional validators or otherwise strengthen
execution completeness.

### Trusted baseline

A trusted baseline is the complete previous authoritative EF project state used
for transition comparison. The integration operation MUST supply its full commit
OID externally; proposed repository content does not select or override it. The
validator materializes that commit, reads its valid configuration, and verifies
that the baseline-fixed `integration_ref` resolves to the same OID when the
operation begins. Selection and materialization are defined by the filesystem,
configuration, and CLI specifications.

### Trusted proposed commit

A trusted proposed commit is the complete candidate authoritative EF state. The
integration operation supplies its full commit OID externally. For transition
scope, the proposed commit MUST use the trusted baseline as its first parent.
For bootstrap scope, its parentage follows the bootstrap rules. Validation
materializes the commit and validates its complete tree; it does not infer the
candidate from the working tree, index, or `HEAD`.

## Validation Scopes

### Snapshot scope

Snapshot validation checks:

- configuration shape and canonical filesystem layout;
- UTF-8, YAML, and Markdown syntax;
- common envelope and Artifact schema;
- required fields and field types;
- current ID syntax, filenames, uniqueness, and PROJECT singleton;
- current lifecycle status and type compatibility;
- body schema, PROJECT Terminology table, and lifecycle-section consistency;
- relation entry shape, targets, compatibility, duplicates, and cycles;
- supersession topology and current canonical resolution;
- Resource descriptors, local files, current ownership, and managed-root
  orphans; and
- deterministic built-in Resource checks and advisory findings from available
  optional specialized validators.

Snapshot success means that the current graph is valid. It does not assert that
the mutation that produced it followed CHG, immutability, deletion, or atomicity
rules.

### Transition scope

Transition validation first materializes and validates the baseline and
explicit proposed commit snapshots. It then additionally checks:

- lifecycle transition legality;
- preservation of the bootstrap-fixed `integration_ref`;
- issued ID and type immutability;
- issued Artifact deletion prohibition;
- frozen Artifact and Resource preservation;
- active-content mutation coverage by CHG;
- CHG net-effect classification and truthfulness;
- exactly-once effect ownership;
- Resource mutation and owner-effect consistency;
- supersession replacement-set atomicity;
- completed and retired CHG transaction invariants; and
- complete valid post-transaction graph state.

A transition request without explicitly supplied, materializable trusted
baseline and proposed commits is incomplete, not a successful snapshot
fallback.

### Bootstrap exception

Initial EF project bootstrap has no baseline EF graph. Bootstrap validation
uses an explicit proposed commit and its configuration to identify the initial
`integration_ref` and MUST establish one of these history conditions:

- the ref does not yet resolve; or
- the ref resolves and no commit in its first-parent history contains an
  `.engineering/ef.yaml` path.

If that first-parent history contains `.engineering/ef.yaml`, bootstrap is
invalid and transition validation is required. An inaccessible ref or required
history makes the operation incomplete rather than eligible by assumption.

Bootstrap validation then performs complete snapshot validation on the proposed
tree with these additional state rules:

- exactly one active PROJECT and all required control files are present;
- the canonical PROJECT Terminology table is structurally valid and may contain
  zero term rows;
- PRD, REQ, ADR, and POL Artifacts, when present, are `draft` or `active`;
- local Resources owned by those Artifacts are valid; and
- no `superseded` or `retired` knowledge Artifact and no CHG Artifact is present.

The initial draft and active knowledge Artifacts enter authoritative history as
one bootstrap state and do not require CHG effects. Immediately before the
first authoritative branch update, the integration operation MUST re-check the
same bootstrap history condition. If the ref state changed, bootstrap validation
is stale and MUST be repeated. If the branch did not previously resolve, the
bootstrap commit is either a root commit or its first-parent history before the
bootstrap commit MUST likewise contain no `.engineering/ef.yaml` path. General
transition validation does not invent a synthetic ordinary baseline or permit
the bootstrap exception after that state exists.

## Validation Pipeline

Validation uses this logical phase order:

```text
1. Discovery
2. Parse
3. Envelope and schema
4. Per-file semantics
5. Graph construction
6. Graph integrity
7. Resource integrity
8. Body schemas
9. Transition integrity
10. Validation hooks
11. Diagnostic aggregation
```

Implementations MAY parallelize independent work, but phase dependencies and
final deterministic output MUST be preserved.

### 1. Discovery

Discovery determines the EF project root, project repository, linked repository
association, Artifact files, the managed Resource root, configuration, requested
scope, policy, and transition baseline.

Failure to obtain context required by the requested scope makes the run
incomplete. Filesystem discovery rules are defined later.

### 2. Parse

Parse validation checks UTF-8 input, YAML frontmatter, duplicate YAML keys,
forbidden YAML constructs, GitHub Flavored Markdown AST construction, and
required file readability.

A parse failure in one file blocks checks that require that file's AST but MUST
NOT prevent independent files from being parsed and validated.

### 3. Envelope and schema

Envelope and schema validation checks required fields, types, unknown fields,
schema and type compatibility, canonical field ordering, and extension syntax.

### 4. Per-file semantics

Per-file validation checks ID lexical form, filename, status applicability,
relation entry shape, Resource descriptor shape, and body headings and local
section structure.

### 5. Graph construction

Validation builds derived in-memory indexes for:

- Artifact IDs;
- outgoing and incoming relation edges;
- local Resource ownership;
- supersession topology;
- current canonical state; and
- CHG effects.

These indexes are derived data, exist only for validation, and are not an
authoritative store.

### 6. Graph integrity

Graph validation checks uniqueness, singleton requirements, relation target
existence, compatibility, duplicates, cycles, supersession replacement sets,
and deterministic canonical resolution.

### 7. Resource integrity

Resource validation checks local existence and file type, root containment,
exclusive ownership, managed-root orphans, URL syntax, media type, role and
normative compatibility, and frozen-state rules when context exists. Optional
specialized hooks may add informational advisory findings only. Extension
validation is outside the Core result.

### 8. Body schemas

Body validation checks required headings, ordering, lifecycle-sensitive
completeness, required list items, terminal Lifecycle sections, placeholder-only
content, PROJECT Terminology table structure and ordering, and CHG verification
markers.

### 9. Transition integrity

This phase runs only in transition scope. It compares the trusted baseline and
proposed result to validate identity, lifecycle, immutable content, deletion,
CHG effects, Resource mutation, exactly-once coverage, supersession, and
atomicity.

### 10. Validation hooks

Built-in optional specialized validators MUST be read-only and deterministic
in Core mode.
They MUST NOT require network access, current remote state, LLM judgment, or an
unpinned external schema.

The same complete validation inputs MUST produce the same validator findings.
Those inputs include project bytes, configuration, requested scope and policy,
workspace selection and locally checked workspace state, required baseline and
proposed commit OIDs and trees, declared Core validator capability set and
versions, and operation-start captured project-repository and local-ref state.
Mutable repository or ref state observed by discovery is therefore an explicit
validation input rather than hidden ambient state.

### 11. Diagnostic aggregation

Validation reports every independently detectable problem when continuing is
safe. Diagnostics are deduplicated, assigned stable locations, and sorted
deterministically after parallel work completes.

## Severity

### `error`

An error reports an integrity-contract violation or an execution condition that
prevents a requested validation contract from completing. Errors always prevent
a valid result, although exit code distinguishes invalid content from incomplete
or internal execution.

Repository examples include duplicate IDs, unknown relation targets, missing
local Resources, illegal lifecycle transitions, effect mismatches, and frozen
content mutation.

### `warning`

A warning reports a state that remains interpretable but is non-canonical or
has a defined risk. Examples include non-canonical ordering, insecure HTTP URLs,
and likely file-extension/media-type mismatch.

A condition that breaks authoritative integrity MUST be an error rather than a
warning.

### `info`

An info diagnostic reports allowed state or execution context, such as
incomplete-but-valid draft content, snapshot scope not performing transition
checks, or absence of an optional specialized validator.

Info diagnostics never make validation fail.

## Cascading Diagnostics

A primary error that makes a dependent check unreliable suppresses speculative
secondary errors.

For example, when frontmatter cannot be parsed, validation reports the parse
failure but does not also claim that every required field is missing. Other
independent files continue to be validated.

When an ID is duplicated, validation reports every duplicate location and does
not choose one Artifact as the relation target. Checks requiring unambiguous
resolution are blocked for that ID.

Blocked dependent checks do not produce separate Core diagnostics. Human output
MAY explain suppression, but the machine result contains only the primary
diagnostic and independently actionable findings.

## Diagnostic Contract

### Diagnostic object

Each diagnostic contains at least:

```json
{
  "code": "EF-REL-003",
  "severity": "error",
  "message": "Relation target 'REQ-999' does not exist.",
  "path": ".engineering/req/REQ-031.md",
  "artifact_id": "REQ-031",
  "location": {
    "line": 12,
    "column": 13
  },
  "field": "relations[0].target",
  "related": []
}
```

Fields are:

| Field | Type | Required |
|---|---|---:|
| `code` | string | Yes |
| `severity` | `error`, `warning`, or `info` | Yes |
| `message` | string | Yes |
| `path` | project-relative path string | No |
| `artifact_id` | Artifact ID string | No |
| `location` | line and column object | No |
| `field` | structured field path string | No |
| `section` | Markdown heading string | No |
| `related` | array of related-location objects | Yes, may be `[]` |

Line and column numbers are one-based. A column is the one-based Unicode scalar
value index within the original source line; a tab or combining scalar counts as
one scalar value. A `location` object contains both `line` and `column`; when a
stable source position is unavailable, the complete `location` field is
omitted. Paths use canonical project-relative `/` separators and MUST NOT expose
machine-specific absolute roots in stable output.

A related-location object contains exactly the same optional `path`,
`artifact_id`, `location`, `field`, and `section` fields as a primary
diagnostic location, plus a required non-empty `message`. It has no `code`,
`severity`, or nested `related` field. At least one location-identifying field
MUST be present. Its path and coordinate rules are identical to the primary
diagnostic rules.

`code`, `severity`, and structured locations are the stable machine contract.
Message wording MAY improve without changing diagnostic identity.

### Related locations

Duplicate, cycle, ownership, and cross-file findings use `related` to identify
other participating locations:

```json
{
  "code": "EF-ID-004",
  "severity": "error",
  "message": "Artifact ID 'REQ-031' is duplicated.",
  "path": ".engineering/req/REQ-031.md",
  "artifact_id": "REQ-031",
  "related": [
    {
      "path": "archive/REQ-031.md",
      "message": "Duplicate identity is also declared here."
    }
  ]
}
```

Within one diagnostic, related locations are unique by their complete
structured location excluding `message`. They are sorted by path, line, column,
artifact ID, field, and section. A missing corresponding value sorts after a
present value. Human message text does not affect uniqueness or ordering.

### Primary diagnostic ownership

Each independently detectable invariant violation produces one primary Core
diagnostic, not one diagnostic from every phase that observes its consequence.
Namespaces own findings as follows:

| Namespace | Primary responsibility |
|---|---|
| `EF-ENV-*` | Serialized envelope and frontmatter representation |
| `EF-ID-*` | Identity, canonical Artifact path, uniqueness, and singleton rules |
| `EF-LIFE-*` | Status applicability and transition, whole-Artifact freeze, and Artifact deletion |
| `EF-REL-*` | Relation entry representation, compatibility, targets, and non-supersession graph rules |
| `EF-SUP-*` | Supersession topology, atomicity, and validation-time current resolution |
| `EF-RES-*` | Resource descriptor, file, ownership, and Resource freeze rules |
| `EF-CHG-*` | Effect classification, coverage, provenance, and transaction semantics |
| `EF-BODY-*` | Markdown and body-schema structure |
| `EF-VAL-*` | Validation invocation, capability, completeness, and internal orchestration |

When a more specific diagnostic reports a primary violation, whether in the
same or another namespace, dependent phases MUST NOT emit a broader alias for
the same violation. They MAY emit a distinct diagnostic only when it describes
an independently actionable violation. Query operations wrap query-time
failure in `EF-QRY-*` as defined by Phase 10 rather than re-emitting
validation-only aliases.

The following precedence rules are exhaustive where remaining Core conditions
can overlap:

| Overlap | Diagnostic emitted |
|---|---|
| Parse or envelope failure prevents a trustworthy structured field or body | The primary parse or `EF-ENV-*` diagnostic; dependent schema and semantic findings are suppressed |
| Status is not allowed for the Artifact type | `EF-LIFE-002`; transition and destination-state findings are suppressed |
| Lifecycle transition or first authoritative status is prohibited | `EF-LIFE-003`; findings that depend only on the prohibited destination state are suppressed |
| Required CHG heading is missing or duplicated | `EF-BODY-001` or `EF-BODY-002`; dependent Verification-marker findings are suppressed |
| Required list section has no non-empty item | `EF-BODY-005`, not `EF-BODY-004` |
| Placeholder-only content makes a required section incomplete | `EF-BODY-012`, not `EF-BODY-004` |
| Terminal knowledge has no meaningful Lifecycle section | `EF-BODY-009`, not generic missing- or empty-section diagnostics |
| PROJECT Terminology heading or table is malformed | `EF-BODY-018`, not generic heading, list, or empty-section diagnostics |
| Relation entry is not a mapping or lacks a required field | `EF-REL-002`; all semantic findings for that entry are suppressed |
| Structurally valid relation entry has an unknown type | `EF-REL-001`; type-dependent findings are suppressed |
| Relation target is missing, including a supersession or CHG target | `EF-REL-003`; dependent target-state findings are suppressed |
| A `superseded-by` source and target type differ | `EF-SUP-003`, not `EF-REL-004` |
| A frozen direct replacement set changed | `EF-SUP-007`, not `EF-LIFE-004` |
| One CHG declares conflicting effects for a target | `EF-CHG-004` |
| Multiple completing CHGs claim one target | `EF-CHG-007` |
| Draft or retired CHG declares a factual effect | `EF-CHG-008`; effect truthfulness checks for that CHG are suppressed |
| Completed CHG has no effects and changed required targets exist | Per-target `EF-CHG-005`; `EF-CHG-002` is suppressed |
| Completed CHG has no effects and no changed required target exists | `EF-CHG-002` |
| A CHG claims an unchanged target | `EF-CHG-006`, not `EF-CHG-003` |
| Resource mutation and owner effect disagree | `EF-CHG-012`, not `EF-CHG-003` |
| A CHG effect targets any CHG | `EF-CHG-017`, not a general relation compatibility diagnostic |
| A changed CHG-required target has no effect | `EF-CHG-005` |
| An effect exists but its remaining before/after classification is wrong | `EF-CHG-003` |

Supersession atomicity and CHG completion do not use umbrella diagnostics. The
validator emits the specific violated lifecycle, relation, supersession,
Resource, body, or CHG rule from the tables above. Multiple such diagnostics
remain valid only when each describes a separately actionable defect.

After primary ownership is applied, diagnostics are deduplicated by `code` and
the complete structured primary and related locations, excluding human message
text. Two findings with that same identity produce one diagnostic. Message text
does not create a second machine finding.

### Deterministic ordering

Diagnostics are sorted by:

1. severity order: error, warning, info;
2. project-relative path in bytewise order;
3. line;
4. column;
5. diagnostic code; and
6. field or section path.

Diagnostics without a path or source location sort after diagnostics that have
the corresponding value. For a multi-file finding, the bytewise smallest path
is the primary location and the others are related locations.

Parallel execution MUST NOT affect output order.

## Validation Policies

### Default policy

Default validation:

- executes every Core deterministic check for the requested scope;
- fails on errors;
- does not fail on warnings or info;
- performs no network access;
- performs no nondeterministic semantic or LLM review;
- does not mutate source files; and
- may report unavailable optional hooks as info.

The output summary MUST state the requested scope so snapshot success is not
mistaken for transition validation.

### Warnings-as-errors policy

Warnings-as-errors causes any warning to make validation invalid. Warning
diagnostics retain `severity: warning`; policy changes outcome, not diagnostic
meaning.

Info diagnostics never become failing findings under this policy.

### Strict policy

Strict mode is equivalent to:

```text
warnings-as-errors
+
no unavailable Core check required by the requested scope
```

A dependent check suppressed because a domain finding made its input
unreliable is blocked, not an unavailable or skipped validator capability. It
does not turn a complete invalid strict run into an incomplete run.

Strict does not change snapshot into transition or select a baseline implicitly.

Therefore:

```text
strict snapshot
  = complete warning-free current-state validation

strict transition
  = complete warning-free before-and-after validation
```

If required context or a Core validator capability is unavailable, strict
validation is incomplete rather than successful.

## CI Contract

### Exit codes

EF validation uses four stable process exit codes:

| Exit code | Meaning |
|---:|---|
| `0` | Validation completed and is valid under the selected policy |
| `1` | Validation completed and found invalid findings under the selected policy |
| `2` | Requested validation could not complete |
| `3` | Internal validator failure |

Exit codes do not encode finding counts.

#### Exit `0`

There are no errors. When warnings-as-errors or strict is enabled, there are no
warnings. Every required validator completed.

#### Exit `1`

Validation completed and found at least one error, or found a warning under a
policy that treats warnings as failing.

Content parse failures, duplicate IDs, missing declared Resources, and invalid
graphs are findings and therefore use exit `1` when the requested validation
otherwise completes.

A discovered, readable configuration that violates the config schema is a
domain finding and uses exit `1`. Configuration causes exit `2` only when it
cannot be obtained or interpreted sufficiently to establish the requested
project and validation contract.

#### Exit `2`

Validation cannot produce the requested complete conclusion. Examples include
invalid invocation, configuration that cannot be parsed sufficiently to
discover the project contract, missing transition baseline, unreadable required
input due to execution permissions, unavailable Core validator capability, or
failed previous-state materialization.

A declared Resource path that does not exist is repository invalidity and uses
exit `1`; inability of the validator process to access its required execution
environment uses exit `2`.

An invalid baseline makes transition comparison incomplete. Baseline findings
are reported, dependent transition checks are blocked, and transition scope
returns exit `2`.

#### Exit `3`

An internal invariant failure, panic, or validator implementation defect uses
exit `3`.

#### Priority

When multiple outcomes occur, exit priority is:

```text
internal failure (3)
> incomplete execution (2)
> invalid findings (1)
> success (0)
```

### CI execution

Authoritative CI MUST supply the pinned pre-integration first-parent commit as
the transition baseline and the exact candidate commit as the proposed commit,
and SHOULD use:

```text
scope: transition
strict: true
baseline: pinned pre-integration first-parent commit
proposed: exact candidate commit whose first parent is baseline
```

CI validation is read-only, non-interactive, deterministic, and network-free.
It validates the complete explicit proposed commit tree rather than treating
changed files as isolated documents.

Missing derived caches do not fail validation because caches are rebuildable.
Validation MAY construct temporary in-memory or disposable derived indexes.

CI MUST NOT format, repair, reorder, or generate authoritative files implicitly.

### Invalid baseline policy

EF Core v1 does not define a mode that ignores baseline errors and validates
only newly introduced findings. Authoritative baselines are required to be
valid before reliable transition attribution.

A future explicit migration or debt policy can define a controlled exception;
default validation does not allow an invalid authoritative state to persist
silently.

## Validation Summary

Machine-readable validation output includes summary semantics equivalent to:

```json
{
  "scope": "transition",
  "baseline_oid": "0123456789abcdef0123456789abcdef01234567",
  "proposed_oid": "fedcba9876543210fedcba9876543210fedcba98",
  "integration_ref": "refs/heads/main",
  "expected_ref_oid": "0123456789abcdef0123456789abcdef01234567",
  "strict": true,
  "warnings_as_errors": true,
  "complete": true,
  "valid": false,
  "counts": {
    "error": 2,
    "warning": 1,
    "info": 0
  },
  "exit_code": 1
}
```

Rules:

- `scope` is `snapshot`, `transition`, or explicit bootstrap validation.
- `baseline_oid` is the supplied full commit OID when it passed lexical
  validation; it is null when no usable OID was supplied and for snapshot or
  bootstrap scope. A complete transition requires a non-null value.
- `proposed_oid` is the supplied full proposed commit OID when it passed
  lexical validation; it is null for snapshot scope or when no usable OID was
  supplied. Complete transition and bootstrap validation require a non-null
  value.
- `integration_ref` is the authoritative full local branch ref selected from
  the trusted baseline configuration for transition, the proposed
  configuration for bootstrap, or the current configuration for snapshot. It
  is null when no applicable valid configuration could be loaded.
- `expected_ref_oid` is the operation-start OID captured from `integration_ref`
  for transition and bootstrap, or null when that ref was unresolved. A
  complete transition requires it to equal `baseline_oid`. It is always null
  for snapshot scope. On an incomplete result, null can also mean that the ref
  state could not be established; `complete` distinguishes that case from a
  complete bootstrap whose expected ref state is absence.
- `complete` is false when exit is `2` or `3`.
- `valid` reflects the selected finding policy.
- `valid` MUST be false when `complete` is false.
- warnings remain counted as warnings under warnings-as-errors.
- counts reflect emitted diagnostics after deterministic deduplication.

Phase 13 defines the containing `ef/validation-result@1` JSON envelope and
streaming behavior.

## Deterministic Boundary

Core integrity validation MUST NOT depend on:

- LLM semantic judgment;
- remote URL availability;
- external CI-provider state;
- current time-dependent remote rules;
- unpinned network schemas; or
- nondeterministic heuristic scoring.

Separate authoring lint MAY advise that a requirement appears
implementation-specific, acceptance criteria may be unobservable, or rationale
may be insufficient. It MAY also advise that project language appears
inconsistent with the canonical Terminology glossary. Such lint:

- is advisory rather than Core integrity proof;
- is clearly distinguished from deterministic diagnostics;
- does not affect Core exit code by default; and
- MUST NOT be presented as a schema or graph error.

External network checks and semantic review are separate operations, not hidden
validation phases.

## Read-only Validation

Validation never modifies authoritative or proposed source files.

Formatting, adding missing fields, repairing relations, reallocating provisional
IDs, creating template sections, or rewriting Resource descriptors are explicit
mutation operations. Mutations to active truth remain subject to CHG semantics.

## Examples

### Successful default snapshot

```text
scope: snapshot
errors: 0
warnings: 2
info: 1
complete: true
valid: true
exit: 0
```

Warnings do not fail default validation.

### Warnings-as-errors snapshot

```text
scope: snapshot
errors: 0
warnings: 2
info: 1
complete: true
valid: false
exit: 1
```

The warnings retain warning severity.

### Missing transition commit input

```text
scope: transition
complete: false
valid: false
exit: 2
```

The same outcome applies when either the required baseline or proposed commit
is missing or cannot be materialized. Validation does not silently fall back to
snapshot success.

### Parse failure without cascades

When `REQ-031.md` frontmatter cannot parse, validation reports the parse
diagnostic and suppresses speculative missing-field and body-state findings for
that file. Independent files and project-level checks continue when safe.

## Validation Orchestration Diagnostics

Phase-specific diagnostics retain their previously defined codes. Validation
orchestration additionally defines:

| Code | Severity | Condition | Exit class |
|---|---|---|---:|
| `EF-VAL-001` | error | Requested validation scope or invocation is invalid | `2` |
| `EF-VAL-002` | error | Trusted transition baseline is invalid | `2` |
| `EF-VAL-004` | info | Draft content is incomplete but lifecycle permits it | unchanged |
| `EF-VAL-005` | info | Optional specialized validator is unavailable | unchanged |
| `EF-VAL-006` | error | Required Core validator capability is unavailable | `2` |
| `EF-VAL-007` | error | Requested validation result is incomplete | `2` |
| `EF-VAL-008` | error | Validator internal invariant failed | `3` |
| `EF-VAL-009` | error | Bootstrap ref already contains an EF state | `1` |
| `EF-VAL-010` | error | Proposed bootstrap contains a terminal knowledge Artifact or CHG | `1` |
| `EF-VAL-011` | error | Proposed OID is missing or lexically invalid, does not resolve to a commit, cannot be materialized, or has inapplicable parentage | `2` |

Execution-class diagnostics can have error severity while mapping to exit `2`
or `3`; exit class distinguishes incomplete or internal execution from completed
repository invalidity.

## Deferred

- Stable lookup, filters, trace traversal, impact queries, and query JSON are
  defined in Phase 10: Query and Trace.
- Project discovery, managed paths, configuration, baseline materialization,
  cache locations, and schema migration are defined in Phase 11: Filesystem and
  Configuration.
- Temporary input normalization is excluded from authoritative validation;
  retained-source validation is defined in Phase 12: Input Normalization and
  Promotion.
- CLI command syntax, output transport, JSON envelope, streaming, interruption,
  and non-interactive options are defined in Phase 13: CLI Contract.
- Full historical Git-DAG auditing, baseline-debt suppression, network
  availability checks, LLM semantic review, and automatic source repair are not
  part of deterministic EF Core v1 validation.
