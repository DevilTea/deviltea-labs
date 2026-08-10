# EF Core: CLI Contract

Status: Accepted

## Scope

This document defines the EF Core v1 command surface, project selection,
human and machine output, validation and query transport, Resource reading,
mutation authorization, non-interactive behavior, process exit codes, CI and
editor integration, write safety, and the boundary between CLI filesystem
operations and Git engineering transactions.

The CLI is a thin interface over Git-native EF files. It is not the exclusive
authoring interface and does not implement a general workflow engine or text
editor.

## Command Surface

EF Core v1 defines these commands:

```text
ef init
ef artifact create
ef validate
ef query
ef resource read
ef version
ef help
```

Implementations MUST NOT assign incompatible behavior to these command paths.
Additional namespaced commands MAY be added by a later specification, but Core
v1 defines no aliases such as `show`, `find`, or `ls`.

Read-only commands never repair, format, reorder, migrate, or otherwise mutate
authoritative files.

## Common Options

Commands that operate on a project accept:

```text
--project <project-root>
```

When omitted, [Filesystem and Configuration](11-filesystem-and-config.md) upward discovery applies except for `ef init`, whose
target-selection rule is defined below. There is no process-global or
user-global current-project state.

General result-producing commands accept:

```text
--format human|json
```

The default is always `human`; it does not depend on TTY detection. Human
commands also accept `--no-color`.

Every project command accepts:

```text
--no-input
```

Read-only commands never prompt, so this option is an explicit automation
guarantee rather than a semantic change. Mutation commands additionally accept:

```text
--dry-run
--yes
```

Options that do not apply to a command are invalid invocation rather than
silently ignored.

## Project Initialization

```text
ef init
```

`init` initializes EF in an existing Git worktree root. It does not execute
`git init`, clone repositories, or modify unrelated project content.

When `--project` is omitted, `init` selects the Git worktree root containing the
current directory; it does not attempt EF configuration discovery. When
`--project` is present, the supplied path MUST be exactly an existing Git
worktree root. In both cases, absence or ambiguity is an incomplete invocation.

It creates one new canonical `.engineering` directory containing:

- `ef.yaml`;
- `.gitignore` containing the canonical EF runtime ignore rules;
- an active `PROJECT.md`;
- canonical Artifact directories;
- the managed Resource directory.

These directories may exist locally after initialization but require no tracked
placeholder files; Git clones recreate them when the first contained
authoritative file is created.

It MUST refuse to overwrite or merge with an existing `.engineering` path.

Interactive initialization obtains every value needed for a valid bootstrap.
Non-interactive initialization requires explicit values equivalent to:

```text
--title <text>
--summary <text>
--vision <markdown>
--project-scope <markdown>
--non-goals <markdown>
--context <markdown>
--integration-ref <full-local-branch-ref>
```

It additionally accepts:

```text
--terminology <markdown-table>
```

Interactive initialization MAY suggest the currently checked-out local branch
as the integration ref, but MUST display the full `refs/heads/...` value and
require confirmation. Detached HEAD, an unborn branch, or an unavailable
current branch requires explicit input. Core v1 has no hard-coded `main`
default because `integration_ref` becomes immutable after bootstrap. The
resulting config still serializes every required field, including
`linked_repositories: []`.

Initialization validates the complete bootstrap content candidate before local
filesystem publication. It also verifies that the configured local integration
branch has no `.engineering/ef.yaml` path anywhere in its existing first-parent
history. This local mutation check does not authorize Git publication: after
the candidate is committed, authoritative admission requires explicit
commit-bound `ef validate --scope bootstrap --proposed <full-commit-oid>`.
When `--terminology` is omitted, initialization emits the required PROJECT
`## Terminology` table with its canonical header and no data rows. When the
option is present, its value MUST produce a structurally valid canonical table;
zero or more valid canonical term rows are permitted. Interactive initialization
MAY collect rows and render the canonical table, MUST allow the user to skip
term entry, and MUST NOT invent project terms.

## Draft Artifact Creation

```text
ef artifact create <type>
```

The Core v1 type tokens are:

```text
prd
req
adr
pol
chg
```

PROJECT is created only by `ef init`.

Creation:

- allocates the next provisional ID under the identity rules;
- creates exactly one new canonical Artifact file;
- emits every required core field;
- emits `tags: []`, `relations: []`, and `resources: []`;
- emits the required type-specific level-two headings;
- uses `status: draft`; and
- refuses to overwrite any existing path or ID.

