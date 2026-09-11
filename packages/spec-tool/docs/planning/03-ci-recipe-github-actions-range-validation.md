# CI Recipe: GitHub Actions Integration-Range Validation

Status: Accepted

## Purpose

This document is an operational recipe, not a specification. It shows how to
wire `ef validate --scope range` (defined by
[09-validation.md](../ef-core/09-validation.md) "Range scope" and
[13-cli-contract.md](../ef-core/13-cli-contract.md) "CI Contract") into GitHub
Actions so that a candidate integration range is validated **while it is still
unpublished**, and so that publication is blocked until that validation
passes.

It is filed here, alongside the other planning notes, rather than under
`ef-core/` or `ef-core/use-cases/`, because it is a concrete,
implementation-specific CI configuration for one hosting provider's event
model (`pull_request` and `merge_group` events, `actions/checkout` fetch
behavior, branch-protection required checks). It demonstrates only commands
and options that already exist in
[13-cli-contract.md](../ef-core/13-cli-contract.md); it introduces no new EF
Core behavior and does not use RFC2119 keywords — where this document says a
step is required, that requirement is GitHub Actions', Git's, or the
referenced spec's, not a new obligation invented here. If anything below
conflicts with `09-validation.md` or `13-cli-contract.md`, those
specifications govern.

## What range validation requires from the caller

Range scope is a **pre-publication** operation (09-validation.md "Distinction
from history auditing": the proposed commit "is not yet published", and Core
v1 defines no post-publication audit scope). Four caller obligations follow
from that, and every one of them fails closed — exit `2`, never a false pass —
when the CI job cannot honor it:

1. **The candidate must be unpublished.** The proposed commit must not already
   be reachable from the authoritative `integration_ref`.
2. **`integration_ref` must still resolve to the baseline.** A complete range
   result whose `integration_ref` is non-null requires the captured
   operation-start OID (`expected_ref_oid`) to equal the trusted range baseline
   OID, or both to be absent; anything else is `EF-VAL-002` and exits `2`
   (09-validation.md "Ref selection, capture, and staleness"). A complete
   result can also carry `integration_ref: null` and `expected_ref_oid: null`
   alongside a non-null `baseline_oid` — that is not this obligation's
   stale-ref failure, and comparing the two null fields as if they were an OID
   mismatch misreads it. It means the range's first EF state (the baseline, or
   otherwise the bootstrap boundary) names no valid `integration_ref` at all,
   so no ref check was ever performed; that boundary's own diagnostics already
   make the result invalid (`valid: false`, exit `1`) on their own. Check
   `valid`, not a null-vs-null comparison, to tell staleness apart from this
   case (see "Reading the JSON result" below for the full distinction from the
   EF-inert-range case, which is also all-null but valid).
3. **The baseline must be on the candidate's first-parent chain.** Otherwise
   the result is `EF-VAL-011` and exits `2`; a chain that cannot be walked far
   enough to decide is `EF-VAL-007` and exits `2`.
