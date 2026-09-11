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

### Range validation

Range validation compares a trusted range baseline with one explicit proposed
commit over the first-parent commit sequence between them. It evaluates every
authoritative EF state boundary that publishing that whole sequence would
create, using bootstrap semantics for the boundary that first introduces EF
state and transition semantics for every later boundary.

Range validation satisfies the transition-validation requirement for a candidate
that adds more than one new first-parent commit: every adjacent authoritative
boundary in the sequence is independently transition-validated instead of being
collapsed into one baseline-to-final-tree comparison. Transition validation
remains the exact single-boundary primitive and is semantically equivalent to
range validation over a sequence of length one.

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

### Trusted range baseline

A trusted range baseline is the captured pre-integration tip of the
authoritative `integration_ref` used as the exclusive start of a validated
range. The integration operation MUST supply its full commit OID externally, or
MUST omit that OID to assert that `integration_ref` was proven unresolved when
the operation began. Proposed repository content does not select or override it.

Unlike an ordinary trusted baseline, a trusted range baseline MAY contain no EF
state, and it is never itself validated as a proposed state. When it does
contain EF state, that state MUST be a complete valid authoritative state, and
its configuration is the trusted source of the authoritative `integration_ref`.

A trusted range baseline MUST be a member of the proposed commit's first-parent
chain, and the authoritative `integration_ref` MUST have resolved to exactly
that OID, or to nothing when the OID was omitted, when the operation began.

### Trusted proposed commit

A trusted proposed commit is the complete candidate authoritative EF state. The
integration operation supplies its full commit OID externally. For transition
scope, the proposed commit MUST use the trusted baseline as its first parent.
For bootstrap scope, its parentage follows the bootstrap rules. For range scope,
the trusted range baseline MUST be a member of its first-parent chain when a
baseline OID was supplied, and its first-parent chain MUST reach a root commit
otherwise. Validation materializes the commit and validates its complete tree;
it does not infer the candidate from the working tree, index, or `HEAD`.

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

### Range scope

Range validation validates one candidate integration range before publication.
Its inputs are a trusted range baseline, an explicit proposed commit, and the
operation-start state of the authoritative `integration_ref`. Every other fact
MUST be derived deterministically from Git objects.

#### Validated commit sequence

When a trusted range baseline OID is supplied, it MUST be a member of the
sequence formed by starting at the proposed commit and repeatedly taking its
first parent. The validated commit sequence is the first-parent commits strictly
after the trusted range baseline through the proposed commit inclusive,
evaluated oldest-first.

The walk is first-parent-only and that restriction is mandatory. A commit
reachable from the proposed commit only through a non-first parent is authoring
history: it is never part of the validated sequence, never validated, and never
an authoritative EF state. Non-first-parent ancestry never satisfies the
membership requirement.

The trusted range baseline is never validated as a proposed state. When the
baseline OID equals the proposed OID, the validated sequence is empty; that is a
legal complete valid result.

A baseline proven not to be a first-parent ancestor of the proposed commit,
including a proposed commit that is itself an ancestor of the baseline, is
`EF-VAL-011` and exits `2`. When the first-parent chain cannot be walked far
enough to decide membership because of a shallow boundary or an unreadable
object, the result is `EF-VAL-007` and exits `2`. Non-membership MUST NOT be
concluded from history the validator could not read. When no baseline OID is
supplied, the first-parent chain MUST reach a root commit; a shallow boundary
instead of a root commit is `EF-VAL-007`.

#### EF state identity and boundary classification

A commit's EF state is identified by the mode, object type, and object ID of its
`.engineering` tree entry, and is absent when the commit's tree has no such
entry. Two commits with equal triples have the same EF state.

Walking the validated sequence oldest-first from the baseline EF state, every
commit's incoming boundary has exactly one classification:

| Previous EF state | Commit EF state | Boundary |
|---|---|---|
| any | equal triple | identity |
| absent | present | bootstrap |
| present | present and distinct | transition |
| present | absent | EF-state removal |

An identity boundary is trivially valid. The validator MUST NOT materialize it,
snapshot-validate it, or emit any diagnostic for it. A commit that does not
change `.engineering` is therefore an identity transition rather than a skipped
commit, which makes the classification total and prevents an EF-state removal
from passing through as an ignored commit.

