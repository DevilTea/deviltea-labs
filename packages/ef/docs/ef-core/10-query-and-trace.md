# EF Core: Query and Trace

Status: Accepted

## Scope

This document defines EF Core v1 read-only Artifact lookup, structured filters,
literal full-text search, direct relations, explicit transitive trace, current
resolution, potential-impact traversal, engineering and Git history lookup,
derived indexes, deterministic ordering, context composition, and stable
machine-result schemas.

CLI command syntax, transport, human formatting, and process exit behavior are
defined by the CLI contract.

## Definitions

### Query snapshot

A query snapshot is one complete EF project state loaded from authoritative
files and configuration. Every result in one query is computed from the same
snapshot. For history lookup it additionally includes the operation-start
captured integration-ref OID and the completely materialized authoritative
first-parent history needed by that query.

### Artifact summary

An Artifact summary is the complete discovery envelope plus canonical
project-relative path. It supports selection and graph traversal without
loading the Markdown body or Resource content.

### Full Artifact

A full Artifact is an Artifact summary plus its Markdown body. Resource content
is not inlined automatically.

### Exact identity

Exact identity means that an operation addresses the Artifact with the supplied
ID without silently resolving supersession, retargeting relations, or selecting
a replacement.

### Trace

A trace is an explicit bounded traversal over caller-selected relation types
and direction. It returns a graph, not inferred or flattened relations.

### Impact candidate

An impact candidate is an Artifact reached through explicit dependency-like
incoming edges. It indicates potential impact for review, not proof that a
change is required.

### Engineering history

Engineering history is the set of completed CHG effects that target an
Artifact.

### Repository history

Repository history is derived Git provenance for an Artifact aggregate,
including draft-only changes that do not require CHG.

## Common Rules

All EF Core queries are:

- read-only;
- deterministic for the same snapshot, configuration, query, and declared
  query implementation version;
- computed from authoritative files or a verified equivalent derived index;
- ordered according to this specification;
- network-free;
- independent of LLM semantic judgment; and
- explicit about identity resolution and traversal.

Queries MUST NOT repair, format, mutate, inherit, retarget, or canonicalize
authoritative content.

Cache or index presence MUST NOT change matches, ordering, traversal,
diagnostics, or completeness.

## Projections

### Summary projection

The summary projection has these fixed core keys:

```json
{
  "schema": "ef/requirement@1",
  "type": "requirement",
  "id": "REQ-031",
  "title": "Search Result Filtering",
  "status": "active",
  "summary": "Search results must support filtering by supported criteria.",
  "tags": [],
  "relations": [],
  "resources": [],
  "path": ".engineering/req/REQ-031.md"
}
```

Every core key is required. Empty collections remain arrays. Valid Artifact,
relation, and Resource `x-*` extension fields are preserved in their
corresponding projected objects. Consumers MUST ignore extension namespaces
they do not understand.

`path` is canonical, project-relative, and uses `/`. Machine-specific absolute
project roots are not part of stable output.

### Full projection

The full projection adds exactly one required core field:

```json
{
  "body": "## Requirement\n\nThe system must ...\n"
}
```

The `body` value excludes YAML frontmatter and preserves authoritative Markdown
text and line endings as normalized by the filesystem specification.

### Projection vocabulary

EF Core v1 defines only:

```text
summary
full
```

List, search, relations, trace, impact, and resolve-current graph nodes use
summary projection. Exact lookup MAY request either projection and defaults to
full.

Resource file bytes are never implicitly included. A caller explicitly reads a
selected Resource after inspecting its descriptor.

## Lookup

Lookup accepts one exact, case-sensitive Artifact ID. It does not use title,
filename, or path as identity and does not resolve supersession implicitly.

Lookup data has the fixed shape:

```json
{
  "found": true,
  "artifact": {
    "schema": "ef/requirement@1",
    "type": "requirement",
    "id": "REQ-031",
    "title": "Search Result Filtering",
    "status": "active",
    "summary": "Search results must support filtering by supported criteria.",
    "tags": [],
    "relations": [],
    "resources": [],
    "path": ".engineering/req/REQ-031.md",
    "body": "## Requirement\n\n...\n"
  }
}
```

When the ID does not exist:

```json
{
  "found": false,
  "artifact": null
}
```

No match is a normal query outcome, not project-integrity failure. The CLI
contract defines whether a human-facing exact lookup uses a non-zero process
status for not-found control flow.

