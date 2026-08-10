# CI Recipe: GitHub Actions Integration-Range Validation

Status: Accepted

## Purpose

This document is an operational recipe, not a specification. It shows how to
wire `ef validate --scope range` (defined by
[09-validation.md](../ef-core/09-validation.md) "Range scope" and
[13-cli-contract.md](../ef-core/13-cli-contract.md) "CI Contract") into a
GitHub Actions workflow that validates a push's entire integration range
before the target ref is allowed to advance.

It is filed here, alongside the other planning notes, rather than under
`ef-core/` or `ef-core/use-cases/`, because it is a concrete,
implementation-specific CI configuration for one hosting provider's event
model (`before`/`after` push SHAs, `fetch-depth`, branch-protection required
checks). It demonstrates only commands and options that already exist in
[13-cli-contract.md](../ef-core/13-cli-contract.md); it introduces no new EF
Core behavior and does not use RFC2119 keywords — where this document says a
step is required, that requirement is GitHub Actions' or the referenced
spec's, not a new obligation invented here. If anything below conflicts with
`09-validation.md` or `13-cli-contract.md`, those specifications govern.

## The workflow

```yaml
name: EF integration-range validation

on:
  push:
    branches:
      - main

jobs:
  validate-range:
    runs-on: ubuntu-latest
    steps:
      - name: Check out full history
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install ef
        run: npm install --global @deviltea/ef

      - name: Validate the pushed integration range
        env:
          BEFORE_SHA: ${{ github.event.before }}
          AFTER_SHA: ${{ github.event.after }}
        run: |
          set -euo pipefail

          zero_sha="0000000000000000000000000000000000000000"

          if [ "$BEFORE_SHA" = "$zero_sha" ]; then
            # First push of this branch: GitHub reports an all-zero `before`
            # SHA because there is no prior tip. 13-cli-contract.md defines no
            # all-zeros sentinel for `--baseline` -- omitting the option is
            # the documented assertion that `integration_ref` was proven
            # unresolved when the operation began.
            ef validate \
              --scope range \
              --proposed "$AFTER_SHA" \
              --strict \
              --format json \
              --no-input
          else
            ef validate \
              --scope range \
              --baseline "$BEFORE_SHA" \
              --proposed "$AFTER_SHA" \
              --strict \
              --format json \
              --no-input
          fi
```

Make this job a required status check on `main` in branch protection so a
range that fails validation blocks the merge or push from being treated as
green, ahead of whatever process advances the authoritative ref.

## Checkout depth

Range validation walks the first-parent chain from the proposed commit back
to (and stopping at) the baseline, so the runner's local repository copy must
actually contain that history. `actions/checkout@v4` defaults to
`fetch-depth: 1` (a single commit), which is enough for `--scope snapshot` or
`--scope transition` against a one-commit push but is not enough for a range
of unknown length. Set `fetch-depth: 0` to fetch complete history, as shown
above.

If the runner's clone is shallow and the pushed range includes a bootstrap
boundary (a commit where the authoritative EF state first appears), Core
cannot complete the required pre-bootstrap history probe and the run is
incomplete (`EF-VAL-007`, exit `2`) rather than silently skipped or
misreported as clean — see 09-validation.md "Shallow and incomplete history".
A shallow clone that fully contains the pushed range validates normally; a
full unshallow fetch is only strictly necessary once a push might include a
bootstrap boundary, but `fetch-depth: 0` is the simplest way to avoid
depending on that distinction per-push.

## The first-push / no-`before` case

GitHub reports `github.event.before` as `0000000000000000000000000000000000000000`
when a push creates a branch, because there is no previous tip to report. Core
v1 defines no all-zeros OID sentinel for ref absence (13-cli-contract.md
"Validation Command"): passing that value as `--baseline` would resolve to no
commit and fail as an unusable baseline, not as "no baseline." The workflow
above instead detects the all-zero value and omits `--baseline` entirely,
which is the documented way to assert that `integration_ref` was proven
unresolved at operation start; if that assertion turns out to be false (the
ref actually already resolved), validation reports it and exits `2` rather
than silently choosing a baseline on the caller's behalf.

## Staleness: the ref can move between validation and publication

Range validation captures the authoritative ref's state once, at the start of
the operation, and never re-resolves it (09-validation.md "Ref selection,
capture, and staleness"). If some other push or merge advances the ref after
this job captured that state but before whatever process performs the actual
publication, the two can disagree. Core does not paper over that: a complete
range result requires `expected_ref_oid == baseline_oid`, and publication
itself is a single atomic compare-and-swap from the validated baseline OID (or
proven ref absence) to the validated proposed OID (00-overview.md "publication
uses an atomic compare-and-swap from the baseline to that proposed commit").
If the ref has already moved, that compare-and-swap fails on its own terms and
the result is stale — no separate "did the ref move" check is needed in this
workflow, and none is added here. A stale result should be treated the same
as any other failed check: re-run validation against the ref's current tip
before retrying publication, rather than forcing the previously computed
result through.

## Why this replaces the old commit-by-commit `git update-ref` workaround

Before range scope existed, validating a multi-commit push meant either
running `--scope transition` once per commit while repeatedly advancing a
local copy of `integration_ref` to emulate what its historical value would
have been at each intermediate commit, or accepting weaker coverage by
validating only the first and last commits. Both approaches required the
caller to reconstruct ref state that was never actually authoritative at any
of those intermediate points, and got harder to reason about as push size grew.

`--scope range` removes that requirement entirely. 09-validation.md's "Read-only
derivation" clause states it directly: range validation performs no ref
mutation, no branch checkout, and no authoritative working-tree
materialization, and the validator does not require the caller to advance
`integration_ref` (or any other ref) per intermediate commit to emulate the
historical ref state that commit would have had. Every boundary in the range —
identity, bootstrap, transition, or EF-state removal — is derived
deterministically from Git objects plus the one ref state captured at
operation start. The workflow above reflects that: it runs `ef validate` once
for the whole pushed range, with no intermediate `git update-ref`, no loop over
individual commits, and no local mutation of any ref.

## When to use `--scope transition` instead

The recipe above always uses range scope so that a single-commit push and a
multi-commit push are handled by the same script. 13-cli-contract.md's CI
Contract also allows using `--scope transition` when the candidate is known to
add exactly one first-parent commit, which is a strict special case of range
(09-validation.md's "Definitions" describes transition as the length-1
primitive that range generalizes). A CI setup that already reliably
distinguishes single-commit pushes from multi-commit pushes MAY keep using
`--scope transition` for the former; this recipe simply avoids requiring that
distinction.