`--title <text>` and `--summary <text>` supply the two required non-empty
authoring values. Interactive human mode may ask for them. Non-interactive mode
requires both explicitly and MUST NOT infer them from filenames, repository
names, source input, or generated prose.

Draft body sections may remain incomplete under the Artifact Body Schema.

Core v1 defines no general CLI command for edit, delete, activate, retire,
supersede, CHG completion, Resource mutation, relation mutation, or active
schema migration. Those operations may be authored directly as files and are
accepted only through complete transition validation. No delete command is
provided because issued authoritative files are never physically deleted.

## Validation Command

```text
ef validate [--scope snapshot|transition|bootstrap|range]
```

The default scope is `snapshot`.

Options are:

```text
--baseline <full-commit-oid>
--proposed <full-commit-oid>
--strict
--warnings-as-errors
--workspace
```

`--baseline` is valid only for transition and range scope and accepts only a
full commit OID for the project repository's object format. It is required for
transition scope, optional for range scope, and invalid for snapshot or
bootstrap scope. For transition scope the validator materializes that commit,
reads its fixed `integration_ref`, verifies that the ref resolved to the same
OID when the operation began, and rejects a differing proposed
`integration_ref`. An arbitrary historical revision is not a trusted baseline.
Omitting the option in transition scope exits `2` without falling back to
snapshot validation.

For range scope, `--baseline` names the captured pre-integration tip of the
authoritative `integration_ref`. It need not contain EF state. Omitting it in
range scope is an explicit assertion that `integration_ref` was proven
unresolved when the operation began — for example, an integration process that
observes the ref as genuinely unborn and then itself performs the creating
compare-and-swap; validation requires that assertion to be true and otherwise
exits `2`. Core v1 defines no all-zeros OID sentinel for ref absence: a
supplied all-zeros value resolves to no commit and is an unusable baseline. The
validator still requires the captured operation-start ref OID to equal
`--baseline`, so an already-advanced ref is reported as a stale baseline and
exits `2`.

The validator establishes that operation-start state by probing the exact
`integration_ref` name in the local Git repository the command is bound to —
the resolved project root, using that repository's own ref database — never by
inspecting a remote-tracking ref, a hosting-provider API, or a value asserted
through any other channel. A caller MUST ensure that ref name is materialized,
or genuinely absent, in that same local repository before the command runs; a
repository that holds only a detached candidate commit, without the
authoritative ref name itself resolving or provably failing to resolve there,
cannot satisfy either a supplied `--baseline` or an omitted one. The command
identifies that ref name from a trusted commit tree before probing it: the
`--baseline` commit's configuration when that commit carries EF state, and
otherwise the configuration of the oldest commit on the validated first-parent
sequence that does — the range's bootstrap boundary. It never reads the
`--proposed` commit's configuration to select the ref.

`--proposed` is required for transition, bootstrap, and range scope and invalid
for snapshot scope. It accepts only a full commit OID for the project
repository's object format. The validator materializes exactly that commit; it
does not use the working tree, index, or `HEAD` as an implicit substitute. In
transition scope its first parent MUST equal `--baseline`. In bootstrap scope
its parentage and integration-ref history MUST satisfy [Filesystem and Configuration](11-filesystem-and-config.md). In
range scope `--baseline`, when supplied, MUST be a member of its first-parent
chain, and the validated commit sequence is the first-parent commits after that
baseline through the proposed commit inclusive. A missing, unresolvable, or
inapplicable proposed commit makes validation incomplete and exits `2`.

Core v1 defines no `--before` or `--after` option and no alias for `--baseline`
or `--proposed`. Range endpoints use exactly these two existing options.

`--workspace` adds [Filesystem and Configuration](11-filesystem-and-config.md) workspace checks to the requested core validation
scope. It does not redefine snapshot, transition, bootstrap, range, or strict
mode. For transition and range scope it uses the `--proposed` commit's
configuration.

The command validates the complete requested state. It does not provide a
changed-files-only mode or silently fall back from transition to snapshot.

### Validation JSON

Machine-readable validation produces exactly:

