# EF Core: Filesystem and Configuration

Status: Accepted

## Scope

This document defines the EF project repository, canonical filesystem layout,
single-repository and composite-workspace forms, project discovery,
configuration, linked-repository workspace slots, validation boundaries, Git
transaction boundaries, text normalization, symlink policy, generated state,
and schema migration.

## Definitions

### Project repository

The project repository is the Git worktree whose root directly contains the
`.engineering` directory. It owns the authoritative EF state.

The project repository MAY also contain implementation code, tests, deployment
configuration, or any other project content. It is not required to be a
specification-only repository.

### Project root

The project root is both:

- the root of the project repository Git worktree; and
- the direct parent of `.engineering`.

### Linked repository

A linked repository is an independent Git worktree declared as a named
workspace slot with a local path in `.engineering/ef.yaml`. It is workspace
context and does not share Git history or transaction atomicity with the
project repository. Core validates the slot and local worktree association; it
does not attest remote repository identity.

### Single-repository project

A single-repository project has no linked repositories. Its project repository
can contain both EF state and implementation content.

### Composite workspace

A composite workspace has one project repository and one or more linked
repositories. Linked repositories are ordinary independent repositories, not
Git submodules, and are ignored by the project repository.

EF Core v1 linked-repository paths MUST be descendants of the project root.
Sibling repositories, absolute external worktrees, and paths reached through
`..` are unsupported. In v1, "composite workspace" therefore means embedded
local workspace slots beneath the project repository rather than an arbitrary
set of filesystem peers.

## Canonical Layout

The authoritative EF layout is fixed:

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

Canonical Artifact paths are:

| Artifact type | Canonical path |
|---|---|
| PROJECT | `.engineering/PROJECT.md` |
| PRD | `.engineering/prd/<ID>.md` |
| REQ | `.engineering/req/<ID>.md` |
| ADR | `.engineering/adr/<ID>.md` |
| POL | `.engineering/pol/<ID>.md` |
| CHG | `.engineering/chg/<ID>.md` |

A local Resource MUST be stored beneath:

```text
.engineering/resources/<OWNER-ID>/
```

Its descriptor `location` remains project-root-relative, for example:

```text
.engineering/resources/REQ-031/search-filter.schema.json
```

Artifact directories and managed Resource paths are not configurable in EF
Core v1.

`.engineering/.gitignore` is a tracked PROJECT-owned control file with these
exact Core v1 entries:

```gitignore
.cache/
.generated/
.tmp/
.lock
```

It prevents local runtime state from entering authoritative history. Ignore
rules for linked-repository materialization, such as `repos/`, remain ordinary
project-repository configuration outside `.engineering`.

Git does not preserve empty directories. A canonical Artifact or Resource
directory MAY therefore be absent while it contains no authoritative files.
Tools create it when needed, and validation MUST NOT require placeholder files
solely to preserve an empty directory.

## Workspace Forms

### Single repository

```text
product/
├── .engineering/
├── src/
├── tests/
└── package.json
```

The corresponding configuration uses an explicit empty collection:

```yaml
schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
```

EF files and implementation changes can participate in the same project
repository Git transaction.

### Composite workspace

```text
project-spec/
├── .engineering/
└── repos/
    ├── project-fe/
    ├── project-be/
    └── project-mgmt/
```

`project-spec` remains the project repository. Each directory below `repos` is
an independent Git worktree. The project repository ignores `repos/`; the
linked repositories are not submodules.

Example configuration:

```yaml
schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/project-be
    role: implementation
    required: true
  - id: frontend
    path: repos/project-fe
    role: implementation
    required: true
  - id: management
    path: repos/project-mgmt
    role: management
    required: true
schemas:
  artifact_write_major: 1
```

EF has no `single`, `composite`, or other workspace-mode setting. The same
model covers both forms: `linked_repositories` is empty for a single-repository
project and non-empty for a composite workspace.

## Configuration Schema

`.engineering/ef.yaml` is tracked authoritative state. The following top-level
fields MUST all be explicitly present:

```text
schema
repository
linked_repositories
schemas
```

Collections that have no entries use `[]`; required fields are not omitted and
are not silently defaulted by a parser. Unknown fields are invalid in Core v1;
the configuration schema has no extension-field mechanism.

The configuration is a YAML 1.2 top-level mapping and follows the Artifact
frontmatter restrictions on duplicate keys, aliases, anchors, merge keys, and
custom tags. Its fields and nested fields use the order shown by this
specification; non-canonical ordering is a warning.

