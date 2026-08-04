# 06. Validation and Authoritative Publication

## UC-040 — Validate a current snapshot

**User Story:** As an author or editor, I want deterministic read-only feedback
on the complete current EF state so I can repair integrity findings before
integration.

**Main flow:** Run `ef validate --scope snapshot`; EF discovers the project,
parses all authoritative files, validates envelopes, bodies, identity, and
lifecycle, builds the graph, validates relations and Resources, runs available
optional hooks, and emits deterministically ordered diagnostics.

**Success assertions:** The operation is network-free and read-only. In JSON
mode, output contains complete and valid state, severity counts, and stable
locations and related locations; warnings do not fail default policy.

**Guardrails:** Snapshot never silently strengthens itself into transition
validation; invalid authoritative state is a complete domain rejection (exit
1), not automatic repair.

## UC-041 — Validate the first EF bootstrap

**User Story:** As an integrator, I want to admit the first complete EF state
without a baseline CHG so a repository can begin authoritative EF history.

**Preconditions:** `--proposed` names the exact candidate commit; the target
integration ref is absent or its captured first-parent history has no
`.engineering/ef.yaml` path.

**Main flow:** Run `ef validate --scope bootstrap --proposed <full-oid>`; EF
materializes the proposed commit, validates its complete snapshot and bootstrap
parent and ref-history conditions, and returns the fixed integration ref plus
the expected old ref OID, or `null` for ref absence, for conditional
publication.

**Success assertions:** The candidate may contain active or draft knowledge and
Resources without a CHG. After UC-043 conditionally publishes that exact
candidate, its config fixes the integration ref and it becomes the first
canonical EF state.

**Guardrails:** Bootstrap cannot include a CHG or terminal knowledge; it is
rejected if EF history already exists, and `--baseline` is invalid in this
scope.

## UC-042 — Validate one authoritative transition

**User Story:** As CI, I want to compare a trusted baseline with exactly one
proposed child commit so lifecycle, immutability, effects, and atomicity can be
proved from the complete before/after state.

**Main flow:**

1. CI supplies `--scope transition --baseline <full-oid> --proposed <full-oid>`.
2. EF materializes and validates the complete baseline snapshot before trusting
   candidate config; the baseline-fixed integration ref must resolve to the
   baseline OID.
3. EF requires the proposed commit to have that baseline as first parent and
   the same fixed integration ref.
4. It validates snapshot plus transition integrity: ID retention, legal status
   changes, frozen files, Resources, CHG effects, exact coverage, and the
   complete post-transition graph.

**Success assertions:** Missing or unavailable baseline or proposed commits
make validation incomplete (exit 2), not a snapshot fallback; both commits are
explicit full OIDs, and the working tree, index, and `HEAD` are not substitutes.

**Guardrails:** An arbitrary historical commit cannot become a trusted
baseline; candidate config cannot select the baseline.

## UC-043 — Publish only the validated candidate

**User Story:** As an integrator, I want to atomically advance the authoritative
branch only after validation so incomplete intermediate state never becomes EF
truth.

**Main flow:** Create a candidate commit without updating `integration_ref`;
perform UC-041 or UC-042; verify the result's integration ref, expected old OID,
and proposed OID, and recheck the candidate parent and tree; atomically
compare-and-swap exactly the configured ref from the expected OID (or absence)
to the proposed OID.

**Success assertions:** On success the candidate is the next authoritative
first-parent state; its CHG provenance is derived from Git history.

**Guardrails:** Validation is neither publication nor authorization; a failed
CAS makes validation stale and requires revalidation; unconditional ref updates
and publication to another branch are non-conforming.

## UC-044 — Apply strict and warnings-as-errors policy

**User Story:** As CI, I want to enforce the highest available deterministic integrity policy so an accepted candidate has no unresolved warnings or skipped required checks.

**Main flow:** Run validation with `--strict` (which implies `--warnings-as-errors`) and optional `--workspace`; inspect the stable JSON result and process exit.

**Success assertions:** Strict rejects warnings and requires all Core checks for the requested scope to be available; it remains scoped to the caller's selected validation kind.

**Guardrails:** If a required capability/context is unavailable, result is incomplete rather than quietly weakening checks; warnings-as-errors alone does not imply all strict availability requirements.

## UC-045 — Diagnose failures without misleading cascades

**User Story:** As an author, I want actionable, deterministic diagnostics so I can fix the root problem rather than chase duplicate consequences.

**Main flow:** EF assigns a primary finding location, reports related locations when useful, orders findings deterministically, and suppresses dependent cascades when prerequisite parsing/identity/graph facts are unavailable.

**Success assertions:** JSON diagnostics carry stable code, severity, message, path, position, field/section where applicable, and related locations; exits are 0 success, 1 completed domain rejection, 2 incomplete operation, 3 defect.

**Guardrails:** Diagnostics do not mutate, format, migrate, fetch, or repair files; strict policy changes validity treatment, not factual diagnostic order.