```json
{
  "schema": "ef/validation-result@1",
  "kind": "validation",
  "scope": "transition",
  "baseline_oid": "0123456789abcdef0123456789abcdef01234567",
  "proposed_oid": "fedcba9876543210fedcba9876543210fedcba98",
  "integration_ref": "refs/heads/main",
  "expected_ref_oid": "0123456789abcdef0123456789abcdef01234567",
  "strict": true,
  "warnings_as_errors": true,
  "workspace": false,
  "complete": true,
  "valid": true,
  "counts": {
    "error": 0,
    "warning": 0,
    "info": 0
  },
  "exit_code": 0,
  "diagnostics": []
}
```

All keys are required. `scope` is `snapshot`, `transition`, `bootstrap`, or
`range`.
`baseline_oid` contains the supplied full OID when it passed lexical validation;
it is null when no usable OID was supplied and for snapshot or bootstrap. A
complete transition requires a non-null value. On a complete range result, null
means the caller supplied no baseline OID and validation proved the ref was
unresolved at operation start. Diagnostic objects follow [Validation and Integrity](09-validation.md). `proposed_oid` contains the supplied full proposed OID when it passed lexical
validation; it is null for snapshot or when no usable OID was supplied.
Complete transition, bootstrap, and range results require it to be non-null.
`integration_ref` contains the applicable authoritative full local branch ref,
or null when no valid applicable configuration could be loaded; for a complete
range result that evaluated no EF state boundary, or whose first EF state named
no valid `integration_ref`, it is null.
`expected_ref_oid` contains the operation-start OID captured from that ref for
transition, bootstrap, or range, and is null for an unresolved bootstrap or
range ref or for snapshot scope. A complete transition requires
`expected_ref_oid == baseline_oid`; a complete range whose `integration_ref` is
non-null requires the same equality with both values possibly null, and a
complete range whose `integration_ref` is null reports `expected_ref_oid` as
null and makes no such comparison. On an incomplete result, null may
instead mean that ref state could not be established; `complete` disambiguates
it.
`exit_code` exactly matches process exit status. Strict mode implies
warnings-as-errors but both booleans remain explicit.

The envelope schema is not versioned up for range scope. `scope` gains the value
`range`, which a consumer can observe only in response to its own
`--scope range` invocation, and no top-level key is added or removed. Diagnostic
objects MAY carry the optional `commit_oid` key defined by [Validation and Integrity](09-validation.md); it appears
only in range scope and is omitted rather than null otherwise. `commit_oid`
attributes an emitted diagnostic to the one commit whose EF state or incoming
boundary produced it; it MUST NOT be read as an enumeration of the validated
commit sequence, because identity boundaries emit no diagnostic by design, a
clean transition or bootstrap boundary may likewise emit none, fail-fast walk
termination omits diagnostics for every boundary after the first
error-severity one, and a fully conforming range can therefore carry an empty
diagnostic list end to end (see [Validation and Integrity](09-validation.md)).
The validated commit sequence is intentionally not exposed as an envelope key;
a consumer derives it with `git rev-list --first-parent <baseline>..<proposed>`
only after a complete range result has already proved first-parent ancestry
between those two OIDs.

## Query Commands

Query commands map one-to-one to the [Query and Trace](10-query-and-trace.md) query kinds:

```text
ef query lookup
ef query list
ef query search
ef query relations
ef query trace
ef query impact
ef query history
ef query resolve-current
```

Every JSON query response is the existing `ef/query-result@1` envelope. Query
commands are read-only and never include Resource file bytes.

### Lookup

```text
ef query lookup <artifact-id> [--projection summary|full]
```

The default projection is `full`. Lookup is exact and does not resolve
supersession. `found: false` is a complete normal result and exits `0`.

### List

```text
ef query list [filters] [--offset <n>] [--limit <n>]
```

Stable filter options are:

```text
--type <value>
--status <value>
--schema <value>
--tag-any <value>
--tag-all <value>
--relation-type <value>
--relation-target <artifact-id>
--resource-type <value>
--resource-role <value>
--resource-normative true|false
```

Options corresponding to multi-value [Query and Trace](10-query-and-trace.md) filters may be repeated. Repeated
values retain [Query and Trace](10-query-and-trace.md) OR or AND semantics. `--offset` defaults to `0`;
omitting `--limit` represents JSON `null` and returns all matches.

### Search

```text
ef query search <term>... [--case-sensitive] [--offset <n>] [--limit <n>]
```

At least one term is required. Multiple terms use [Query and Trace](10-query-and-trace.md) Artifact-scope AND
semantics. Search remains normalized literal search without relevance scoring.