A superseded lookup returns the exact historical Artifact and its outgoing
`superseded-by` relations. It does not replace the result with active leaves.

## Structured List

List returns Artifact summaries in bytewise Artifact ID order.

### Filters

EF Core v1 defines:

| Filter | Semantics |
|---|---|
| `type` | Exact type; multiple values use OR |
| `status` | Exact status; multiple values use OR |
| `schema` | Exact schema identifier |
| `tags_any` | Artifact contains at least one supplied exact tag |
| `tags_all` | Artifact contains every supplied exact tag |
| `relation_type` | Artifact has a matching outgoing relation type |
| `relation_target` | Artifact has an outgoing relation to the exact target ID |
| `resource_type` | Artifact has a matching Resource type |
| `resource_role` | Artifact has a matching Resource role |
| `resource_normative` | Artifact has a Resource with the exact boolean value |

Different filter categories combine with AND. Within multi-value type, status,
and `tags_any` filters, supplied values combine with OR. `tags_all` uses AND.

When relation type and target are both supplied, one relation entry must satisfy
both. When multiple Resource filters are supplied, one Resource descriptor must
satisfy all supplied Resource conditions.

Enums, IDs, schema identifiers, and tags use exact case-sensitive matching.

Core v1 does not define arbitrary nested boolean expressions, joins, regex
filters, or an SQL-like query language.

### Pagination

Results are sorted before pagination. `offset` is a non-negative integer and
defaults to `0`. `limit` is a positive integer or null and defaults to null,
meaning all matching results.

List data has this shape:

```json
{
  "total": 2,
  "offset": 0,
  "limit": null,
  "artifacts": []
}
```

`total` is the full count before pagination.

## Full-text Search

### Search semantics

EF Core v1 search is normalized literal substring matching. It does not perform
relevance scoring, stemming, fuzzy matching, synonym expansion, semantic search,
or language-specific tokenization.

Searchable surfaces are:

```text
title
summary
each tag
Markdown body text
each Resource location
each Resource description
```

Search does not read binary Resource content, remote URL content, Git commit
messages, rendered output, or extension values. An extension may define a
separate namespaced query operation, but it cannot change Core search results.

### Normalization

Text and query terms use Unicode NFC normalization. Search is case-insensitive
by default using the implementation's pinned Unicode simple case-fold data.
A caller MAY request case-sensitive literal matching.

The Unicode normalization and case-fold data version is part of the query
implementation version and cache fingerprint. An implementation MUST NOT use
locale-dependent process settings.

Multiple terms use AND at Artifact scope: every term must match at least one
searchable surface of the same Artifact. Terms do not need to occur in the same
field or line.

Each term is NFC-normalized before matching and before inclusion in the result
`terms` array. Terms that become identical under the selected case-sensitive or
case-insensitive comparison are deduplicated while preserving the first input
position. An empty term before or after normalization is invalid.

### Search ordering and matches

Search results have no relevance score. Matching Artifacts are ordered by
Artifact ID. Match records use this field priority:

```text
title
summary
tags
body
resources.location
resources.description
```

Within one field, matches are ordered by authoritative surface occurrence. Body
occurrence order follows section and line; frontmatter arrays follow their
canonical stored order. This ordering does not depend on whether a stable
source coordinate is reportable. A match record contains the full matched
scalar value or original source line rather than an implementation-dependent
abbreviated snippet.

Each searchable frontmatter scalar and each original Markdown body line emits
at most one match record when it contains one or more query-term occurrences.
Repeated, overlapping, or multiple-term matches in that same scalar or line do
not create duplicate records. When a stable source coordinate is reportable,
`column` is the earliest original-source start among all matching occurrences
in that record. This fixes result multiplicity without adding span-end or
term-attribution fields.

```json
{
  "artifact": {
    "id": "REQ-031"
  },
  "matches": [
    {
      "field": "summary",
      "section": null,
      "line": null,
      "column": null,
      "text": "Search results must support filtering by supported criteria."
    },
    {
      "field": "body",
      "section": "Requirement",
      "line": 14,
      "column": 25,
      "text": "The system must support filtering by content type."
    }
  ]
}
```

Line and column are one-based original-source positions and use the Phase 9
Unicode-scalar column convention. Normalized matching is mapped back to the
original source span before a position is reported. `line` and `column` are
either both integers or both null. `section` is independently null when the
matching surface has no containing Markdown section.

Search data has this fixed shape:

