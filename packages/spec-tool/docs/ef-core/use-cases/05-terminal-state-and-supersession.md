# 05. Terminal State and Supersession

## UC-035 — Supersede one active Artifact with one replacement

**User Story:** As a change author, I want to replace an active contract while
preserving the previous contract and its exact historical relationship.

**Main flow:**

1. The author creates or identifies an active same-type replacement.
2. In one CHG-backed proposed tree, they transition the old active source to
   `superseded`, add its complete `superseded-by` edge, and append meaningful
   final `## Lifecycle` prose.
3. The CHG uses `introduces` for a new replacement and `modifies` for the old
   source; an existing unchanged replacement needs no effect.
4. Transition validation verifies the atomic resulting graph and freezes the
   source upon integration.

**Success assertions:** Source, direct replacement, and relation type match; the
direct replacement is active at completion; lookup of the old ID returns exact
history; `resolve-current` follows its stored edge.

**Guardrails:** PROJECT and CHG cannot be superseded; no `supersedes` inverse,
revision or current field, or retargeting of incoming relations is created.

## UC-036 — Split or consolidate Artifacts without choosing a false winner

**User Story:** As an author, I want to split one Artifact into several or
consolidate several into one so canonical resolution represents actual scope.

**Main flow:** For a split, write every replacement edge on the one source in
the same transaction. For consolidation, transition every participating active
source and point each to the shared active replacement. Many-to-many combines
both shapes, with each source's complete target set stored on that source. Each
replacement has the same Artifact type as its source.

**Success assertions:** Current resolution returns every reachable active leaf,
deduplicated and bytewise sorted; multiple leaves are a valid collective result.

**Guardrails:** No consumer chooses one leaf implicitly; no authoritative
intermediate state may show only part of a source's replacement set.

## UC-037 — Follow later replacement chains while preserving history

**User Story:** As a consumer, I want to find current knowledge from a legacy
ID without rewriting the record of each historical transition.

**Main flow:** A replacement later becomes superseded through a new valid CHG.
`resolve-current` traverses direct `superseded-by` edges recursively until it
reaches all active leaves, while old source files and old direct pointers remain
unchanged.

**Success assertions:** Converging paths deduplicate leaves; a chain ending in a
retired item returns an empty set; nodes and edges represent actual direct paths.

**Guardrails:** Cycles fail validation and resolution; tooling never flattens an
old edge to a latest leaf or edits a frozen source to repair history.

## UC-038 — Retire knowledge that has no current replacement

**User Story:** As a maintainer, I want to stop applying an active Artifact
without inventing a replacement when the engineering truth is no longer needed.

**Main flow:** In a completed CHG, transition the active PRD, REQ, ADR, or POL
to `retired`, append a final meaningful Lifecycle explanation, declare
`retires`, and validate. A draft may instead transition directly to `retired`
without a CHG, but still appends Lifecycle prose.

**Success assertions:** Active retirement preserves a complete prior active
body; retired state is terminal, non-canonical, frozen, and historically kept.

**Guardrails:** Retirement is not deletion or reactivation; a terminal Artifact
cannot gain or remove Resources or outgoing relations.

## UC-039 — Correct current truth without rewriting terminal history

**User Story:** As a maintainer, I want to correct a past replacement mistake
while retaining an auditable history of what was integrated.

**Main flow:** The author leaves completed, superseded, and retired files
unchanged; creates an additional valid replacement transition when needed to
correct the current replacement chain; explicitly writes any still-applicable
relations and Resources; and records the correction in a new CHG.

**Success assertions:** Replacement Artifacts do not inherit titles, body, tags,
Resources, or relations; old incoming edges remain exact historical references;
the resulting current graph is valid.

**Guardrails:** No terminal mutation, replacement-set alteration, automatic
inheritance, or implicit retargeting is allowed.