### Direct relations

```text
ef query relations <artifact-id>
  [--direction outgoing|incoming|both]
  [--type <relation-type>]...
```

Direction defaults to `both`. Omitting every `--type` includes every relation
type.

### Trace

```text
ef query trace <root-id>...
  --type <relation-type>...
  --direction outgoing|incoming|both
  --max-depth <n>
```

At least one root and relation type are required. Direction and maximum depth
are explicit; the CLI does not guess traversal policy.

### Impact

```text
ef query impact <root-id>...
  --max-depth <n>
  [--include-references]
  [--include-non-current]
  [--resolve-current]
```

At least one root is required. Every option retains its [Query and Trace](10-query-and-trace.md) meaning.

### History

```text
ef query history <artifact-id>
```

History is exact and requires complete configured authoritative first-parent
integration history. Unavailable or shallow required history returns the [Query and Trace](10-query-and-trace.md) incomplete query result with `EF-QRY-010` and exits `2`; there is no CHG-only
fallback.

### Current resolution

```text
ef query resolve-current <artifact-id>
```

This is the only query command that resolves supersession. Other commands do
not enable it implicitly except the explicit impact `--resolve-current` option.

Lookup is the sole query with a successful not-found result. For relations,
trace, impact, history, and resolve-current, every explicitly supplied Artifact
ID must exist. If any required ID is absent, the command returns the [Query and Trace](10-query-and-trace.md)
incomplete query envelope with no partial data and exits `2`.

## Resource Reading

```text
ef resource read <owner-id> <location>
```

The command reads one explicitly selected local Resource. It first verifies
that:

- the exact owner Artifact exists;
- its descriptor declares the exact `location`;
- the location belongs to that owner;
- the managed local file exists and is valid; and
- the file is readable.

On success, stdout contains exactly the Resource file bytes. No newline,
decoding, rendering, framing, or JSON wrapper is added. The command does not
accept `--format` and never fetches external URLs. Resource metadata is obtained
through Artifact lookup.

On failure, stdout is empty, a diagnostic is written to stderr, and the stable
exit code applies. Callers MUST NOT treat stderr as a stable machine envelope
for this raw byte transport command.

Failure classes map to the stable exit codes as follows:

| Failure | Exit |
|---|---:|
| The supplied owner Artifact ID does not exist | `2` |
| The owner exists but declares no descriptor with the exact `location` | `2` |
| The `location` is declared by a different Artifact than the supplied owner | `2` |
| The descriptor exists but its managed local file is missing or is not a regular file | `1` |
| The managed path or its state violates repository integrity, such as a forbidden symlink | `1` |
| The file exists but cannot be read due to an execution or permission failure | `2` |

The first three are caller-supplied references that do not correspond to the
repository state, consistent with the query-command missing-ID rule. A declared
descriptor whose repository state is broken is a domain finding, consistent
with [Validation and Integrity](09-validation.md).

## Context Composition

EF Core v1 defines no separate `ef context` command. Explicit staged composition
uses:

```text
query list, search, or impact
  -> query resolve-current when requested
  -> query lookup --projection full
  -> resource read for explicitly selected local Resources
```

This avoids hidden traversal, automatic identity resolution, implicit Resource
loading, and tool-selected context. A caller may construct its own bundle from
the stable results.

## Human Output

Human output is designed for people and is not a machine contract. Wording,
spacing, and presentation may improve between compatible releases.

Human output:

- writes command results to stdout;
- writes prompts to stderr;
- may use color unless `--no-color` is present;
- MUST NOT change command semantics based on color or TTY state; and
- MUST NOT be documented as safe for script parsing.

## JSON Transport

For `--format json`, stdout contains exactly one UTF-8 JSON object followed by
one LF. It contains no ANSI escapes, progress output, prompts, headings, or
additional records.

JSON mode implies `--no-input`. Expected domain diagnostics are contained in
the result object and are not duplicated on stderr. Stderr is reserved for an
early runtime failure that prevents envelope construction or for a final crash
fallback.

The one-object guarantee begins only after the implementation recognizes a
Core command path, successfully parses `--format json`, and recognizes every
command-specific discriminator needed to select a fixed envelope, such as
validation scope or query kind. An unknown command or subcommand, an invalid
`--format` value, an invalid discriminator, or another syntax failure that
prevents selecting an envelope uses empty stdout, a human diagnostic on stderr,
and exit `2`. Once a fixed envelope is selected, later option, invocation,
discovery, or input failures MUST use that incomplete command envelope.