```json
{
  "terms": ["filtering"],
  "case_sensitive": false,
  "total": 1,
  "offset": 0,
  "limit": null,
  "results": []
}
```

Pagination applies to matching Artifacts, not individual match records.

## Direct Relations

Direct relation lookup supports:

```text
outgoing
incoming
both
```

Outgoing edges are stored in source frontmatter. Incoming edges are derived by
finding stored edges whose target is the requested Artifact.

Every edge retains its canonical stored type and direction:

```json
{
  "source": "REQ-031",
  "type": "superseded-by",
  "target": "REQ-070"
}
```

An incoming query does not rename this edge to `supersedes` or create an inverse
Artifact relation.

Relation data has this fixed shape:

```json
{
  "artifact_id": "REQ-070",
  "direction": "incoming",
  "types": [],
  "nodes": [],
  "edges": []
}
```

An empty `types` filter means every relation type for direct relation lookup.
Nodes contain the requested Artifact and every opposite endpoint of a returned
edge, each as one unique Artifact summary. An existing Artifact with no matching
edge therefore still appears as the sole node. Edges are deduplicated and
ordered by `(source, type, target)` in bytewise order.

## Transitive Trace

Trace requires:

- one or more root Artifact IDs;
- a non-empty relation type set;
- direction `outgoing`, `incoming`, or `both`; and
- a non-negative integer `max_depth`.

Trace does not guess which relation types should be transitive. The caller can
explicitly traverse any valid stored relation type, including cyclic
`references`.

### Traversal algorithm

Trace uses breadth-first traversal:

- each root has depth `0`;
- each node records its shortest depth from any root;
- each node appears once;
- a visited set prevents infinite traversal;
- roots are deduplicated and sorted by ID;
- nodes are sorted by `(depth, id)`; and
- edges are sorted by `(source, type, target)`.

Direction controls which incident edges can advance traversal. Returned edges
always preserve canonical `source`, `type`, and `target`.

Every root is present in `nodes` at depth `0`. Except at `max_depth: 0`, after
traversal determines the node set, `edges` contains every stored edge of a
selected type whose endpoints are both in that set; direction affects node
discovery, not canonical edge orientation. Edges are deduplicated by `(source,
type, target)`. With `max_depth: 0`, only roots are returned and `edges` is
empty.

Trace returns a subgraph rather than every possible path, avoiding exponential
path enumeration.

Trace data has this shape:

```json
{
  "roots": ["PRD-012"],
  "types": ["derived-from"],
  "direction": "incoming",
  "max_depth": 4,
  "nodes": [
    {
      "artifact": {
        "id": "PRD-012"
      },
      "depth": 0
    }
  ],
  "edges": []
}
```

Artifact objects shown abbreviated in examples use the complete summary shape
in actual output.

## Current Resolution

Current resolution is a separate explicit query kind. Lookup, list, relations,
trace, impact, and history do not resolve exact identity unless the caller
explicitly requests a supported `resolve_current` option.

Resolution follows the Supersession and Canonical State specification:

- active PRD, REQ, ADR, or POL resolves to itself;
- superseded knowledge resolves recursively through every replacement;
- draft or retired knowledge resolves to an empty set;
- PROJECT resolves to itself;
- CHG is unsupported; and
- invalid or cyclic replacement graphs fail without partial leaves.

Resolution data has this fixed shape:

```json
{
  "input_id": "REQ-031",
  "current_ids": [
    "REQ-071",
    "REQ-072"
  ],
  "nodes": [],
  "edges": []
}
```

`current_ids` is deduplicated and bytewise sorted. Multiple IDs are the expected
collective replacement result and MUST NOT be collapsed to one winner.

Nodes and edges represent the traversed direct replacement subgraph. Historical
edges are not flattened or rewritten. Nodes include the exact input Artifact
and every replacement visited during resolution; edges are exactly the direct
`superseded-by` edges traversed. An active, draft, or retired input therefore
still produces one input node even when no edge is traversed.

## Impact Traversal

### Semantics

Impact returns potential review candidates reached through explicit incoming
dependency-like relations. It does not prove implementation impact or authorize
mutation.

The Core v1 impact edge set is:

```text
derived-from
addresses
governed-by
```

Traversal direction is incoming from the changed or inspected target:

```text
target <- dependency edge - potential impacted source
```

For example:

```text
POL-006 <- governed-by - REQ-031
PRD-012 <- derived-from - REQ-044
REQ-031 <- addresses ---- ADR-022
```

