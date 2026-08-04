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

When omitted, Phase 11 upward discovery applies except for `ef init`, whose
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
```

It additionally accepts:

```text
--integration-ref <full-local-branch-ref>
--terminology <markdown-table>
```

When `--integration-ref` is omitted, its emitted value is `refs/heads/main`.
The resulting config still serializes every required field, including
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
ef validate [--scope snapshot|transition|bootstrap]
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

`--baseline` is valid only for transition scope and accepts only a full commit
OID for the project repository's object format. It is required for transition
scope and invalid for snapshot or bootstrap scope. The validator materializes
that commit, reads its fixed
`integration_ref`, verifies that the ref resolved to the same OID when the
operation began, and rejects a differing proposed `integration_ref`. An
arbitrary historical revision is not a trusted baseline. Omitting the option in
transition scope exits `2` without falling back to snapshot validation.

`--proposed` is required for transition and bootstrap scope and invalid for
snapshot scope. It accepts only a full commit OID for the project repository's
object format. The validator materializes exactly that commit; it does not use
the working tree, index, or `HEAD` as an implicit substitute. In transition
scope its first parent MUST equal `--baseline`. In bootstrap scope its
parentage and integration-ref history MUST satisfy Phase 11. A missing,
unresolvable, or inapplicable proposed commit makes validation incomplete and
exits `2`.

`--workspace` adds Phase 11 workspace checks to the requested core validation
scope. It does not redefine snapshot, transition, bootstrap, or strict mode.

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

All keys are required. `scope` is `snapshot`, `transition`, or `bootstrap`.
`baseline_oid` contains the supplied full OID when it passed lexical validation;
it is null when no usable OID was supplied and for snapshot or bootstrap. A
complete transition requires a non-null value. Diagnostic objects follow Phase
9. `proposed_oid` contains the supplied full proposed OID when it passed lexical
validation; it is null for snapshot or when no usable OID was supplied.
Complete transition and bootstrap results require it to be non-null.
`integration_ref` contains the applicable authoritative full local branch ref,
or null when no valid applicable configuration could be loaded.
`expected_ref_oid` contains the operation-start OID captured from that ref for
transition or bootstrap, and is null for an unresolved bootstrap ref or for
snapshot scope. A complete transition requires
`expected_ref_oid == baseline_oid`. On an incomplete result, null may instead
mean that ref state could not be established; `complete` disambiguates it.
`exit_code` exactly matches process exit status. Strict mode implies
warnings-as-errors but both booleans remain explicit.

## Query Commands

Query commands map one-to-one to the Phase 10 query kinds:

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

Options corresponding to multi-value Phase 10 filters may be repeated. Repeated
values retain Phase 10 OR or AND semantics. `--offset` defaults to `0`;
omitting `--limit` represents JSON `null` and returns all matches.

### Search

```text
ef query search <term>... [--case-sensitive] [--offset <n>] [--limit <n>]
```

At least one term is required. Multiple terms use Phase 10 Artifact-scope AND
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

At least one root is required. Every option retains its Phase 10 meaning.

### History

```text
ef query history <artifact-id>
```

History is exact and requires complete configured authoritative first-parent
integration history. Unavailable or shallow required history returns the Phase
10 incomplete query result with `EF-QRY-010` and exits `2`; there is no CHG-only
fallback.

### Current resolution

```text
ef query resolve-current <artifact-id>
```

This is the only query command that resolves supersession. Other commands do
not enable it implicitly except the explicit impact `--resolve-current` option.

Lookup is the sole query with a successful not-found result. For relations,
trace, impact, history, and resolve-current, every explicitly supplied Artifact
ID must exist. If any required ID is absent, the command returns the Phase 10
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

Core v1 mutation scope is intentionally limited to operations that can be
published safely:

- `init` publishes one entirely new `.engineering` directory; and
- `artifact create` publishes one entirely new draft file.

A mutator MUST perform the following publication sequence; the lock steps are
optional advisory coordination:

1. acquire an implementation-local EF writer lock, if used;
2. compute the complete plan;
3. write and validate content at a temporary path;
4. verify again that every target is absent and identity allocation remains
   valid;
5. publish with an atomic same-filesystem create-if-absent operation;
6. release any acquired lock; and
7. remove disposable temporary state after failure when safe.

Because `.engineering` does not yet exist during initialization, an
implementation that uses a lock uses the sibling path
`<project-root>/.engineering.init.lock`. Existing-project implementations may
use `.engineering/.lock`. These locks are non-authoritative advisory
coordination only; their representation and stale-lock recovery are
implementation concerns, and correctness MUST NOT depend on every conforming
implementation sharing a lock protocol.

`init` builds a complete sibling temporary directory and atomically publishes
it only if `.engineering` remains absent. Artifact creation atomically
publishes one complete temporary file only if its canonical target remains
absent. A normal rename operation that can replace an existing file or
directory is not sufficient. The chosen platform primitive MUST combine the
absence check and publication so no competing creation can be overwritten.

If a race invalidates the plan, the command exits `1` without publishing.

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
multi-commit fast-forward.

The proposed commit is created or made available without updating the
authoritative `integration_ref`; creating it on a feature/candidate ref is not
publication. The authoritative ref moves only through the validated
compare-and-swap boundary.

The validation command does not publish or authorize publication by itself.
A conforming integration operation uses the validated result, verifies the
proposed commit's OID, first parent, and tree, and performs the Phase 11 atomic
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

Phase 9 diagnostic paths, line and column positions, fields, sections, and
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
commands and exit `0` when the requested help topic exists.

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