Arrays remain arrays for zero and one items. Fixed-schema nullable values are
explicit `null`. Paths in stable envelopes are canonical project-relative
paths and do not expose machine-specific absolute roots. Consumers MUST NOT
depend on JSON object key order.

## Mutation Planning and Authorization

Every Core mutation command computes a complete plan before writing.

`--dry-run` returns the plan without mutation. It does not require `--yes`.

In interactive human mode, the CLI displays the plan and requests confirmation.
Declining leaves the project unchanged and exits `2` because the requested
operation did not complete.

`--yes` authorizes the complete computed plan. `--no-input` prohibits prompts.
An actual mutation in `--no-input` mode requires `--yes`; otherwise it exits `2`
without writing. Because JSON mode implies `--no-input`, JSON mutation also
requires either `--dry-run` or `--yes`.

Authorization does not bypass validation, collision checks, immutability,
ownership, or target-existence rules.

### Mutation JSON

Machine-readable mutation output uses:

```json
{
  "schema": "ef/mutation-result@1",
  "kind": "artifact-create",
  "complete": true,
  "applied": false,
  "dry_run": true,
  "changes": [
    {
      "action": "create",
      "path": ".engineering/req/REQ-031.md"
    }
  ],
  "artifact": {
    "schema": "ef/requirement@1",
    "type": "requirement",
    "id": "REQ-031",
    "title": "Search Result Filtering",
    "status": "draft",
    "summary": "Search results must support filtering by supported criteria.",
    "tags": [],
    "relations": [],
    "resources": [],
    "path": ".engineering/req/REQ-031.md"
  },
  "diagnostics": []
}
```

All keys are required. `kind` is `init` or `artifact-create`. `action` is
`create` in Core v1. `artifact` is the expected or created PROJECT/Artifact
summary, or `null` when unavailable. Changes are sorted by canonical path.

`complete` reports whether the operation reached a complete deterministic
conclusion. When a mutation envelope can be produced, exits `0` and `1` use
`complete: true`; exits `2` and `3` use `complete: false`. `applied` reports the
physical fact of whether publication occurred, independently of the later exit
status. A successful dry run has `complete: true`, `applied: false`, and exit
`0`. A complete domain rejection or race has `complete: true`, `applied: false`,
and exit `1`. Missing or declined authorization has `complete: false`,
`applied: false`, and exit `2`. If publication succeeds but a later cleanup or
internal operation fails, the envelope, when constructible, uses
`complete: false`, `applied: true`, and exit `3`; the implementation MUST NOT
misreport the published state as unapplied.

## Filesystem Write Safety

Core v1 mutation scope is intentionally limited to two portable publication
protocols:

- `init` atomically claims ownership of a previously absent `.engineering`
  path, then completes initialization under an explicit ownership marker; and
- `artifact create` publishes one complete draft file through an atomic
  same-filesystem hard-link create-if-absent operation.

### Initialization claim-and-complete protocol

`ef init` MUST use this protocol:

1. compute and validate the complete initialization plan in memory;
2. atomically claim `.engineering` with one non-recursive directory creation;
3. create `.engineering/.tmp` beneath the claimed directory;
4. create `.engineering/.tmp/init-state.json` with create-exclusive semantics;
5. write every remaining planned control file, Artifact, and directory beneath
   the claimed path;
6. verify that every planned path and byte sequence was materialized and that
   the initialization marker still contains the invocation's nonce;
7. remove the initialization marker only after successful completion; and
8. on failure, remove only paths whose ownership by that invocation is proven.

The marker contains exactly:

```json
{
  "schema": "ef/init-state@1",
  "nonce": "0123456789abcdef0123456789abcdef"
}
```

`nonce` is a freshly generated 128-bit lowercase hexadecimal value. It is
runtime state, is never authoritative, and is removed before initialization is
reported as applied. During the live invocation, the successful return from the
exclusive directory creation proves ownership until the marker is created.
After marker creation, cleanup MUST additionally compare its nonce. A restarted
process has neither proof and MUST leave the claimed directory untouched.