A bootstrap boundary is validated with bootstrap semantics: complete snapshot
validation of that commit's tree, the bootstrap state rules and `EF-VAL-010`,
and the bootstrap history condition established against that commit's first
parent. An `.engineering/ef.yaml` path found in that first-parent history is
`EF-VAL-009` and exits `1`; a shallow or unresolvable required history is
`EF-VAL-007` and exits `2`; a commit with no first parent satisfies the
condition vacuously and requires no probe. That commit's configuration fixes the
authoritative `integration_ref` for the whole range. The bootstrap exception is
available at most once per range and never after an EF state exists.

A transition boundary is validated as one ordinary authoritative transition from
the immediately preceding distinct EF state to this commit's EF state: complete
snapshot validation of the new state, preservation of the fixed
`integration_ref`, and every additional check listed for transition scope. No
synthetic baseline is invented.

An EF-state removal boundary is `EF-VAL-013`, attributed to that commit, and
stops the walk. The result is complete and invalid and exits `1`: deliberate
removal of authoritative state is a proven domain violation rather than
execution incompleteness.

Because the evaluated boundaries are exactly the boundaries of the first-parent
EF-bearing commit sequence, a range that validates as complete and valid cannot
later be reported as untrusted authoritative history by a first-parent history
query over the same published commits.

#### Transaction coverage inside a range

Every evaluated boundary is one complete engineering transaction in its own
right. One logical transaction MUST NOT be split across two EF-touching commits
in the same range: the earlier boundary changes a CHG-required target with no
covering completed CHG and is invalid at that boundary even when a later commit
in the same range supplies the CHG. Authors either squash the transaction into
one commit or make every EF-touching commit independently transaction-valid.

A merge commit on the first-parent chain is validated exactly like any other
commit. Its non-first parents are never walked, so a merge that introduces EF
changes through a non-first parent is evaluated as one boundary aggregating all
of those authoring commits, and that aggregate MUST itself be one valid
transaction.

#### Ref selection, capture, and staleness

The authoritative `integration_ref` is read only from a trusted commit tree:

- from the trusted range baseline's configuration when that baseline contains a
  decodable EF state; otherwise
- from the configuration of the range's bootstrap boundary — the oldest commit
  in the validated sequence whose EF state is present — exactly as bootstrap
  scope trusts the bootstrapping commit's own configuration.

The value is never read from a commit later in the sequence than the boundary
being evaluated. Selecting it from the proposed commit would let a later
commit's content decide an earlier boundary's outcome, contradicting
oldest-first walk termination: a range whose proposed commit removes the EF
state, or whose later configuration is malformed, MUST still report the earlier
boundary's own finding first. Every EF state in the range from that boundary
onward MUST declare the same ref. Any deviation is `EF-VAL-002` and exits `2`.

When the range's bootstrap boundary names no valid `integration_ref` at all,
that state is itself invalid: no authoritative ref exists for the range, no
ref-state check is performed, and the result is complete and invalid on that
boundary's own findings with `integration_ref` and `expected_ref_oid` null.

Operation-start ref state is an explicit validation input. The integration
operation captures the state of the authoritative ref once before validation and
supplies a proven OID, proven absence, or a probe failure. The validator MUST
NOT resolve or re-resolve that ref itself. The captured ref name MUST equal the
authoritative `integration_ref`; a mismatch is `EF-VAL-002`. Identifying which
commit fixes that ref is a read of immutable Git objects — the `.engineering`
tree entry of the endpoints and of the first-parent sequence between them, and
then that one commit's configuration — and is not itself validation: it
materializes nothing, evaluates no rule, and emits no finding. The single
mutable observation, the ref probe, still happens exactly once, after that
identification and before any boundary is evaluated. A caller that supplies no
captured ref state at all while the range has an authoritative `integration_ref`
has not met this obligation: the result is `EF-VAL-006` and exits `2`, and the
absence of a capture MUST NOT be read as proven ref absence.

That one-time capture MUST be performed by probing the exact `integration_ref`
name in the local Git repository the operation is bound to, using that
repository's own ref database, never by inspecting a remote-tracking ref, a
hosting-provider API, or a value asserted through any other channel. A range
whose local repository never materializes that ref name — as a resolvable ref
or as a provable absence — cannot supply a valid captured ref state, regardless
of which commit is otherwise checked out or reachable there.

A complete range result that has an authoritative `integration_ref` requires the
captured operation-start OID to equal the trusted range baseline OID: either
both are present and equal, or both are absent. Any other combination is
`EF-VAL-002` and exits `2`. A failed ref probe is `EF-VAL-006`, exits `2`, and
MUST NOT be folded into proven absence. A complete result whose
`integration_ref` is null — an EF-inert range, or a range whose first EF state
named no valid `integration_ref` — performs no such check and reports
`expected_ref_oid` as null.