### Defaults and options

Impact requires one or more roots and a non-negative `max_depth`. By default:

- only active candidate Artifacts are returned;
- roots are not included as impacted candidates;
- `references` is excluded;
- CHG effect relations are excluded;
- `superseded-by` is excluded; and
- roots are not resolved implicitly.

Options MAY enable:

```text
include_references
include_non_current
resolve_current
```

When `resolve_current` is true, root resolution occurs explicitly first. Impact
then starts from every current leaf, and the response retains both the
resolution subgraph and impact subgraph.

Non-current nodes excluded by default do not advance dependency traversal. The
exact root may be non-current, but is still used as the initial incoming-edge
target unless current resolution was requested.

Impact data has this shape:

```json
{
  "roots": ["POL-006"],
  "resolved_roots": ["POL-006"],
  "max_depth": 4,
  "include_references": false,
  "include_non_current": false,
  "resolve_current": false,
  "resolution": {
    "nodes": [],
    "edges": []
  },
  "impact": {
    "nodes": [],
    "edges": []
  }
}
```

`resolved_roots` equals exact roots when resolution is false. Graph nodes use
Artifact summary plus shortest depth.

The impact graph includes its effective roots at depth `0`; roots are context
nodes, not impacted candidates. Impact candidates are the nodes at depth greater
than `0`. Traversal, edge inclusion, deduplication, depth, and ordering otherwise
follow the Trace rules using the enabled impact edge set.

## History Lookup

History lookup accepts one exact Artifact ID and combines engineering history
with derived Git provenance without making Git metadata a second Artifact
source of truth.

### Engineering effects

Engineering history consists of incoming completed CHG effects:

```text
CHG --introduces--> Artifact
CHG --modifies----> Artifact
CHG --retires-----> Artifact
```

Each effect record includes the CHG summary, effect type, before and after
status, and the authoritative integration commit that introduced the completed
effect.

### Git commits

Repository history records commits that change the Artifact aggregate: its
Artifact file, owned Resource files, or descriptor state.

History tracking uses stable Artifact ID across authoritative integration
history. It MUST NOT rely only on current path, filesystem modification time, or
heuristic Git rename detection.

Draft-only edits can appear in Git history without CHG effects because draft
mutation does not require CHG.

### Chronology

History requires materializable configured authoritative Git integration
history. Events use the integration ref's first-parent order. Commit timestamp
and CHG numeric ID do not define authoritative ordering. The `effects` and
`commits` arrays are returned in oldest-to-newest first-parent order. If the
required history is shallow, missing, inaccessible, or otherwise cannot be
materialized completely, the query fails with `EF-QRY-010`; CHG effects are not
returned as a partial fallback.

History data has this fixed shape:

```json
{
  "artifact_id": "REQ-031",
  "effects": [
    {
      "chg": {
        "id": "CHG-182"
      },
      "effect": "modifies",
      "status_before": "active",
      "status_after": "superseded",
      "commit_oid": "0123456789abcdef0123456789abcdef01234567"
    }
  ],
  "commits": [
    {
      "oid": "0123456789abcdef0123456789abcdef01234567",
      "changed_paths": [
        ".engineering/req/REQ-031.md"
      ]
    }
  ]
}
```

Actual CHG objects use complete summary projection. `status_before` is null
exactly when the Artifact was absent before an `introduces` effect;
`status_after` is the resulting status. `commit_oid` is always the full object
ID of the authoritative integration commit rather than an abbreviated display
form. Each commit's `changed_paths` array is bytewise sorted.

The mechanism for selecting authoritative integration history and materializing
aggregate history is defined by filesystem and configuration specifications.

## Cache and Index Integrity

Queries MAY use derived Artifact, relation, full-text, Resource ownership,
history, and canonical-resolution indexes.

Before use, an index fingerprint MUST cover all inputs relevant to its results,
including:

- Artifact files;
- indexed Resource descriptors and text;
- configuration;
- schema version;
- Markdown parser version;
- Unicode normalization and case-fold version;
- query-index implementation version; and
- for a history index, the captured integration-ref OID and covered
  first-parent history range.

A missing, stale, incompatible, or corrupt cache is ignored and rebuilt, or the
query falls back to authoritative files. It MUST NOT return stale output.

Cache state cannot change result matches, order, completeness, or diagnostics.

## Invalid Graph and Partial Results

EF Core v1 does not provide an `allow_partial` query mode.