4. **The authoritative ref must be identified correctly, and it must actually
   be present locally under that name.** These are two separate obligations:

   - *Identifying the ref.* The validator never accepts a ref OID as an
     argument and never contacts a remote, and it never derives
     `integration_ref` from `--proposed`. It reads `integration_ref` from the
     trusted range baseline's own configuration when the baseline's
     `.engineering` entry is present, and otherwise from the range's own
     bootstrap boundary — the oldest commit in the validated first-parent
     sequence whose `.engineering` entry is present (09-validation.md "Ref
     selection, capture, and staleness"). Reading `--proposed` to pick the ref
     would let a later commit's removal of EF state, or a later malformed
     configuration, preempt an earlier boundary's own findings — exactly what
     the oldest-first, fail-fast walk must not allow.
   - *Exposing that ref locally.* Once the ref name is known, the validator
     probes exactly that name in the local repository. On a GitHub runner
     nothing creates `refs/heads/main` for you unless you check that branch
     out, so the job has to materialize the authoritative ref name at its
     observed OID before validating — a job that never materializes that ref
     name locally cannot satisfy this rule, no matter how correctly the ref
     was identified. Getting this wrong does not soften the check: a locally
     absent `integration_ref` plus a supplied `--baseline` is the
     absent/present mismatch of obligation 2, so it reports `EF-VAL-002` and
     exits `2`.

Obligation 4 is why every recipe below has an explicit "capture the
operation-start ref state" step, and why the baseline OID passed to
`--baseline` is read back out of that captured ref rather than taken from an
event payload field. `github.event.pull_request.base.sha`, for instance, is
the base commit recorded for the pull request, not a fresh observation of the
branch tip, so using it as `--baseline` would assert a ref state nobody
observed.

## Why `on: push` cannot gate an integration range

An earlier version of this recipe used `on: push` with
`github.event.before`/`github.event.after`. That is wrong, and it is worth
stating why in detail, because the mistake is easy to repeat.

A `push` workflow starts **after** the pushed ref has already been updated to
`github.event.after`. By the time the job runs, the range is published:
`refs/heads/main` no longer points at `github.event.before`. So such a job can
only reach one of two outcomes:

- It fails the ref-state proof. Concretely, `actions/checkout` on a push event
  checks out `github.ref` — the integration branch itself — so the runner's
  local `refs/heads/main` resolves to `github.sha`, the *already advanced*
  tip. Validating with
  `--baseline "$BEFORE_SHA" --proposed "$AFTER_SHA"` then compares a captured
  operation-start OID of `after` against a baseline of `before` and reports
  stale `EF-VAL-002` with exit `2`, exactly as
  `src/cli/commands/validate.unit.test.ts`'s "reports EF-VAL-002 exit 2 when
  integration_ref has already advanced to the proposed commit" case requires.
- Or, if the job were rewritten to make that comparison succeed, it would only
  do so by validating state that is already authoritative — post-publication
  auditing.

Making such a job a required status check does not rescue it: a required check
can prevent a future merge, but it cannot retroactively un-push the commits
that already advanced `main`. The branch-creation case is even more direct.
GitHub reports an all-zero `github.event.before` when a push creates a branch,
and the obvious reading is "no baseline, so omit `--baseline`" — but omitting
`--baseline` is the assertion that `integration_ref` was *proven unresolved at
operation start* (13-cli-contract.md "Validation Command"), and by the time a
push job handles that all-zero value the branch exists. The assertion is
false, validation proves it false, and the run exits `2`.

This document therefore contains **no `push`-triggered range-validation
workflow at all**. Post-publication auditing is not what range scope is for
(09-validation.md "Distinction from history auditing"); if you want a
tripwire on already-published history, that is a different, non-Core
operation, and it must not be described as gating publication.

## Canonical recipe: a required `pull_request` check

The pull request head is not on the integration branch yet, `integration_ref`
still points at its pre-integration tip while the job runs, and branch
protection can make this check required so the merge cannot happen until it
passes. That is the shape range scope is defined for, and it is the shape the
package smoke test exercises against real Git objects (`test/package-smoke.mjs`
keeps the EF commits on a side branch while `main` stays at the pre-EF
baseline).

```yaml
name: EF integration-range validation

on:
  pull_request:
    branches:
      - main

permissions:
  contents: read

concurrency:
  group: ef-range-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  validate-range:
    runs-on: ubuntu-latest
    env:
      # Must equal `repository.integration_ref` in the project's
      # `.engineering/ef.yaml`, and its branch must be the `branches:` filter
      # above. If it does not match, the validator probes the ref its own
      # trusted configuration names, finds it absent locally, and exits 2.
      INTEGRATION_REF: refs/heads/main
    steps:
      - name: Check out the merge candidate
        uses: actions/checkout@v4
        with:
          # Default `ref` for a pull_request event is
          # `refs/pull/<number>/merge`, so HEAD is the merge candidate in
          # detached HEAD mode. A pull request GitHub cannot merge has no such
          # ref and this step fails, which is the correct fail-closed outcome.
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install ef
        run: npm install --global @deviltea/ef

      - name: Capture the operation-start state of the integration ref
        id: capture
        run: |
          set -euo pipefail

          # One fresh observation of the authoritative ref, materialized under
          # the exact ref name the project's configuration declares, because
          # that is the name the validator probes locally. HEAD is detached
          # here, so fetching into a local branch ref is allowed.
          git fetch --no-tags --no-recurse-submodules origin \
            "+${INTEGRATION_REF}:${INTEGRATION_REF}"

          baseline="$(git show-ref --verify --hash -- "$INTEGRATION_REF")"
          echo "baseline=${baseline}" >> "$GITHUB_OUTPUT"

      - name: Validate the candidate integration range
        env:
          BASELINE: ${{ steps.capture.outputs.baseline }}
        run: |
          set -uo pipefail

          # The candidate is the object actually present in this checkout, so
          # the OID validated is the OID read.
          proposed="$(git rev-parse HEAD)"

          status=0
          ef validate \
            --project "$GITHUB_WORKSPACE" \
            --scope range \
            --baseline "$BASELINE" \
            --proposed "$proposed" \
            --strict \
            --format json \
            --no-input > ef-range.json || status=$?

          jq -r '"scope=\(.scope) complete=\(.complete) valid=\(.valid) baseline=\(.baseline_oid) expected_ref_oid=\(.expected_ref_oid)"' ef-range.json
          jq -r '.diagnostics[] | "\(.severity) \(.code) \(.commit_oid // "-") \(.message)"' ef-range.json

          exit "$status"
```

`--project "$GITHUB_WORKSPACE"` pins project resolution to the checkout root
instead of relying on upward discovery from the runner's working directory;
authoritative configuration for range scope comes from the supplied commits,
not from the checked-out tree (11-filesystem-and-config.md "Project
Discovery").

`--strict` is a policy choice, not part of the guarantee: it requires every
Core check for range scope to be available and treats warnings as failing
(09-validation.md "Strict mode"). Drop it if you want warnings to stay
advisory.

### Which OID to pass as `--proposed`

The proposed commit must be the candidate whose publication you are gating,
and the captured baseline must be on its first-parent chain. Which OID that is
depends on the repository's merge method, because that method decides which
commits end up on `integration_ref`'s first-parent chain — and only
first-parent commits are authoritative EF states (09-validation.md "Validated
commit sequence").

| Merge method | What lands on `integration_ref`'s first-parent chain | Pass as `--proposed` |
|---|---|---|
| Create a merge commit | one merge commit whose first parent is the branch tip and whose tree is the merge result | the merge candidate: `git rev-parse HEAD` after the default checkout above (one boundary) |
| Squash and merge | one commit whose parent is the branch tip and whose tree is the merge result | the merge candidate, same as above (one boundary) |
| Rebase and merge | the pull request's own commits, replayed onto the branch tip in order, with their trees preserved | `${{ github.event.pull_request.head.sha }}`, checked out with `ref: ${{ github.event.pull_request.head.sha }}` (one boundary per commit) |
| External process that fast-forwards to a commit you built | exactly the commits you built | that exact commit (see the external-process recipe below) |

For the rebase case the pull request branch must already be up to date with
the base branch; otherwise the captured baseline is not on the head's
first-parent chain (a merge of the base *into* the branch puts the base on a
non-first-parent edge, which never satisfies membership) and validation
reports `EF-VAL-011` with exit `2`.

Do not validate the pull request's own commits when the merge method squashes
them. The published transaction is the squash, and a transaction split across
two EF-touching commits is invalid at the earlier boundary even when a later
commit supplies the covering CHG (09-validation.md "Transaction coverage
inside a range"). Validating the squashed shape and validating the split shape
are different questions; ask the one that matches what will be published.

### What the check proves, and what it does not

The proof is a statement about Git objects: given the captured baseline `B` and
the candidate `P`, every authoritative EF boundary that appending `P`'s
first-parent sequence after `B` would create is valid. A commit's EF state is
the `(mode, object type, object ID)` triple of its `.engineering` tree entry
(09-validation.md "EF state identity and boundary classification"), so the
proof survives GitHub creating fresh commit objects at merge time: a merge,
squash, or rebase commit that preserves those trees and their first-parent
order presents the validator with the same boundaries, whatever the commit
OIDs are. What the proof does not survive is a change of `B`, or a published
sequence with a different boundary shape than the one validated.

Two residual gaps, stated plainly:

- **The base branch can advance after the check passes.** Nothing re-runs a
  `pull_request` workflow when the base branch moves, so a green check can
  become a proof about a baseline that is no longer the tip. Enable "Require
  branches to be up to date before merging" alongside the required check:
  merging is then blocked until the head branch is refreshed, which pushes a
  new head commit, which re-triggers this workflow and re-captures the ref
  state.
- **The published commit object is created by GitHub at merge time.** You are
  relying on the tree-preservation argument above rather than on publishing the
  exact object you validated. If you need object-level identity between the
  validated commit and the published commit, use the external-process recipe
  below, where the commit published by the compare-and-swap is literally the
  commit that was validated. A merge queue narrows the window considerably, but
  whether its published objects are the validated objects depends on the
  queue's configured merge method.

Drift never produces a false pass: a stale baseline reports `EF-VAL-002`, a
baseline that is not a first-parent ancestor reports `EF-VAL-011`, and both
exit `2`.

### Required branch-protection settings

- Make `validate-range` a required status check on the integration branch, so
  the merge cannot proceed until it passes.
- Enable "Require branches to be up to date before merging" for the reason
  above.
- Keep direct pushes to the integration branch disallowed. A direct push
  bypasses every pre-publication gate; no workflow can gate it, because no
  workflow runs before a push completes.
- Keep the workflow's `branches:` filter aligned with the configured
  `integration_ref`. A pull request targeting some other branch is not an
  integration operation on this project's authoritative ref.

## Variant: `merge_group` (merge queue)

If the repository uses a merge queue, the queue — not a human pressing Merge —
performs the publication, and the candidate it asks you to validate is a real
commit on a temporary queue branch that is not yet on the integration branch.
That closes the "base advanced after the check" window, because the queue owns
the interval between the check and the merge.

```yaml
name: EF integration-range validation (merge queue)

on:
  merge_group:

permissions:
  contents: read

jobs:
  validate-range:
    runs-on: ubuntu-latest
    env:
      INTEGRATION_REF: refs/heads/main
    steps:
      - name: Check out the merge-group candidate
        uses: actions/checkout@v4
        with:
          # Default `ref` is the merge group's ref (the temporary queue
          # branch), so HEAD is the group's head commit, i.e.
          # `github.event.merge_group.head_sha`.
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install ef
        run: npm install --global @deviltea/ef

      - name: Capture the operation-start state of the integration ref
        id: capture
        run: |
          set -euo pipefail

          git fetch --no-tags --no-recurse-submodules origin \
            "+${INTEGRATION_REF}:${INTEGRATION_REF}"

          baseline="$(git show-ref --verify --hash -- "$INTEGRATION_REF")"
          echo "baseline=${baseline}" >> "$GITHUB_OUTPUT"

      - name: Validate the queued candidate integration range
        env:
          BASELINE: ${{ steps.capture.outputs.baseline }}
        run: |
          set -uo pipefail

          proposed="$(git rev-parse HEAD)"

          status=0
          ef validate \
            --project "$GITHUB_WORKSPACE" \
            --scope range \
            --baseline "$BASELINE" \
            --proposed "$proposed" \
            --strict \
            --format json \
            --no-input > ef-range.json || status=$?

          jq -r '"scope=\(.scope) complete=\(.complete) valid=\(.valid) baseline=\(.baseline_oid) expected_ref_oid=\(.expected_ref_oid)"' ef-range.json
          jq -r '.diagnostics[] | "\(.severity) \(.code) \(.commit_oid // "-") \(.message)"' ef-range.json

          exit "$status"
```

One invariant matters here, and it is narrower than "only one group in
flight". GitHub documents a merge group as the target branch plus the pull
request's own changes and the changes of any entries already ahead of it in
the queue
(<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue>).
Those earlier, still-unmerged entries do not by themselves cause `EF-VAL-002`:
they simply become additional first-parent boundaries between the captured
baseline and the group's head, and walking exactly that kind of boundary
sequence — several intermediate commits, none of them individually published
to `integration_ref` yet — is what range scope exists to do. Restricting the
queue to one group in flight to make this check pass would give up a
capability range scope already provides; there is no reason to do it.

The real invariant is: the freshly captured `integration_ref` tip must remain
a first-parent ancestor of the merge-group candidate. Two concrete things can
break that:

- **The target ref advances after the group was built** — a direct push, or
  another group merging ahead of this one — so that the tip this job fetches
  is no longer an ancestor of the group's head as GitHub already built it.
  `listFirstParentRange` then reports `not-an-ancestor`, i.e. `EF-VAL-011`, not
  `EF-VAL-002`: the captured baseline resolved fine, it just is not on the
  candidate's first-parent chain any more.
- **A speculative group is built on a base that is not (yet) the published
  tip** — GitHub may construct a merge group optimistically on the assumption
  that an earlier entry will succeed, before that entry has actually landed.
  If that assumed base never becomes the true tip, the same ancestry check
  fails the same way: `EF-VAL-011`.

`EF-VAL-002` in this recipe would instead mean the local `integration_ref` this
job just fetched does not resolve to the OID passed as `--baseline` — and that
does not happen merely because other queue entries are unmerged, since both
values come from the same fetch in the capture step above. Note also that when
a merge queue is enabled, the `merge_group` run is the one that gates the
merge; keep the `pull_request` job as fast author feedback if you like, but
the queue's required check is the gate.

Both workflows can live in one file (`on: [pull_request, merge_group]`) with
per-event `if:` guards on the candidate-selection step. They are shown
separately here so each is copy-pasteable and unambiguous.

## Variant: an external integration process that performs the compare-and-swap

This is the shape that is fully faithful to the contract, and the only one in
which the object you validate is guaranteed to be the object that becomes
authoritative. It is what 09-validation.md "Publication" describes: exactly one
atomic conditional ref update, whose expected old value is the validated
baseline OID (or ref absence), and whose new value is the validated proposed
OID. It works anywhere — a self-hosted integration bot, a scheduled train job,
or a maintainer's terminal.

```bash
#!/usr/bin/env bash
set -uo pipefail

INTEGRATION_REF=refs/heads/main

# ---- 1. Capture the operation-start ref state exactly once -----------------
#
# `git show-ref --verify --quiet` exits 1 specifically for a ref that is
# proven absent. Any other non-zero exit is a failed probe and must never be
# folded into "absent": that distinction is the whole reason the validator
# reports EF-VAL-006 rather than treating an unreadable ref as unborn.
probe=0
git show-ref --verify --quiet -- "$INTEGRATION_REF" || probe=$?
case "$probe" in
  0) baseline="$(git show-ref --verify --hash -- "$INTEGRATION_REF")" ;;
  1) baseline="" ;;
  *) echo "ref probe for ${INTEGRATION_REF} failed (exit ${probe})" >&2; exit 2 ;;
esac

# ---- 2. Build the candidate on top of exactly that baseline ----------------
#
# Your own logic: merge, rebase, or fast-forward the incoming work so that
# $baseline is on $proposed's first-parent chain (or, when $baseline is empty,
# so that the chain reaches a root commit).
proposed="$(build_candidate_on "$baseline")" || exit 1

# ---- 3. Validate before publishing ----------------------------------------
status=0
if [ -n "$baseline" ]; then
  ef validate --scope range --baseline "$baseline" --proposed "$proposed" \
    --strict --format json --no-input > ef-range.json || status=$?
else
  # No --baseline: the explicit assertion that `integration_ref` was proven
  # unresolved at operation start. Step 1 proved exactly that.
  ef validate --scope range --proposed "$proposed" \
    --strict --format json --no-input > ef-range.json || status=$?
fi
[ "$status" -eq 0 ] || { jq -r '.diagnostics[] | "\(.severity) \(.code) \(.commit_oid // "-") \(.message)"' ef-range.json; exit "$status"; }

# ---- 4. Publish with exactly one atomic conditional ref update ------------
#
# Three arguments make this a compare-and-swap: the update is applied only if
# the ref still holds $baseline. An empty <old-oid> requires that the ref does
# not exist, which is the publishing half of the omitted-baseline assertion.
# A separate "check, then update unconditionally" is not conforming.
if ! git update-ref "$INTEGRATION_REF" "$proposed" "$baseline"; then
  # The ref moved: the validation above is now stale. Do not retry the update
  # and do not force it. Go back to step 1, rebuild the candidate on the new
  # tip, and revalidate.
  echo "${INTEGRATION_REF} moved; validation is stale, rebuild and revalidate" >&2
  exit 1
fi
```

Notes that matter for conformance:

- **Treat any observed ref movement as staleness, not as a retryable error.** A
  failed compare-and-swap makes the result stale and the range must be
  revalidated from the actual boundary (09-validation.md "Publication").
  Re-running the update with `--force`, or dropping the expected-old-value
  argument, converts a detected race into a silent publication of unvalidated
  state.
- **When the range contains a bootstrap boundary, re-check the bootstrap
  history condition immediately before the update** (09-validation.md
  "Publication"). The simplest conforming way to do that is to run step 3
  again right before step 4 rather than reusing an older result.
- **When the authoritative ref lives on a remote,** the compare-and-swap has
  to happen there too:
  `git push --force-with-lease="${INTEGRATION_REF}:${baseline}" origin "${proposed}:${INTEGRATION_REF}"`.
  Git documents `--force-with-lease=<refname>:<expect>` as requiring the
  remote ref's current value to be `<expect>`, and an empty `<expect>` as
  requiring that the ref not already exist — the same two cases as the local
  `update-ref` above. An ordinary fast-forward push is not an
  expected-old-value compare-and-swap.
- If branch protection forbids direct pushes to the integration branch, this
  recipe cannot perform the publication; the server-side merge is then the
  compare-and-swap and you are in the merge-queue variant.

### An unborn integration ref

The honest counterpart of a push event's all-zero `github.event.before` is
this recipe's step 1 returning "proven absent". Omitting `--baseline` asserts
that `integration_ref` was proven unresolved when the operation began, and
only an integration process that observes the absence itself and then performs
the creating compare-and-swap can make that assertion true. A push-triggered
job cannot: the branch it would assert to be unborn is the branch whose
creation started the job.

For the very first publication of an EF project there is a second, simpler
option that needs no CI at all: validate locally with
`ef validate --scope bootstrap --proposed <oid>` while the integration branch
still does not exist, and only then create it. Bootstrap scope has the same
operation-start ref obligation, so it too proves the ref was unresolved rather
than assuming it.

## Checkout depth and shallow clones

Range validation walks the first-parent chain from the proposed commit back to
(and stopping at) the baseline, so the runner's local repository copy must
actually contain that history. `actions/checkout@v4` defaults to fetching a
single commit, which is enough for `--scope snapshot` but not for a range of
unknown length. Set `fetch-depth: 0` to fetch complete history, as shown
above.

Range validation needs first-parent history only between the two endpoints, so
a shallow clone that fully contains the validated sequence validates normally.
The exception is a bootstrap boundary (a commit where the authoritative EF
state first appears): its pre-bootstrap `.engineering/ef.yaml` absence probe
requires complete first-parent history before that commit, so a
bootstrap-bearing range in a shallow clone is `EF-VAL-007` and exits `2`
rather than being silently skipped or misreported as clean
(09-validation.md "Shallow and incomplete history"). A truncated chain is
never used to conclude non-membership or absence. `fetch-depth: 0` is the
simplest way to avoid depending on that distinction per candidate.

## Reading the JSON result

`--format json` emits exactly the `ef/validation-result@1` envelope
(13-cli-contract.md "Validation JSON"), so the exit code is not the only
signal available:

- `scope` is `range` for these runs.
- `baseline_oid` echoes the supplied baseline; `expected_ref_oid` is the
  captured operation-start OID of `integration_ref`. When a run fails with
  `EF-VAL-002` because the ref moved, comparing those two fields tells you
  immediately which OID the ref actually held.
- `complete` and `valid` separate "the validator could not decide" (exit `2`)
  from "the validator decided the range is invalid" (exit `1`).
- `diagnostics[].commit_oid` is present only in range scope, and only for a
  finding evaluated at one specific commit boundary (09-validation.md
  "Diagnostic object"), so it is the field that tells an author which commit in
  a multi-commit candidate to fix. Range-level findings — ancestry,
  captured-ref-state, shallow history, EF-inert range — belong to no single
  commit and omit it.
- `integration_ref` and `expected_ref_oid` are `null` in two distinct
  situations that a CI consumer must not conflate, since only one of them is a
  passing run:
  - **An EF-inert range**: no commit in `[baseline, proposed]` has an
    `.engineering` entry at all, so there is no EF state boundary of any kind.
    This is `complete: true`, `valid: true`, exit `0`, carrying exactly one
    `EF-VAL-014` info diagnostic, and no ref capture is made or required —
    because no EF publication occurs.
  - **A range whose first EF state names no valid `integration_ref`**: the
    trusted baseline (when it carries EF state) or otherwise the range's
    bootstrap boundary has an `.engineering` entry, but that boundary's own
    configuration does not name a usable `integration_ref`. This is
    `complete: true`, `valid: false`, exit `1`, carrying that boundary's own
    diagnostics (its config or snapshot errors) — and unlike the EF-inert
    case, `baseline_oid` can be non-null here. Treat this exactly like any
    other invalid range, not like the EF-inert one: the non-zero exit and
    `valid: false` already say so, but the shared all-null ref fields are easy
    to mistake for the passing case above if you check only those.
  A candidate that touches no `.engineering` path in an EF-bearing repository
  is instead an identity boundary: valid, and validated without materializing
  anything.

The steps above print the summary line and every diagnostic before
re-exporting `ef`'s exit code, so a failing check shows the codes in the job
log rather than only a non-zero status.

## Why this replaces the old commit-by-commit `git update-ref` workaround

Before range scope existed, validating a multi-commit candidate meant either
running `--scope transition` once per commit while repeatedly advancing a local
copy of `integration_ref` to emulate what its historical value would have been
at each intermediate commit, or accepting weaker coverage by validating only
the first and last commits. Both approaches required the caller to reconstruct
ref state that was never actually authoritative at any of those intermediate
points, and got harder to reason about as the candidate grew.

`--scope range` removes that requirement entirely. 09-validation.md's
"Read-only derivation" clause states it directly: range validation performs no
ref mutation, no branch checkout, and no authoritative working-tree
materialization, and the validator does not require the caller to advance
`integration_ref` (or any other ref) per intermediate commit. Every boundary in
the range — identity, bootstrap, transition, or EF-state removal — is derived
deterministically from Git objects plus the one ref state captured at operation
start. The workflows above reflect that: one `ef validate` call for the whole
candidate, no loop over individual commits, no intermediate ref writes.

The capture step is not a residue of that workaround. It writes the local
`integration_ref` **once**, to the value the authoritative ref actually holds
right now, so the validator can observe the true operation-start state; the
workaround wrote fabricated intermediate values that no ref ever held. One is
an observation, the other was an emulation — and the validator itself still
writes nothing.

## When to use `--scope transition` instead

The recipes above always use range scope so that a single-commit candidate and
a multi-commit candidate are handled by the same script — which matters,
because with merge-commit and squash merge methods the published sequence is
always exactly one commit, and range scope over a length-1 sequence is
semantically the transition primitive (09-validation.md "Definitions").
13-cli-contract.md's CI Contract also allows using `--scope transition` when
the candidate is known to add exactly one first-parent commit. A CI setup that
reliably knows this can use `--scope transition` with the same captured
baseline; note that `--baseline` is then required rather than optional, and
that transition scope requires the proposed commit's first parent to *equal*
the baseline rather than merely to have it on its first-parent chain.