Running range validation after `integration_ref` has already advanced to the
proposed commit is therefore stale by construction and reports `EF-VAL-002` with
exit `2`.

#### Read-only derivation

Range validation performs no ref mutation, no branch checkout, and no
authoritative working-tree materialization. The validator MUST NOT require the
caller to advance `integration_ref`, or any other ref, per intermediate commit
to emulate the historical ref state that commit would have had. Every boundary
MUST be derived deterministically from Git objects plus the one captured
operation-start ref state.

#### Walk termination

Range validation reports the findings of the first state or boundary that
produces an error-severity diagnostic and then stops. Later states and
boundaries are blocked dependent checks and produce no diagnostics: feeding an
already-invalid state into a later boundary comparison would emit the
speculative aliases the cascading rules prohibit. No boundary's outcome may
depend on content from a commit later in the sequence; in particular the
authoritative `integration_ref` is never read from the proposed commit when a
bootstrap boundary inside the range fixes it.

Warning-severity findings never stop the walk, including under strict or
warnings-as-errors policy, because policy changes outcome rather than diagnostic
meaning.

A blocked dependent check is not an unavailable Core capability, so an
error-severity finding inside the range keeps the run complete and exits `1`. An
invalid trusted range baseline is different: it is an untrusted baseline rather
than proposed content, and reports `EF-VAL-002` with `complete: false` and exit
`2`.

#### Ranges with no EF state

When neither the trusted range baseline nor any commit in the validated sequence
has an `.engineering` entry, including when the validated sequence is empty, no
EF state boundary exists to validate. The result is complete and valid, exits
`0`, and carries exactly one `EF-VAL-014` info diagnostic. `integration_ref` and
`expected_ref_oid` are null and no ref state check is performed because no EF
publication occurs. A range whose baseline EF state is present is never this
case, so an EF-inert result cannot be used to bypass validation.

#### Shallow and incomplete history

Range validation needs first-parent history only between the two endpoints, so a
shallow clone that fully contains the validated sequence validates normally.
History older than the trusted range baseline is not required, except for a
bootstrap boundary, whose pre-bootstrap `.engineering/ef.yaml` absence probe
requires complete first-parent history before the bootstrap commit. A
bootstrap-bearing range in a shallow clone is therefore `EF-VAL-007` and exits
`2`, exactly as it already is for bootstrap scope. Shallowness is never used to
conclude non-membership or absence.

#### Object format

Every supplied OID MUST be a full OID for the project repository's own object
format. A wrong-length or non-hexadecimal value is a lexical failure:
`EF-VAL-002` for the trusted range baseline and `EF-VAL-011` for the proposed
commit. OID comparisons in the range walk use repository-normalized values, so a
supplied uppercase-hexadecimal OID still matches its commit.

#### Publication

Exactly one atomic conditional ref update publishes a complete valid range. Its
expected old value is the validated trusted range baseline OID, or ref absence
when no baseline OID was supplied, and its new value is the validated proposed
OID. Per-commit ref updates are neither required nor permitted, and a separate
check followed by an unconditional update is not conforming. When the range
contains a bootstrap boundary, the bootstrap history condition MUST be
re-checked immediately before the update. A failed compare-and-swap makes the
result stale, and the range MUST be revalidated from the actual boundary.

Once published, every EF-bearing first-parent commit in the range is an
authoritative EF state and every adjacent distinct pair is an authoritative
integration transition. That is exactly why each of them MUST be validated
before publication.

#### Distinction from history auditing

Range validation is a pre-publication operation over a captured boundary: the
trusted range baseline is the operation-start OID of `integration_ref` and the
proposed commit is not yet published. It proves the range and authorizes
nothing; a separate integration operation consumes the result.

History auditing evaluates already-published state reachable from the
authoritative ref, has no expected-ref-state obligation, and cannot make
anything authoritative. Core v1 defines no post-publication audit scope.

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
scope, policy, and the transition or range baseline.

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

This phase runs in transition scope, and in range scope once per evaluated
non-identity boundary. It compares the trusted baseline and proposed result to
validate identity, lifecycle, immutable content, deletion, CHG effects, Resource
mutation, exactly-once coverage, supersession, and atomicity.

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
| `commit_oid` | full commit OID string | No |
| `related` | array of related-location objects | Yes, may be `[]` |

`commit_oid` attributes one finding to the one commit whose EF state or
incoming boundary produced it. It is present only in range scope, and only for
a finding evaluated at one commit's EF state or at one commit's incoming
boundary; a boundary finding attaches to that boundary's later commit, which
is the commit that introduced the violation. A range-level finding that
belongs to no single commit, such as an ancestry, captured-ref-state,
shallow-history, or EF-inert-range finding, omits it. Every other scope omits
it.