When a parse, identity, or graph problem prevents the requested operation from
producing a complete trustworthy result, the query returns:

```json
{
  "complete": false,
  "data": null,
  "diagnostics": [
    {
      "code": "EF-QRY-007",
      "severity": "error",
      "message": "The requested relation graph is invalid.",
      "related": []
    }
  ]
}
```

It MUST NOT return a partial graph or Artifact collection that an Agent could
mistake for complete context.

An unrelated warning does not block a query. Exact lookup not-found is a normal
complete result with `found: false`.

That not-found exception applies only to exact lookup. Direct relations,
trace, impact, history, and current resolution require every explicitly supplied
Artifact ID to exist. If any required ID does not exist, the query returns
`complete: false`, `data: null`, and `EF-QRY-014`; it does not omit the missing
input or return results for only the IDs that were found.

Repository repair uses validation diagnostics and explicit mutation operations,
not partial query inference.

## Stable Query Result Envelope

Every machine-readable query result uses:

```json
{
  "schema": "ef/query-result@1",
  "kind": "lookup",
  "complete": true,
  "data": {},
  "diagnostics": []
}
```

All five keys are required:

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Exact value `ef/query-result@1` |
| `kind` | string | Query kind |
| `complete` | boolean | Whether the result is complete and trustworthy |
| `data` | kind-specific object or null | Query result |
| `diagnostics` | diagnostic array | Phase 9 diagnostic objects |

Query kinds are:

```text
lookup
list
search
relations
trace
impact
history
resolve-current
```

Collections always remain arrays, including zero- and one-element results.
Optional scalar values use explicit null when their key belongs to a fixed
kind-specific schema.

## Context Composition

The query model supports staged Agent context composition:

```text
lookup full PROJECT
  -> project context and canonical Terminology glossary
  -> list / search / impact
  -> Artifact summaries
  -> select exact IDs
  -> optional explicit current resolution
  -> full lookup
  -> explicitly read selected Resources
```

Example:

```text
lookup full PROJECT
  -> load project boundaries and canonical domain terminology
search literal "filtering"
  -> REQ-031 summary
resolve-current REQ-031
  -> REQ-070
lookup full REQ-070
  -> canonical body and Resource descriptors
read selected normative Resource
  -> machine-readable contract
```

No stage treats a search index or cache as authoritative, and no stage silently
changes identity.

## Validation

Query validation uses these diagnostic codes:

| Code | Severity | Condition |
|---|---|---|
| `EF-QRY-001` | error | Query kind or required input is invalid |
| `EF-QRY-002` | error | Structured filter or pagination value is invalid |
| `EF-QRY-003` | info | Exact lookup Artifact ID was not found |
| `EF-QRY-004` | error | Projection is unsupported |
| `EF-QRY-005` | error | Transitive trace relation type set is empty |
| `EF-QRY-006` | error | Direction or maximum depth is invalid |
| `EF-QRY-007` | error | Required Artifact graph is invalid |
| `EF-QRY-008` | error | Current resolution encountered an invalid graph |
| `EF-QRY-009` | error | Current resolution requested for unsupported Artifact type |
| `EF-QRY-010` | error | Requested history context is unavailable |
| `EF-QRY-011` | info | Stale or corrupt cache was ignored successfully |
| `EF-QRY-012` | error | Query normalization or index version is unsupported |
| `EF-QRY-013` | error | Query cannot produce a complete trustworthy result |
| `EF-QRY-014` | error | Required Artifact ID does not exist for this query kind |

Filter validation checks enum values, exact IDs, booleans, offsets, limits, and
cross-filter semantics before graph traversal.

Query-process exit behavior, including exact lookup not-found, is defined by
the CLI contract.

## Deferred

- Project-root discovery, Artifact paths, authoritative integration history,
  index locations, cache locations, line-ending normalization, and Git
  materialization are defined in Phase 11: Filesystem and Configuration.
- Temporary normalization input is non-authoritative and excluded from search
  and trace. Selectively retained source Resources follow Phase 12: Input
  Normalization and Promotion.
- CLI command names, arguments, human rendering, JSON transport, exit behavior,
  Resource reading, and context-bundle ergonomics are defined in Phase 13: CLI
  Contract.
- Relevance ranking, fuzzy or semantic search, arbitrary graph-query languages,
  unbounded implicit traversal, cross-project queries, partial results, Resource
  binary embedding, and LLM-selected query inference are not part of EF Core v1.
