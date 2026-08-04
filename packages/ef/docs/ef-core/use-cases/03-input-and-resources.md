# 03. Input Normalization and Evidence

## UC-020 — Normalize raw input without making it authoritative

**User Story:** As a researcher, I want to inspect and normalize incoming
material safely so transient source material does not become accidental
canonical knowledge.

**Main flow:**

1. The researcher supplies raw files, URLs, pasted notes, transcripts, or
   generated material to a disposable normalization workspace.
2. Tooling may extract text, normalize encoding, detect duplicates, and help
   resolve conflicts as review activity.
3. The workspace stays under ignored `.engineering/.tmp/raw/` or equivalent
   disposable state and can be discarded at any time.
4. The researcher promotes only selected material via UC-021 or UC-022.

**Success assertions:** No RAW Artifact, raw-input manifest, persistent raw
directory, relation, or ID is created; raw material is absent from Core search,
trace, and validation inputs.

**Guardrails:** Normalization does not make a source true, create a semantic
claim, fetch external content during deterministic validation, or preserve all
input by default.

## UC-021 — Retain transaction-specific provenance in a CHG

**User Story:** As a change author, I want to retain selected source snapshots
and verification evidence with a CHG so reviewers can audit one transaction.

**Main flow:**

1. The author selects only material required for audit, offline preservation,
   or verification.
2. They copy it to `.engineering/resources/<CHG-ID>/` and add complete
   CHG-owned Resource descriptors, normally with `normative: false` and an
   `evidence` or `reference` role.
3. They explain origin in the CHG `## Sources` list and use a `references`
   relation for Artifact sources where appropriate.
4. The CHG freezes its evidence when completed or retired.

**Success assertions:** The CHG has at least one source/origin item and owned
evidence has one owner; a PR/Issue/external URL can be a reference Resource.

**Guardrails:** CHG-owned evidence needs no CHG self-effect, and a completed
CHG cannot be edited later to append newly discovered provenance.

## UC-022 — Promote continuing evidence or a contract to a knowledge Artifact

**User Story:** As an author, I want to attach long-lived context, a canonical
contract, or continuing evidence to the knowledge Artifact it supports.

**Main flow:** Select the material, copy it under the target owner's Resource
directory, and declare the descriptor. A new active owner includes the Resource
in its `introduces` aggregate, an existing active owner requires `modifies`,
and a draft owner may be edited without a CHG.

**Success assertions:** A normative OpenAPI or JSON Schema is local and owned
by the relevant REQ/ADR/etc.; the CHG `## Changes` section describes added,
modified, removed, moved, or descriptor-changed Resources.

**Guardrails:** Promotion does not transfer historical paths or automatically
inherit Resources into a replacement; a descriptor without bytes and bytes
without a descriptor are both invalid.

## UC-023 — Use supporting external material safely

**User Story:** As a reviewer, I want to cite a stable external source without
making its mutable remote bytes part of EF truth.

**Main flow:** The author records a valid HTTP(S) URL as an external,
non-normative `reference` (or another accurate supporting) Resource, describes
its role, and records it in a CHG source list when it motivated a transaction.

**Success assertions:** The descriptor is searchable by its URL/description;
the URL may be cited by multiple Artifacts; Core validation remains network-free.

**Guardrails:** `file:` locations, non-HTTP(S) remote forms, fetching, and
`normative: true` external resources are rejected.

## UC-024 — Run optional Resource-specific validation hooks

**User Story:** As a maintainer, I want available specialized validators to
inspect declared machine-readable Resources so I receive additional advisory
feedback without changing Core integrity semantics.

**Main flow:** Core always validates the owner, descriptor, and local file. A
normative local `json-schema` or `openapi` Resource also runs its required
minimum syntax check. After required checks pass, a built-in Resource type may
run an available optional specialized validator that is deterministic, local,
read-only, and network-free.

**Success assertions:** A malformed normative structured Resource is a Core
error, while an unavailable required syntax capability makes validation
incomplete. An additional specialized hook may add informational advisory
findings; its presence, absence, success, or failure does not otherwise change
default or strict Core validity or completeness. Active owner changes remain
CHG-attributed.

**Guardrails:** An unavailable optional hook may produce an informational
finding but is not a missing required Core capability. Namespaced Resource
validators run under separate extension contracts, and semantic or remote
verification is not inferred.

## UC-025 — Migrate a readable nonterminal schema explicitly

**User Story:** As a maintainer, I want to upgrade supported nonterminal
Artifact representations deliberately so schema evolution remains reviewable
and historical records stay byte-stable.

**Main flow:** The maintainer selects an explicit migration operation supplied
outside ordinary Core reads, confirms the implementation can read the existing
major and write the configured major, prepares any active changes in a CHG, and
validates the resulting authoritative transition.

**Success assertions:** Draft or active Artifacts may be migrated explicitly;
an active migration is CHG-attributed; `artifact_write_major` controls emitted
major 1 without silently rewriting existing files.

**Guardrails:** Discovery, validation, query, and cache rebuild never migrate;
superseded, retired, and completed Artifacts remain byte-frozen at their
historical major; unreadable required schema produces an incomplete operation,
not partial interpretation.