`commit_oid` is attribution for a diagnostic that exists; it MUST NOT be
documented or read as a means of enumerating or deriving the validated commit
sequence, and consumers MUST NOT rely on it for that purpose. Three properties
of range validation make that reading unsound: an identity boundary emits no
diagnostic at all (above, "An identity boundary is trivially valid"); walk
termination omits diagnostics for every boundary after the first
error-severity one (see "Walk termination" below); and a range whose every
boundary is clean, including a range with no EF state boundary at all, carries
an empty or near-empty diagnostic list even though its validated commit
sequence is non-empty. The validated commit sequence is derived from Git
objects with `git rev-list --first-parent <baseline>..<proposed>`, and only
after a complete range result has already proved first-parent ancestry between
those two OIDs.

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
      "path": ".engineering/req/REQ-044.md",
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
| `EF-FS-*` | Filesystem layout, configuration, workspace association, and text representation |
| `EF-ID-*` | Identity, canonical Artifact path, uniqueness, and singleton rules |
| `EF-LIFE-*` | Status applicability and transition, whole-Artifact freeze, and Artifact deletion |
| `EF-REL-*` | Relation entry representation, compatibility, targets, and non-supersession graph rules |
| `EF-SUP-*` | Supersession topology, atomicity, and validation-time current resolution |
| `EF-RES-*` | Resource descriptor, file, ownership, and Resource freeze rules |
| `EF-CHG-*` | Effect classification, coverage, provenance, and transaction semantics |
| `EF-BODY-*` | Markdown and body-schema structure |
| `EF-VAL-*` | Validation invocation, capability, completeness, and internal orchestration |

The central [Diagnostic Registry](diagnostic-registry.md) indexes every Core
code, owner, severity, scope, and exit treatment. Numeric gaps are reserved and
MUST NOT be reused without updating that registry and the owning specification.

When a more specific diagnostic reports a primary violation, whether in the
same or another namespace, dependent phases MUST NOT emit a broader alias for
the same violation. They MAY emit a distinct diagnostic only when it describes
an independently actionable violation. Query operations wrap query-time
failure in `EF-QRY-*` as defined by [Query and Trace](10-query-and-trace.md) rather than re-emitting
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
| A commit in a validated integration range removes the authoritative EF state | `EF-VAL-013`; the missing-configuration finding and per-Artifact deletion findings for that commit are suppressed |
| A range state or boundary reports an error | That state's or boundary's findings; later states and boundaries are blocked dependent checks and produce no diagnostics |

Supersession atomicity and CHG completion do not use umbrella diagnostics. The
validator emits the specific violated lifecycle, relation, supersession,
Resource, body, or CHG rule from the tables above. Multiple such diagnostics
remain valid only when each describes a separately actionable defect.

After primary ownership is applied, diagnostics are deduplicated by `code`,
`commit_oid`, and the complete structured primary and related locations,
excluding human message text. Two findings with that same identity produce one
diagnostic. Message text does not create a second machine finding.

`commit_oid` participates in that identity because two genuinely distinct
defects evaluated at two different boundaries of one validated range can share a
code and a path; without commit attribution they would silently collapse into
one finding.

### Deterministic ordering

Diagnostics are sorted by:

1. severity order: error, warning, info;
2. project-relative path in bytewise order;
3. line;
4. column;
5. diagnostic code;
6. field or section path; and
7. `commit_oid` in bytewise order.

Diagnostics without a path, source location, or `commit_oid` sort after
diagnostics that have the corresponding value. For a multi-file finding, the
bytewise smallest path is the primary location and the others are related
locations.

`commit_oid` is the final tiebreaker rather than a grouping key, so no output
that omits it is reordered. Human output MAY group findings by commit; that
grouping is presentation and is not a machine contract.

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

strict range
  = complete warning-free validation of every evaluated boundary
    in the validated commit sequence
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
returns exit `2`. An invalid trusted range baseline is treated the same way. An
error-severity finding at a state or boundary inside a validated range is
proposed content rather than an untrusted baseline and therefore uses exit `1`.

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

When the candidate may add more than one new first-parent commit, CI SHOULD
instead use range scope with the same pinned pre-integration tip:

```text
scope: range
strict: true
baseline: pinned pre-integration ref tip, omitted when the ref was
          proven unresolved at operation start
proposed: exact candidate commit whose first-parent chain contains baseline
```