The semantic bootstrap candidate is validated before the claim in step 1.
Step 6 verifies only faithful filesystem materialization of that already-valid
plan. It MUST NOT invoke working-tree project discovery or project validation
while the marker exists: under the project-discovery contract, the marker
intentionally identifies an incomplete initialization until it is removed.

A crash before marker creation can leave an `.engineering` directory without
`ef.yaml`; a later crash can leave the marker visible. Project discovery treats
either state as an incomplete initialization without searching past it.
Validation and mutation commands report `EF-VAL-012`; query commands preserve
their namespace and report the completeness failure as `EF-QRY-013`. Commands
MUST NOT silently repair, merge with, or delete that state. Recovery is an
explicit operator action. This is the portable trade-off for avoiding
platform-specific native directory publication primitives.

A pre-existing `.engineering` path, including one with an initialization
marker, is never overwritten. A failed atomic claim is a complete domain
rejection and exits `1` without modifying that path.

### Draft Artifact hard-link publication

`ef artifact create` MUST:

1. acquire an implementation-local advisory writer lock, if used;
2. compute the complete plan and provisional identity;
3. write, flush, and validate the complete file at a temporary path on the
   same filesystem as the canonical target, and MAY retain the creating
   handle as an ownership lease until publication or cleanup completes,
   closing it afterwards;
4. verify again that allocation and the canonical target remain valid;
5. create the canonical target as a hard link to the complete temporary file;
6. treat target-exists as a race rejection without replacement;
7. unlink the temporary name after successful publication; and
8. release the advisory lock and clean disposable state when safe.

The hard-link operation combines target absence with publication of already
complete bytes. A normal replacing rename, exclusive open followed by visible
incremental writes, or `copyFile` operation is not conforming. If the worktree
filesystem cannot provide the required same-filesystem hard-link semantics, the
mutation is incomplete and exits `2`; Core does not silently degrade to a
partially visible write protocol.

Locks remain implementation-local advisory coordination. Correctness MUST NOT
depend on every conforming implementation sharing a lock representation or
stale-lock protocol.

A successful dry run applies neither publication protocol. `applied: true` for
`init` requires removal of the matching initialization marker; `applied: true`
for Artifact creation requires the canonical hard link to have succeeded. If a
race invalidates a plan, the command exits `1` without overwriting existing
content.

## Engineering Transaction Boundary

CLI filesystem publication is distinct from an EF engineering transaction.

Changes to active Artifacts, Resources, relations, lifecycle, supersession, and
completed CHG records can require multiple files. EF Core v1 does not claim to
make arbitrary multi-file working-tree edits physically atomic.

Their authoritative atomicity is evaluated as one complete Git tree transition:

```text
trusted valid baseline
  -> explicit proposed commit and its complete tree
  -> transition validation
  -> atomic conditional publication of that same commit
```

Intermediate feature-branch or working-tree states may be incomplete. No
incomplete state may enter authoritative integration history. One validation
from a baseline to a final tree does not validate intermediate commits in a
multi-commit fast-forward; range scope is the Core primitive that validates
them, evaluating every authoritative boundary in the candidate's first-parent
sequence.

A validated range is published by exactly one atomic conditional ref update
whose expected old value is the validated `baseline_oid`, or ref absence when no
baseline OID was supplied, and whose new value is the validated `proposed_oid`:

```text
trusted range baseline (or proven ref absence)
  -> explicit proposed commit and the first-parent commits after the baseline
  -> range validation of every boundary in that sequence
  -> one atomic conditional publication from the baseline to that commit
```

Per-commit ref updates are neither required nor permitted, and no conforming
consumer is ever required to mutate a ref to emulate the operation-start ref
state of an intermediate commit.

The proposed commit is created or made available without updating the
authoritative `integration_ref`; creating it on a feature/candidate ref is not
publication. The authoritative ref moves only through the validated
compare-and-swap boundary.

The validation command does not publish or authorize publication by itself.
A conforming integration operation uses the validated result, verifies the
proposed commit's OID, first parent, and tree, and performs the [Filesystem and Configuration](11-filesystem-and-config.md) atomic
compare-and-swap branch update. Core v1 defines those publication obligations
without adding an `ef integrate` command.

## Exit Codes

All commands use four stable process exit codes:

| Exit | Meaning |
|---:|---|
| `0` | The requested operation completed successfully |
| `1` | Evaluation completed but EF domain findings rejected the result |
| `2` | The requested operation could not complete |
| `3` | Internal implementation failure |

