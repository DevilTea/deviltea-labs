# EF Manifest-Driven Batch Artifact Creation: Design Evaluation

Status: Accepted

## Purpose

This document evaluates the P2 backlog item "evaluate manifest-driven batch
Artifact creation" raised by the first real-world adoption of `@deviltea/ef`
(brownfield adoption of `maple-pod/maple-pod.github.io`, 2026-08-10). It is
planning input, not an authorization to implement. Per the adoption issue's
"Suggested implementation / PR order," this item is explicitly deferred until
semantics and additional adoption evidence justify it.

The accepted EF Core specifications remain normative. Every proposal below is
a compatibility sketch against the existing `ef artifact create` plan/apply
protocol and the existing Mutation Planning and Authorization contract
(`13-cli-contract.md`), not a new committed contract.

## Adoption evidence

The only current datapoint is the first brownfield adoption. It required 18
Artifacts (5 PRD, 10 REQ, 6 ADR — the issue's totals also include 1 PROJECT
and 1 POL bootstrapped alongside), each authored through the same repeated
sequence:

```text
ef artifact create <type> --dry-run
→ inspect/confirm
→ ef artifact create <type> --yes
```

This is mechanically verbose but each step is cheap; the friction reported was
orchestration overhead (repeating the same two-command cycle 18 times), not a
correctness problem with `artifact create` itself.

This is the **only** adoption datapoint available. The originating issue's
acceptance criteria require gathering "at least the current brownfield use
case and any additional adoption evidence" before implementation, and this
document does not manufacture that additional evidence. A second and third
adoption may reveal that 18-Artifact bootstraps are unusual, that the
skeleton-only manifest shape proposed below is insufficient, or that the
existing per-Artifact loop is acceptable once Skill orchestration removes the
human-attention cost (see "What would justify revisiting this decision"
below). None of that is known yet.

## How `ef artifact create` works today (grounding facts)

Read from `packages/ef/src/application/artifact-create.ts`,
`packages/ef/src/cli/commands/artifact-create.ts`,
`packages/ef/src/cli/mutation-authorization.ts`, and `02-identity.md`
"Allocation":

- **Plan/apply split.** `computeCreatePlan` is pure and operates over an
  already-loaded `ProjectSnapshot`. `applyCreatePlan` is the only step that
  touches the filesystem, and it re-verifies allocation, the managed
  directory chain, and a full `ContentGenerationWitness` (config bytes,
  `PROJECT.md` bytes, and the complete visible Artifact ID set) immediately
  before publication — not merely at plan time.
- **One Artifact per invocation.** Each `ef artifact create <type>` call
  allocates exactly one ID and publishes exactly one file via
  create-if-absent hard link. There is no existing multi-file mutation plan
  or multi-file apply step anywhere in Core v1.