### `schema`

`schema` identifies the configuration schema. EF Core v1 requires:

```yaml
schema: ef/config@1
```

### `repository`

`repository` describes the project repository:

```yaml
repository:
  integration_ref: refs/heads/main
```

`repository` contains exactly the required `integration_ref` field.
`integration_ref` MUST be a syntactically valid full local branch ref of the
form `refs/heads/<branch-name>`. The branch name MUST satisfy Git ref-format
rules. Tags, remote-tracking refs, abbreviated names, `HEAD`, and other
`refs/*` namespaces are invalid.

`integration_ref` identifies the authoritative local branch whose integration
history is used for provisional ID finalization, collision checks, trusted
baseline selection, transition validation, and chronological history.
The bootstrap commit is the first authoritative EF state. Its first-parent
ancestors MAY be ordinary repository history without EF state. From bootstrap
onward, the branch's first-parent EF-bearing commit sequence is the sequence of
authoritative EF states. Commits reachable only through non-first parents remain
repository authoring history but are not separate authoritative integration
states.

`integration_ref` is fixed by bootstrap and MUST NOT change within EF Core v1.
Changing the project's authoritative-history root requires an explicit future
repository migration contract rather than an ordinary configuration CHG. This
keeps baseline selection independent of the proposed commit being validated.

The project repository has no configured path because its root is defined by
the location of `.engineering` and verified against the containing Git
worktree.

### `linked_repositories`

`linked_repositories` is an array and MAY be empty as `[]`.
Each linked repository descriptor contains exactly these required core fields:

```text
id
path
role
required
```

Rules are:

- `id` MUST be unique within the project and match
  `[a-z][a-z0-9-]*`.
- `path` MUST be a normalized project-root-relative path beneath the project
  root.
- `path` MUST NOT be absolute or contain empty, `.`, `..`, backslash, colon, or
  tilde-prefixed segments.
- Two linked repository paths MUST NOT overlap.
- `role` MUST be `implementation`, `management`, or `other`.
- `required` MUST be a boolean. It affects workspace validation only.

Descriptors MUST be sorted by `id` using bytewise lexicographic order. Fields
within each descriptor use the order `id`, `path`, `role`, `required`.

Linked repositories do not have `integration_ref`. EF does not interpret their
branch, merge, release, or deployment workflows.

The `id` names a workspace slot, not a Core-verifiable remote repository
identity. Workspace validation can verify local placement and worktree shape,
but cannot prove that a different clone, remote, or hosting project has not
been placed at the same path. Strong repository identity, supplied commit
provenance, and remote binding are deferred.

### `schemas`

```yaml
schemas:
  artifact_write_major: 1
```

`schemas` contains exactly the required `artifact_write_major` field.
`artifact_write_major` selects the Artifact schema major emitted by mutating
tools. EF Core v1 requires the integer value `1`. It does not authorize
automatic migration of existing files.

## Project Discovery

Project discovery uses this order:

1. An explicitly supplied project root, if present.
2. Otherwise, search the current directory and each parent for an
   `.engineering` path.
3. Do not stop the upward search at an intervening Git worktree boundary.
4. Select the nearest `.engineering` path. Do not skip it merely because its
   `ef.yaml` is absent.
5. If the selected path is a directory without `ef.yaml`, or contains
   `.tmp/init-state.json`, report incomplete initialization with `EF-VAL-012`.
6. Otherwise, load the configuration and validate its project-repository and
   workspace association.

The discovered project root MUST be the Git worktree root that directly
contains `.engineering`. A configuration found elsewhere is invalid.

For commands whose semantic input is the working tree, the absent-config rule
makes the crash window between claiming `.engineering` and writing the
initialization marker detectable. It also reserves an `.engineering` directory
for EF: commands do not search past an incomplete nearer claim and do not
silently reinterpret it as an unrelated directory. An `.engineering` path that
is not a directory is invalid and cannot be used as an initialization claim.

For commit-bound transition or bootstrap validation, an explicit `--project`
identifies the project Git worktree root even when its checked-out tree does not
contain the candidate configuration. The validator loads authoritative
configuration from the supplied commit or commits. Current working-tree
configuration may assist implicit root discovery but is not a semantic
substitute for either materialized commit. This exception allows bootstrap
validation from a pre-EF checkout when the repository root is explicit.
Consequently, the working-tree incomplete-initialization check above does not
replace or block explicit commit-bound materialization; transition and bootstrap
validation derive initialization state from their selected commit trees.

