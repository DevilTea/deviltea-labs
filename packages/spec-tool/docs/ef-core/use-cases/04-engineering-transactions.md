# 04. Engineering Transactions

## UC-030 — Activate or modify canonical knowledge through a completed CHG

**User Story:** As a change author, I want to make one coherent update to
active engineering truth with explicit provenance so the resulting state is
reviewable and auditable.

**Preconditions:** A trusted authoritative baseline exists; a draft CHG and a
complete proposed commit tree can be prepared without moving
`integration_ref`.

**Main flow:**

1. The author prepares a draft CHG and updates every affected Artifact,
   relation, Resource, and PROJECT-owned control file in one proposed tree.
2. They make active body schemas meaningful and author exact factual effects:
   `introduces` for previously absent knowledge Artifacts, `modifies` for
   existing changed aggregates (including activation and supersession), and
   `retires` for net retirement.
3. They complete the CHG body in order: Rationale, Sources, Changes,
   Verification. Sources and Changes have list items; Verification begins
   `Result: passed` plus performed checks, or `Result: not-applicable` plus a
   rationale.
4. They set the CHG to `completed`, validate the transition, and send the
   candidate to the publication flow in UC-043.

**Success assertions:** Every CHG-required changed target has exactly one
matching effect across all CHGs completing in the transition; unchanged
targets are not listed as context; a completed CHG has at least one effect and
becomes frozen with its Resources.

**Guardrails:** Active byte changes, including a typo, grammar, format, or
canonical reordering, are never exempt. CHG effects are facts, not plans; Core
does not assert that an attested human rationale or test is semantically
adequate.

## UC-031 — Change an active Resource or PROJECT control file

**User Story:** As a maintainer, I want changes to supporting files to have the same accountable boundary as their owning knowledge.

**Main flow:**

1. The author adds, modifies, moves, or removes a Resource descriptor and, for
   a local Resource, its corresponding bytes as one valid resulting aggregate;
   alternatively, they edit `.engineering/ef.yaml` or
   `.engineering/.gitignore`.
2. The completed CHG declares `modifies <owner-ID>`; config/ignore changes use `modifies PROJECT`.
3. The CHG Changes list describes the file-level Resource/control change.
4. Transition validation verifies the aggregate diff, ownership, and absence of frozen-owner mutations.

**Success assertions:** A Resource-only change to an active REQ produces `modifies REQ`; control files are PROJECT aggregate state and enter the same transaction as their CHG.

**Guardrails:** Resources do not gain independent effect IDs; frozen owner Resources never change; config cannot change the fixed `integration_ref` in v1.

## UC-032 — Batch disjoint changes in one integration boundary

**User Story:** As an integrator, I want to complete multiple independent CHGs in one proposed commit when their ownership is unambiguous.

**Main flow:** Prepare each completed CHG with its own exact effect target set,
ensure no CHG claims the same changed target, validate the complete before/after
tree once, then publish that one next first-parent commit.

**Success assertions:** Multiple CHGs can complete together when effect sets
are disjoint; draft-only changes may coexist outside effect coverage.

**Guardrails:** Two completed CHGs cannot claim the same target; a single CHG
cannot emit two effect kinds for one target; partially covered required changes
are invalid.

## UC-033 — Retire an uncompleted change record

**User Story:** As a change author, I want to close abandoned work honestly so its research remains visible without falsely reporting authoritative effects.

**Main flow:** Change the draft CHG to `retired`; write the final four body
sections; explain why work stopped; supply a source; state that no authoritative
effects occurred; start Verification with `Result: not-completed`; retain any
useful CHG-owned evidence.

**Success assertions:** The retired CHG is frozen, has no effect relations, and
remains readable as unfinished-change history.

**Guardrails:** Failed, cancelled, rejected, or abandoned work is not a separate
status; a CHG cannot be changed to retired to erase effects that already entered
authoritative history.

## UC-034 — Correct an invalid unintegrated proposed tree

**User Story:** As a feature-branch author, I want to repair or discard partial draft work before integration so no invalid intermediate state becomes authoritative.

**Main flow:** The author may edit or retire drafts, repair provisional IDs,
remove unintegrated temporary material, or revise the draft CHG. They create a
complete candidate only after all required aggregate changes and effects agree.

**Success assertions:** Branch authoring can use multiple commits; each
authoritative first-parent step is a separately validated and conditionally
published adjacent transition.

**Guardrails:** A baseline-to-final validation does not validate intermediate
commits in a multi-commit fast-forward; authoritative partial effects require
completion or an explicit corrective transaction, never historical erasure.
