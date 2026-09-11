# 07. Query, Trace, and Explicit Context

## UC-050 — Look up and list Artifacts without changing identity

**User Story:** As an engineer, I want exact and filtered discovery of known Artifacts so I can select trustworthy context before loading full details.

**Main flow:** Use `ef query lookup <id>` with summary/full projection for one exact ID, or `ef query list` with exact type/status/schema/tag/relation/Resource filters and optional offset/limit. Select matching summary IDs explicitly.

**Success assertions:** Lookup returns the exact historical Artifact, never an automatic replacement; lists sort by Artifact ID before pagination; filter categories combine with AND while documented repeated values retain OR/AND semantics; empty lookup/list outcomes are complete normal results.

**Guardrails:** Titles, paths, partial IDs, regex, joins, inferred aliases, and
implicit current resolution are unsupported. Only exact lookup treats not-found
as successful; a missing required ID makes other ID-based graph queries
incomplete with no partial data.

## UC-051 — Search literal normalized text

**User Story:** As a researcher, I want deterministic full-text discovery so I can find candidate knowledge without hidden relevance judgments.

**Main flow:** Run `ef query search <term>...`, optionally case-sensitive. EF NFC-normalizes terms and searchable text, case-folds by default, requires every term to match the same Artifact, and reports stable source matches.

**Success assertions:** Search includes title, summary, tags, Markdown body, Resource location, and Resource description; results sort by ID; pagination is per Artifact; a match reports its original scalar/line with stable field priority and source coordinates when available.

**Guardrails:** No semantic/fuzzy/stemmed/synonym/ranked search, locale-dependent comparison, remote Resource content, binary Resource bytes, extensions, or Git messages are searched. Empty terms are invalid.

## UC-052 — Inspect direct relations and trace an explicit subgraph

**User Story:** As a reviewer, I want to navigate exact graph edges and bounded transitive dependencies so I can understand provenance without accidental graph expansion.

**Main flow:** Use `ef query relations <id>` with outgoing/incoming/both and optional types; or use `ef query trace <root>... --type ... --direction ... --max-depth ...`. EF returns canonical source/type/target edges and a bounded BFS subgraph.

**Success assertions:** Incoming edges retain stored direction rather than being renamed; trace roots are depth 0, nodes retain shortest depth, cyclic references do not loop, and selected edges/nodes have stable ordering.

**Guardrails:** Trace requires explicit non-empty types, direction, and depth;
no relation type is guessed as transitive; a missing required root or invalid
necessary graph produces an incomplete result with no partial data.

## UC-053 — Resolve current truth and estimate impact explicitly

**User Story:** As a change planner, I want to resolve a legacy Artifact or inspect potential downstream review candidates so I can act on current truth without losing history.

**Main flow:** Use `ef query resolve-current <id>` for the exact replacement subgraph and all active leaves. For possible impact, use `ef query impact <root>... --max-depth <n>` and opt into references, non-current candidates, or root resolution only when needed.

**Success assertions:** Active PRD, REQ, ADR, and POL Artifacts resolve to
themselves; PROJECT resolves to itself; superseded knowledge resolves to all
active leaves; draft and retired knowledge resolve to an empty set. Impact
defaults to incoming active `derived-from`, `addresses`, and `governed-by`
candidates and keeps roots as context depth-0 nodes.

**Guardrails:** CHG current resolution is unsupported; impact does not prove implementation impact or authorize a mutation; `references`, effects, and supersession are not default impact edges; invalid replacement graphs fail without partial leaves.

## UC-054 — Retrieve complete engineering and Git history

**User Story:** As an auditor, I want the lifecycle/effect and aggregate-file history of an exact Artifact so I can reconstruct when and how it changed.

**Main flow:** Run `ef query history <id>`. EF materializes the complete
configured authoritative first-parent history, gathers incoming completed CHG
effects, and finds commits changing the Artifact aggregate: its Markdown file
and owned Resources, plus `.engineering/ef.yaml` and
`.engineering/.gitignore` for PROJECT. It returns both arrays oldest-first.

**Success assertions:** Effect entries state CHG summary, effect, before/after status, and full integration commit OID; changed paths are sorted; identity is stable across filenames/history rather than Git rename heuristics.

**Guardrails:** Incomplete/shallow/unavailable authoritative history fails with `EF-QRY-010`, no CHG-only partial fallback; commit times and CHG numeric IDs do not define authority ordering.

## UC-055 — Compose Agent or reviewer context in explicit stages

**User Story:** As an agent or reviewer, I want to load only selected engineering context and Resource bytes so the resulting context is bounded and traceable.

**Main flow:**

1. Look up full PROJECT to obtain scope and canonical Terminology.
2. Use list, literal search, or impact to discover summaries.
3. Select exact IDs; resolve current only when requested.
4. Load chosen full Artifacts.
5. Read one selected local Resource with `ef resource read <owner-id> <location>`.

**Success assertions:** Resource read verifies exact owner, descriptor, ownership, local managed path, existence, and readability, then emits exactly raw file bytes; query JSON never includes Resource bytes.

**Guardrails:** No automatic traversal, current resolution, body loading, or Resource loading occurs; external URLs are not read/fetched; tool-built cache state cannot change authoritative results.