After discovery, a command is associated with the project when its working
directory is:

- within the project repository without being inside an undeclared nested Git
  worktree; or
- within a declared linked repository at its configured path.

If the working directory is inside an undeclared nested Git worktree, implicit
association is rejected. The user can supply another explicit project root if
that repository belongs to a different EF project.

If a linked repository contains its own `.engineering/ef.yaml`, that nearer
configuration wins during implicit discovery and defines an independent EF
project.

This allows a command run inside `repos/project-fe/src` to cross the
`project-fe` Git boundary, discover `project-spec/.engineering/ef.yaml`, and
then verify that the current worktree is the declared `frontend` repository.

## Validation Boundaries

### Core validation

Core validation checks authoritative EF state in the project repository,
including configuration, layout, Artifacts, relations, Resources, CHG effects,
identity, lifecycle, and graph integrity.

Core validation does not require linked repositories to be present, including
entries marked `required: true`. Their absence does not make the EF graph
intrinsically invalid.

### Workspace validation

Workspace validation additionally checks local composite-workspace facts:

- every linked path with `required: true` exists;
- each present linked path is an independent Git worktree;
- configured paths and worktree roots match exactly; and
- each present configured path and every existing path component is not a
  symlink.

A missing required linked repository fails workspace validation, not core
graph validation. A missing optional repository is permitted.

## Git and Transaction Boundary

The EF transaction boundary is the project repository. It is not defined by
whether that repository contains only specifications or also contains code.

For a single-repository project, EF files and implementation changes can be
part of one physical Git transaction.

For a composite workspace, a CHG atomically records the project repository
transition only. It MAY cite linked repository evidence, but EF does not claim
that commits, merges, releases, or deployments across independent repositories
form one physical transaction.

Slot-scoped linked-repository provenance uses the configured workspace `id` and
an immutable full commit OID, conceptually:

```text
frontend@0123456789abcdef0123456789abcdef01234567
```

PR URLs MAY also be cited as external evidence. Branch names are not permanent
provenance. The structured representation of implementation provenance is
deferred; EF Core v1 does not add it to the Artifact envelope or assign core
semantics through an `x-*` extension.

### Trusted transition baseline

Immediately before authoritative integration, `integration_ref` identifies the
pre-integration first-parent commit. Transition validation compares that
commit's tree with the complete tree of one explicitly supplied proposed
commit.

Transition validation requires externally supplied baseline and proposed
commit OIDs. The validator MUST materialize the baseline before trusting
proposed configuration and then materialize the proposed commit. The baseline
MUST:

- be a full commit OID for the repository's object format rather than a branch,
  tag, or abbreviated revision;
- resolve in the project repository;
- contain a valid authoritative EF snapshot and configuration;
- name its own fixed `integration_ref` through that baseline configuration;
- equal the commit to which that baseline-fixed ref resolved when the
  integration operation began; and
- use the same `integration_ref` value as the proposed configuration.

A baseline that fails any condition is unavailable or untrusted, so transition
validation is incomplete. Core v1 defines no arbitrary historical-baseline or
baseline-override mode. After integration, the new commit becomes the next
first-parent authoritative state.

Proposed configuration MUST NOT select the transition baseline. Omitting the
baseline or proposed commit, failing to materialize either one, or finding that
the baseline-configured branch does not resolve exactly to the baseline OID
makes transition validation incomplete. The proposed commit MUST use the
baseline OID as its first parent and its tree is the sole proposed state being
validated.

Creating the proposed commit MUST NOT itself update `integration_ref`. It may
be created on another ref, by a hosting-system candidate ref, or as an otherwise
locally materializable commit object. Updating `integration_ref` before
successful validation bypasses the authoritative boundary and is invalid.

The integration operation MUST publish by one atomic conditional ref update
whose expected old value is the validated baseline OID and whose new value is
the validated proposed commit OID. A separate check followed by an
unconditional update is not conforming. If the comparison fails, the validation
result is stale and the proposed commit MUST be revalidated from the actual
boundary.

A validated transition becomes authoritative only by updating exactly the
baseline-fixed `integration_ref`. Validation does not authorize publishing the
result as an EF state on a different branch.

