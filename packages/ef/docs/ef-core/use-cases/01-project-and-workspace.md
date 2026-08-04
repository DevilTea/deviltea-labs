# 01. Project Establishment and Workspace

## UC-001 — Initialize an EF project

**User Story:** As a project maintainer, I want to initialize EF once in a Git
worktree so that the project has a canonical, version-controlled engineering
knowledge root.

**Preconditions:** The selected project root is exactly a Git worktree root,
does not already contain `.engineering/`, and the proposed integration ref has
no existing EF state in its first-parent history.

**Main flow:**

1. The maintainer runs `ef init`. In non-interactive mode they supply
   `--title`, `--summary`, `--vision`, `--project-scope`, `--non-goals`, and
   `--context`; `--integration-ref` is optional and defaults to
   `refs/heads/main`.
2. EF plans a single new `.engineering/` directory, including canonical
   `ef.yaml`, `.gitignore`, `PROJECT.md`, Artifact directories, Resources
   root, and an active PROJECT with all nine envelope fields.
3. EF creates the required PROJECT body sections and the canonical empty
   Terminology table, unless valid user-provided terminology is supplied.
4. EF validates temporary content, confirms `.engineering/` is still absent,
   and atomically publishes the new directory.
5. The maintainer commits the candidate, validates it through UC-041, and
   conditionally publishes that exact commit through UC-043.

**Success assertions:** Exactly the canonical layout exists; config contains
all required fields; `.engineering/.gitignore` has the four exact Core entries;
PROJECT is active, complete, and has no `Lifecycle` section; no terms are
invented.

**Guardrails:** Existing `.engineering/` is never overwritten; `PROJECT` is
not created by `artifact create`; initialization does not create CHGs or
terminal Artifacts; an unapproved non-interactive write does not occur.

## UC-002 — Discover the applicable project from a working directory

**User Story:** As an engineer working anywhere in a project or declared
linked worktree, I want EF to locate the correct project root so commands use
the intended authoritative state.

**Main flow:**

1. EF uses an explicit project root when supplied; otherwise it searches the
   working directory and parents for the nearest `.engineering/ef.yaml`.
2. The search may cross an intervening Git-worktree boundary.
3. EF validates that the discovered directory is the containing Git worktree
   root and that the current directory is either in that repository or in an
   exactly declared linked-repository slot.
4. From a nested linked-repository EF project, the nearer configuration wins.

**Success assertions:** Discovery is deterministic; a command in a declared
`repos/frontend/src` can associate with its parent EF project; an explicit
commit-bound command can use `--project` even when the checked-out tree lacks
candidate EF files.

**Guardrails:** An undeclared nested Git worktree is rejected; a config outside
the containing worktree root is invalid; discovery never treats a linked
repository as sharing the project repository's Git history.

## UC-003 — Configure a single repository or composite workspace

**User Story:** As a maintainer, I want to declare optional implementation and
management worktrees so EF can provide workspace context without claiming
cross-repository atomicity.

**Main flow:**

1. For a single repository, the maintainer serializes `linked_repositories: []`.
2. For a composite workspace, they add sorted descriptors with unique lowercase
   IDs, normalized non-overlapping project-relative paths, a valid role, and a
   boolean `required` flag.
3. EF treats the project worktree as the sole authoritative transaction
   boundary; linked slots remain provenance/context only.

**Success assertions:** `integration_ref` is a fixed full local branch ref;
linked descriptor order and field order are canonical; config changes after
bootstrap are attributed to `PROJECT` by a completed CHG with a `modifies`
effect.

**Guardrails:** No remote identity, branch, release, or deployment claim is
inferred for a linked worktree. Absolute, escaping, symlinked, overlapping, or
non-canonical slot paths are invalid.

## UC-004 — Validate a workspace separately from core knowledge

**User Story:** As CI or a workspace contributor, I want to check linked
worktree availability when needed without making their absence corrupt the
project knowledge graph.

**Main flow:**

1. The caller requests validation with `--workspace`.
2. Core validation validates project-repository EF state.
3. Workspace validation additionally confirms required slots exist, present
   slots are independent Git worktrees at the configured exact paths, and
   applicable path components are not symlinks.

**Success assertions:** A complete core snapshot can be valid while workspace
validation rejects a missing required linked repository; a missing optional
slot is accepted.

**Guardrails:** Workspace checks do not fetch, clone, inspect remotes, or turn
independent repositories into one transaction.