Exit `0` includes empty list/search results and lookup `found: false`.

Exit `1` includes invalid authoritative state, validation failure, strict-policy
warning failure, invalid graph, identity collision, frozen-target mutation, or
a race that invalidates a mutation plan.

Exit `2` includes invalid invocation, project discovery failure, configuration
unavailability that prevents establishing the requested command contract,
unavailable trusted baseline or proposed commit, unavailable Core validator
capability or workspace context, execution permission failure, missing non-interactive
authoring values, or missing/declined mutation authorization. A discovered and
readable but schema-invalid configuration is a domain finding and uses exit `1`.

Exit `3` is reserved for panic, violated implementation invariant, or other CLI
defect.

Priority is:

```text
3 > 2 > 1 > 0
```

Exit codes never encode result counts.

## CI Contract

Authoritative CI MUST provide the current target-branch tip as `--baseline` and
the exact candidate commit as `--proposed`, and SHOULD run:

```text
ef validate \
  --scope transition \
  --baseline <full-commit-oid> \
  --proposed <full-commit-oid> \
  --strict \
  --format json \
  --no-input
```

When the candidate may add more than one new first-parent commit, CI SHOULD
instead run:

```text
ef validate \
  --scope range \
  --baseline <full-commit-oid> \
  --proposed <full-commit-oid> \
  --strict \
  --format json \
  --no-input
```

`--baseline` is the pinned pre-integration tip of the target branch and is
omitted only when the integration process has itself proven, in the local
repository the command runs against, that the ref did not yet exist at
operation start — never merely inferred from a push or other event that can
observe the ref only after it may have already advanced.

CI validation is read-only, deterministic, network-free, and independent of
TTY state. It validates the complete proposed commit tree, does not require caches,
and MUST NOT format, repair, migrate, generate, or write authoritative content.

CI SHOULD NOT run Core mutation commands.

## Editor Integration

EF Core v1 does not define an LSP, daemon, watch protocol, or editor-specific
plugin API.

Editors use stable commands such as:

```text
ef validate --scope snapshot --format json --no-input
ef query lookup REQ-031 --projection full --format json
```

[Validation and Integrity](09-validation.md) diagnostic paths, line and column positions, fields, sections, and
related locations provide the editor mapping contract. Incremental validation,
background processes, and editor adapters are outside Core v1.

## Version and Help

`ef version --format human` prints the implementation version for people.
`ef version --format json` returns:

```json
{
  "schema": "ef/version-result@1",
  "version": "1.0.0",
  "ef_core_major": 1
}
```

All keys are required. The example implementation version is illustrative.

`ef help` and `ef help <command>` are human-facing, read-only, non-project
commands and exit `0` when the requested help topic exists. An unrecognized
`<command>` value is an invocation failure and exits `2`.

Every command and subcommand additionally accepts the aliases `-h` and
`--help`. Recognizing either alias for an already-selected command produces
the human help text for that exact command path when one is documented,
otherwise the text for its nearest documented ancestor command path, and
otherwise the same general text as bare `ef help`; it always exits `0`. This
applies even when the selected command's own required arguments or mandatory
options are missing or invalid: `-h`/`--help` is recognized before argument
count, mandatory-option, and unresolved-subcommand-selection checks for that
command.

`-h`/`--help` output is always the fixed human text described above. It is
never wrapped in the JSON envelope described under JSON Transport, even when
`--format json` is also present in the same invocation; implementations MUST
NOT change `-h`/`--help`'s output based on `--format`, color, or any other
supplied option.

`-h`/`--help` does not take priority over an earlier option in the same
invocation whose own value already failed syntactic validation, such as an
invalid `--format` or `--scope` choice: options remain recognized left to
right, so a value error encountered while parsing an option positioned before
`-h`/`--help` is still reported through the ordinary pre-envelope
invocation-failure path instead of producing help text.

## Deferred

- General edit, transition, supersession, CHG-completion, Resource-capture, and
  migration commands are not part of EF Core v1.
- LSP, watch mode, background daemon, shell completion, and editor plugins are
  implementation or future interface concerns.
- A convenience context-bundle command may be added only with explicit
  selection and stable bundle semantics; Core v1 uses staged queries.
- Network retrieval, repository cloning, Git hosting APIs, merge orchestration,
  deployment operations, and cross-repository transaction coordination are
  outside EF Core.