A validation result is not by itself publication authorization. The integration
operation owns the final commit-parent and tree checks and compare-and-swap
update of `integration_ref`. EF Core v1 defines this conformance
boundary but does not add a general integration or branch-update CLI command.

Bootstrap validation is the sole no-baseline exception. Its proposed
`integration_ref` may be unresolved, or may resolve only when no commit in its
first-parent history contains an `.engineering/ef.yaml` path. Any such
historical config path proves that an EF state already existed and makes
bootstrap invalid.
The explicit proposed bootstrap commit is the commit validated by bootstrap
scope. When the ref resolves, that commit MUST use the captured tip as its first
parent. For a previously unresolved ref, it MAY be a root commit or use a first
parent whose first-parent history also contains no `.engineering/ef.yaml` path.
Publication uses one atomic conditional ref update: the expected state is the
captured old OID when resolved or ref absence otherwise, and the new value is
the validated proposed commit OID. A failed comparison makes the result stale.
The validation result exposes the selected `integration_ref` and captured old
state as `expected_ref_oid`, using null for captured ref absence, so a separate
integration operation can perform the exact conditional update.

## Configuration Ownership and Mutation

The PROJECT Artifact logically owns `.engineering/ef.yaml` and
`.engineering/.gitignore`. Both files are part of the PROJECT aggregate state
for transaction diffing.

After bootstrap, any authoritative byte change to either file requires a CHG
with:

```yaml
relations:
  - type: modifies
    target: PROJECT
```

The control-file mutation, PROJECT effect, and completed CHG MUST enter the
project repository in the same transaction. These files do not receive a
separate Artifact ID, lifecycle, or relation graph node.

## Text and Path Normalization

Authoritative text files MUST use:

- UTF-8;
- LF line endings;
- no byte-order mark; and
- one final newline.

All managed paths use Unicode NFC, `/` in serialized form, and exact filesystem
case. Path comparison and bytewise ordering operate on the UTF-8 encoding of
the serialized NFC form. A filesystem entry whose name has a different Unicode
normalization is not silently treated as the canonical serialized path.

Symlinks are forbidden for:

- `.engineering` and its canonical directories;
- `.engineering/ef.yaml`, `.engineering/.gitignore`, and Artifact files;
- local Resource files and their directory path components; and
- configured linked repository paths and their existing path components.

Validators MUST reject a managed symlink even if its resolved target remains
within the project root. This avoids multiple serialized paths identifying the
same file and keeps discovery deterministic across environments.

For configured linked repository paths, these physical symlink and worktree
checks run only during workspace validation or when command discovery must
establish association with that linked repository. Core validation of the
serialized project graph checks only the descriptor's lexical path rules.

## Runtime and Derived State

Implementations MAY use these conventional non-authoritative paths:

```text
.engineering/.cache/
.engineering/.generated/
.engineering/.tmp/
.engineering/.lock
```

They MUST be ignored by Git and MUST NOT affect deterministic validation or
query results. Cache and generated contents can be discarded and rebuilt.
Lock files coordinate local processes only and do not represent project state.

Temporary raw-input normalization MAY use `.engineering/.tmp/raw/`. It has no
persistent EF schema or identity and may be rewritten or discarded at any
time. Selected source material enters authoritative state only by being copied
to an owned Resource under `.engineering/resources/<OWNER-ID>/`.

The project repository's ordinary ignore rules separately exclude locally
materialized linked repository directories such as `repos/`.

## Schema Migration

Schema migration is explicit and never occurs as a side effect of discovery,
validation, querying, or ordinary reads.

- Nonterminal Artifacts MAY be migrated by an explicit migration operation.
- `superseded`, `retired`, and `completed` Artifacts MUST remain byte-frozen at
  their historical schema major.
- Readers MUST support every schema major that the implementation declares
  readable, independently of `artifact_write_major`.
- Migration of authoritative active content is a CHG-required mutation.
- Derived caches MAY be rebuilt without CHG.

An implementation that cannot read a schema required by the current project
reports an incomplete operation; it MUST NOT silently rewrite or partially
interpret the file.

## Deferred

- Stable CLI flags for explicit roots, core validation, and workspace
  validation are defined in [CLI Contract](13-cli-contract.md).
- A structured implementation-provenance schema is deferred.
- Cross-repository merge, release, deployment, and transaction orchestration
  are outside EF Core.
- Git submodule management, repository cloning, and credential management are
  outside EF Core.