- **Allocation is a whole-graph, per-prefix scan, not a reservation table.**
  `02-identity.md` Allocation: the default allocator inspects "every
  authoritative and current provisional Artifact visible in the working
  graph for the requested prefix," selects the next integer, and "verifies
  that the candidate ID and filename are unused" as part of the same atomic
  creation. Allocation state is explicitly **not** an authoritative registry
  ("Allocation state, counters, caches, and indexes are derived data. They
  MUST NOT become an authoritative identity registry separate from Artifact
  files.") — there is nowhere in Core's model to persist a claimed-but-not-
  yet-written ID between two separate `artifact create` invocations.
- **Authorization is a fixed four-path classification.**
  `classifyMutationAuthorization` (`cli/mutation-authorization.ts`) maps
  `{dryRun, yes, noInput}` to exactly `dry-run | direct | needs-confirmation |
  missing-authorization`, with `--dry-run` never requiring `--yes` and JSON
  mode always implying `--no-input`. This classification is per-invocation;
  there is no existing concept of a plan that spans more than one
  confirmation decision.
- **Manifest content today is a fixed skeleton.** `computeCreatePlan` accepts
  only `type`, `title`, `summary`, plus the caller's already-observed
  `engineeringIdentity`. It always emits empty `tags: []`, `relations: []`,
  `resources: []`, and the type's required H2 headings with empty content
  (13-cli-contract.md's Mutation JSON example shows the same fixed shape).
  There is no existing CLI path for `artifact create` to set relations, tags,
  Resources, or body content at creation time — those are necessarily later
  mutations. A manifest cannot "skip a step" that does not exist yet.

## Proposed design (answers to the issue's design questions)

Each answer below is a proposed direction to record now, for a future
implementation proposal to adopt, refine, or reject — not shipped behavior.

### 1. Are all provisional IDs planned/reserved as one mutation plan?

**Proposed: no persistent reservation; IDs are computed once per batch-plan
pass, in file order, threading each entry's own contribution forward through
the same pass.** Concretely, a batch plan would compute entry 1's ID against
the loaded snapshot, then compute entry 2's ID against that snapshot's visible
ID set *plus* the type/ID pairs already planned for entries 1..N-1 in the same
pass — mirroring, in-memory, what allocation would see if the entries had
been created one at a time in manifest order. This requires no new persistent
reservation concept and no change to `02-identity.md` Allocation, which
already forbids treating counters as an authoritative registry independent of
Artifact files. Nothing is written or claimed on disk until apply.

### 2. What happens if project state changes between dry-run and apply?

**Proposed: apply always recomputes the plan against a fresh snapshot and
compares against the dry-run's own witness, failing the affected entries
closed rather than silently reallocating.** This generalizes
`applyCreatePlan`'s existing single-Artifact behavior — it already reloads
the snapshot and re-derives allocation immediately before publication, using
`ContentGenerationWitness` to detect a project state change since plan time,
rather than trusting the dry-run's IDs blindly. A batch apply cannot skip
this: if the visible ID set changed (a concurrent `artifact create`, a
concurrent batch, or a manual file edit) since dry-run, at least one entry's
provisional ID may now collide or may no longer be the true next value. The
batch must re-verify, not merely re-use, the dry-run's IDs at apply time.

### 3. Is the batch all-or-nothing?

**Proposed: yes, at plan-validation time; no, at publication time — the same
split Core already uses for a single Artifact's own eight-step protocol.**
Concretely:

- If the *plan* cannot be computed in full (any entry fails type/value
  validation, self-validation, or a managed-directory-symlink check), the
  whole batch fails and nothing is published — this mirrors
  `computeCreatePlan`'s existing all-or-nothing pure failure modes, just
  applied per-entry with a first-failure-wins (or fail-and-report-all,
  design open) short-circuit before any apply step runs.
- During *apply*, each entry still publishes through its own independent
  hard-link create-if-absent step, because Core has no cross-file atomic
  publish primitive (there is exactly one atomic operation per Artifact:
  the hard link). A batch cannot manufacture atomicity across N independent
  filesystem operations that Core's own single-Artifact protocol does not
  provide either. The proposed contract is therefore: plan computation is
  all-or-nothing; publication is sequential and best-effort per entry, and
  the batch mutation result must report a per-entry outcome list (mirroring
  the existing `applied`/`outcome` variants) rather than a single boolean —
  never collapsing a partial batch into a false "fully applied" or "fully
  failed" report. This is consistent with the existing single-Artifact
  contract, which already distinguishes `applied` from `complete` and
  refuses to misreport a verified-but-imperfectly-cleaned-up publication as
  a plain failure.

### 4. How are allocation races/collisions handled?

**Proposed: identical to the existing single-Artifact race handling, applied
per entry.** `applyCreatePlan` already treats a target-exists race as
`outcome: 'raced'` (exit class 1, `EF-ID-004`) rather than a hard failure of
the whole invocation. A batch apply that hits a collision on entry K (because
some other process created that exact ID/path between the batch's plan and
apply, or between two entries' own sequential apply steps within the same
batch) should record that one entry as raced and continue with the remaining
entries using their own next allocation — not abort the batch, and not
silently renumber previously-succeeded or previously-failed entries. Because
allocation is a whole-graph scan (not a reservation), a raced entry does not
by itself invalidate sibling entries' own already-published IDs.

### 5. May relations refer to IDs allocated within the same manifest?

**Proposed: no, in the initial design.** `artifact create` does not support
setting relations at creation time at all today — every Artifact is created
with `relations: []`, and relations are added by a later, separate mutation.
A manifest that tried to pre-populate relations pointing at sibling
manifest-provisional IDs would therefore need to invent a new
relation-setting-at-creation capability that has no precedent in the shipped
CLI, and would need forward-reference resolution semantics (what if the
referenced sibling entry itself fails or races?) that Core does not currently
define anywhere. Keeping the manifest to the same skeleton `artifact create`
already supports (see question 7) avoids inventing that new semantics
surface purely to serve batch orchestration. If cross-entry relations are
wanted later, the natural place to add them is a *separate*, already-existing
kind of mutation (a relation-setting command applied after all entries in the
batch have published, once every ID is real) — not new inference inside the
batch creation step itself.

### 6. Is confirmation one batch-level confirmation or per Artifact?

**Proposed: one batch-level confirmation, listing every planned change.** The
existing single-Artifact interactive path already displays a
`MutationPlanPreview` (title + one line per change) before confirming. A
batch plan naturally extends this to one preview listing all N `create <path>`
lines, confirmed once — this is the entire point of the batch primitive (it
exists to replace N separate confirmation cycles with one). `--yes` and
`--no-input`/`--format json` classification would apply to the whole batch,
unchanged from `classifyMutationAuthorization`'s existing four-path model;
no new per-entry authorization concept is needed. `--dry-run` still requires
no `--yes` and returns the full batch plan unmutated, exactly as today.

### 7. May the manifest carry semantic body/frontmatter content, or only the title/summary skeleton?

**Proposed: only the same title/summary skeleton inputs `artifact create`
supports today — one `{type, title, summary}` entry per planned Artifact,
nothing else.** This is the load-bearing design constraint, not a detail:

- Core's architecture boundary (see below) keeps semantic repository
  analysis and inferred engineering intent in the Agent/Skill layer.
  Allowing a manifest to carry body content, relations, tags, or Resources
  would let an upstream process pre-decide semantic engineering content and
  hand it to the CLI as an opaque batch payload, bypassing exactly the
  per-Artifact "show the intended mutation before applying it" and "require
  human decisions for accepted terminology and engineering decisions"
  discipline `00-implementation-decisions.md` already requires of the
  `author-engineering-files` Skill.
- It also avoids inventing new schema validation surface. `artifact create`
  today can rely on `REQUIRED_HEADINGS` and `validateDraftArtifactBytes` to
  self-validate a very narrow, fixed shape. A manifest that accepted
  arbitrary frontmatter/body content per entry would need the full body
  schema surface (`08-artifact-schemas.md`) exposed through manifest
  parsing, effectively duplicating what a human/Skill-driven edit-then-
  `ef validate --scope snapshot` cycle already does today, with none of that
  cycle's incremental feedback.

A manifest is therefore proposed to remain exactly as narrow as N repeated
`artifact create` calls' own input surface — a batch *dispatch* mechanism,
not a new content-authoring mechanism.

## Architecture boundary this proposal preserves

```text
Agent / Skills
  repository understanding, candidate engineering intent,
  human confirmation, workflow sequencing
  -> decides WHAT title/summary/type entries belong in a manifest

EF Core / CLI
  deterministic initialization, canonical files, ID allocation,
  validation, Git-boundary proof, graph/query semantics
  -> decides HOW EACH entry becomes an ID, a path, and published bytes
```

Consistent with this, a manifest MUST NOT be permitted to carry:

- body/frontmatter content beyond `title` and `summary`;
- `tags`, `relations`, or `resources` (these remain later mutations against
  real, already-published IDs, exactly as they are today for a
  single-Artifact `artifact create`);
- explicit ID assignment (`02-identity.md`: "Explicit ID assignment, legacy
  import, and identity migration are not EF Core v1 operations. ... General
  interactive creation MUST use the default allocator."); or
- any conditional/derived logic (e.g., "create a REQ only if some other
  Artifact does not already exist") — that is repository interpretation, and
  belongs in the Skill that authors the manifest, not in the CLI that
  executes it.

## Status

**DEFERRED.** Consistent with the adoption issue's suggested PR order item 7
("Manifest batch creation — defer until semantics and additional adoption
evidence justify it"), no implementation work should begin from this
document alone.

### What would justify revisiting this decision

- A second and third independent brownfield or greenfield adoption reporting
  the same 10+-Artifact bootstrap friction, ideally with at least one
  adoption where the human confirmation step (not merely the CLI round
  trips) was the actual bottleneck reported, since Skill-level orchestration
  of the existing per-Artifact loop may already resolve pure command-
  repetition friction without any new CLI surface.
- Evidence that the title/summary-only skeleton proposed above is (or is
  not) sufficient for real bootstraps — i.e., that adopters are not actually
  blocked wanting to pre-populate relations/tags/body content in the same
  batch, which this design deliberately excludes.
- A concrete answer, informed by that additional evidence, to whether batch
  orchestration should instead live entirely in the Skill layer (looping
  `artifact create --dry-run` / `--yes` N times, with one Skill-level
  human-facing summary instead of N separate confirmations) rather than as
  new CLI surface at all — the issue's own "may reduce orchestration
  overhead" framing does not by itself establish that the reduction must
  happen inside Core rather than inside the Skill that already sequences
  these calls today.

### What a follow-up issue would need to contain

- The additional adoption evidence above, cited concretely (adopter,
  Artifact count, what specifically was reported as friction).
- A decision, not merely a question, on all-or-nothing semantics for
  publication (this document proposes plan-time all-or-nothing,
  apply-time per-entry, per "Is the batch all-or-nothing?" above) with
  worked failure-mode examples (partial batch race, partial batch
  self-validation failure, batch interrupted mid-apply).
- The exact manifest file schema (format, required/optional fields, ordering
  requirements) and its own diagnostic namespace/codes if malformed — new
  diagnostics require the same registry-first process
  `diagnostic-registry.md` "Maintenance rules" already mandates for any new
  EF-* code.
- The exact batch mutation JSON envelope shape (a new `kind`, or a
  `changes`/`artifacts` array extension of the existing
  `ef/mutation-result@1` schema) and its exit-code mapping, reusing
  `13-cli-contract.md`'s existing four exit codes rather than inventing new
  ones.
- Confirmation that the manifest's input surface remains bounded to
  `{type, title, summary}` per entry, or an explicit, separately justified
  proposal to widen it — not a silent widening introduced only to make the
  batch primitive more convenient.