CI SHOULD use transition scope when the candidate is exactly one boundary and
range scope otherwise. Both scopes require the pinned operation-start ref tip;
neither derives it from the candidate.

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

- `scope` is `snapshot`, `transition`, `range`, or explicit bootstrap
  validation.
- `baseline_oid` is the supplied full commit OID when it passed lexical
  validation; it is null when no usable OID was supplied and for snapshot or
  bootstrap scope. A complete transition requires a non-null value. On a
  complete range result, null means that the caller supplied no baseline OID and
  validation proved that `integration_ref` was unresolved at operation start;
  `complete` distinguishes that from a range whose baseline could not be
  established.
- `proposed_oid` is the supplied full proposed commit OID when it passed
  lexical validation; it is null for snapshot scope or when no usable OID was
  supplied. Complete transition, bootstrap, and range validation require a
  non-null value.
- `integration_ref` is the authoritative full local branch ref selected from
  the trusted baseline configuration for transition, the proposed
  configuration for bootstrap, or the current configuration for snapshot. For
  range it is selected from the trusted range baseline's configuration when
  that baseline's `.engineering` entry is present, and otherwise from the
  configuration of the range's bootstrap boundary — the oldest commit in the
  validated sequence whose EF state is present. It is null when no applicable
  valid configuration could be loaded, and null on a complete range result
  that evaluated no EF state boundary or whose first EF state named no valid
  `integration_ref`.
- `expected_ref_oid` is the operation-start OID captured from `integration_ref`
  for transition, bootstrap, and range, or null when that ref was unresolved. A
  complete transition requires it to equal `baseline_oid`. A complete range
  whose `integration_ref` is non-null requires it to equal `baseline_oid` as
  well, with both values null when the caller asserted and validation proved
  that the ref was unresolved; a complete range whose `integration_ref` is null
  (EF-inert, or a first EF state that named no valid `integration_ref`) reports
  it as null and makes no such comparison. It is always null for snapshot
  scope. On an incomplete result, null can also mean that the ref state could
  not be established; `complete` distinguishes that case from a complete
  bootstrap or range whose expected ref state is absence.
- `complete` is false when exit is `2` or `3`.
- `valid` reflects the selected finding policy.
- `valid` MUST be false when `complete` is false.
- warnings remain counted as warnings under warnings-as-errors.
- counts reflect emitted diagnostics after deterministic deduplication.

[CLI Contract](13-cli-contract.md) defines the containing `ef/validation-result@1` JSON envelope and
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

### Bootstrap inside a validated range

```text
scope: range
baseline: pre-EF ref tip
sequence: C1 (code only), C2 (bootstrap), C3 (transition)
boundaries: identity at C1, bootstrap at C2, transition at C3
complete: true
valid: true
exit: 0
```

`integration_ref` comes from the bootstrap commit's configuration,
`expected_ref_oid` equals `baseline_oid`, and one atomic conditional update from
that baseline to C3 publishes the whole range.

### Failing intermediate range boundary

```text
scope: range
sequence: C1, C2, C3
boundaries: transition at C2 reports EF-CHG-005
complete: true
valid: false
exit: 1
```

The finding carries `commit_oid` for C2. C3 is a blocked dependent check and
produces no diagnostics, and the run remains complete because blocking on an
error is not an unavailable capability.

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
| `EF-VAL-012` | error | An incomplete working-tree initialization claim exists | `2` |
| `EF-VAL-013` | error | A commit in the validated integration range removes the authoritative EF state | `1` |
| `EF-VAL-014` | info | Validated integration range contains no EF state boundary | unchanged |

Execution-class diagnostics can have error severity while mapping to exit `2`
or `3`; exit class distinguishes incomplete or internal execution from completed
repository invalidity.

## Deferred

- Stable lookup, filters, trace traversal, impact queries, and query JSON are
  defined in [Query and Trace](10-query-and-trace.md).
- Project discovery, managed paths, configuration, baseline materialization,
  cache locations, and schema migration are defined in [Filesystem and Configuration](11-filesystem-and-config.md).
- Temporary input normalization is excluded from authoritative validation;
  retained-source validation is defined in [Input Normalization and Promotion](12-input-normalization.md).
- CLI command syntax, output transport, JSON envelope, streaming, interruption,
  and non-interactive options are defined in [CLI Contract](13-cli-contract.md).
- Full historical Git-DAG auditing, baseline-debt suppression, network
  availability checks, LLM semantic review, and automatic source repair are not
  part of deterministic EF Core v1 validation. Range validation is a
  pre-publication proof over a captured boundary and is not a post-publication
  audit scope; post-publication history auditing remains deferred.
