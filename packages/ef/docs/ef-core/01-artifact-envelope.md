# EF Core: Artifact Envelope

Status: Accepted

## Scope

This document defines the common metadata envelope shared by every formal EF
Artifact. It defines the top-level frontmatter shape, field presence and types,
extension fields, canonical representation, and envelope-level validation.

The detailed semantics of identity, lifecycle, relations, resources, and
artifact bodies are defined by later EF Core specifications.

## Definitions

### Artifact envelope

The artifact envelope is the YAML frontmatter at the beginning of an Artifact
file. It is authoritative metadata and provides a stable discovery context for
humans and tools without requiring the complete Markdown body or supporting
resources to be loaded.

Every envelope contains these core fields:

1. `schema`
2. `type`
3. `id`
4. `title`
5. `status`
6. `summary`
7. `tags`
8. `relations`
9. `resources`

All core fields are required. Extension fields are optional.

### Discovery context

The complete artifact envelope is the minimum context that a discovery,
selection, indexing, or context-composition tool can rely on. The Markdown
body and selected resources form the full artifact context.

The envelope does not replace the Markdown body. In particular, `summary`
provides a compact semantic description but does not contain the artifact's
complete meaning, rationale, contract, decision, or evidence.

## Schema

### Core fields

| Field | Type | Required | Empty value allowed |
|---|---|---:|---:|
| `schema` | string | Yes | No |
| `type` | string | Yes | No |
| `id` | string | Yes | No |
| `title` | string | Yes | No |
| `status` | string | Yes | No |
| `summary` | string | Yes | No |
| `tags` | array of strings | Yes | Yes, as `[]` |
| `relations` | array of mappings | Yes | Yes, as `[]` |
| `resources` | array of mappings | Yes | Yes, as `[]` |

### `schema`

`schema` identifies the artifact schema and its major version. EF Core v1 uses
the form `ef/<schema-name>@1`.

The defined schema identifiers are:

| Artifact | Schema identifier |
|---|---|
| PROJECT | `ef/project@1` |
| PRD | `ef/prd@1` |
| REQ | `ef/requirement@1` |
| ADR | `ef/decision@1` |
| POL | `ef/policy@1` |
| CHG | `ef/change@1` |

Minor and patch versions are not encoded in an Artifact. Schema compatibility
and migration rules are deferred to the filesystem and configuration phase.

### `type`

`type` identifies the Artifact type. Its allowed values and their corresponding
schemas are:

| Artifact | Type | Required schema |
|---|---|---|
| PROJECT | `project` | `ef/project@1` |
| PRD | `prd` | `ef/prd@1` |
| REQ | `requirement` | `ef/requirement@1` |
| ADR | `decision` | `ef/decision@1` |
| POL | `policy` | `ef/policy@1` |
| CHG | `change` | `ef/change@1` |

Aliases and case variants are not valid. The `schema` and `type` values MUST
correspond according to this table.

### `id`

`id` is the Artifact's stable identity. It MUST be a non-empty, single-line
string. The envelope validates only its presence and scalar type. Its syntax,
prefix, uniqueness, allocation, immutability, and relationship to filenames
are defined by the identity specification.

### `title`

`title` is the short human-readable name of the Artifact. It MUST be a
non-empty, single-line string after trimming surrounding whitespace. It is not
an identity and does not need to be unique.

### `status`

`status` is the Artifact's lifecycle state. It MUST be a non-empty, single-line
string. The envelope validates only its presence and scalar type. Allowed
values and transitions are defined by the lifecycle specification.

### `summary`

`summary` is a short, self-contained semantic description of the Artifact. It
is authoritative metadata used for discovery, context selection, graph
previews, and other representations that do not load the complete body.

`summary` MUST be a non-empty string after trimming surrounding whitespace. It
MAY use a YAML folded scalar and MAY contain more than one sentence. EF Core v1
does not impose a character or sentence limit.

The summary MUST describe the Artifact's core meaning, MUST remain consistent
with its body, and MUST NOT introduce commitments, decisions, constraints, or
claims that the body does not support. It is not a substitute for required body
content.

### `tags`

`tags` is an array of classification and discovery labels. It MUST be present
and MAY be empty. Each entry MUST be a string matching:

```regex
^[a-z0-9]+(?:[._-][a-z0-9]+)*$
```

Tags are case-sensitive, MUST be unique, and MUST be stored in bytewise
lexicographic order. A producer MUST serialize an artifact with no tags as
`tags: []`.

### `relations`

`relations` is an array of mappings representing outgoing Artifact relations.
It MUST be present and MAY be empty. A producer MUST serialize an artifact with
no relations as `relations: []`.

At the envelope level, every non-empty entry MUST be a mapping. Relation entry
fields, ontology, direction, compatibility, ordering, uniqueness, and graph
rules are defined by the relations specification.

### `resources`

`resources` is an array of mappings describing supporting resources owned or
referenced by the Artifact. It MUST be present and MAY be empty. A producer
MUST serialize an artifact with no resources as `resources: []`.

At the envelope level, every non-empty entry MUST be a mapping. Resource entry
fields, ownership, path and URL handling, ordering, uniqueness, and validation
hooks are defined by the resource specification.

### Extension fields

An extension field is an optional top-level field whose name matches:

```regex
^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)+$
```

The first component after `x-` is an extension namespace. For example,
`x-acme-owner-team` is valid, while `x-owner` is not sufficiently namespaced.

Extension values MUST be JSON-compatible: string, number, boolean, null, array,
or mapping. Mapping keys MUST be strings. Numbers use the RFC 8785 JSON number
model: they MUST be finite IEEE 754 binary64 values, MUST NOT use `NaN` or
infinity, and negative zero is canonically serialized as `0`. An implementation
that cannot preserve a parsed numeric value exactly under that model MUST reject
the value rather than round it silently.

Extension fields MUST NOT redefine or change core identity, lifecycle, relation,
resource, or validation semantics.

Core tooling MUST preserve extension fields it does not understand. A declared
extension or plugin MAY apply additional validation to fields in its namespace,
but that validation uses a separate namespaced result and cannot change Core
validity, completeness, strict-mode outcome, or Core diagnostics.

## Rules

### Required presence and defaults

All nine core fields MUST appear explicitly in stored Artifact frontmatter.
Missing fields MUST NOT be silently supplied while parsing or validating an
existing file.

Artifact creation tools SHOULD initialize `tags`, `relations`, and `resources`
to empty arrays. A formatter or repair command MAY add missing collection fields
only as an explicit file mutation that is visible to the caller.

There is no empty or placeholder default for `schema`, `type`, `id`, `title`,
`status`, or `summary`. Values such as an empty string or `TODO` do not satisfy
the requirement for meaningful non-empty metadata.

### Canonical ordering

Core fields MUST be serialized in this order:

```text
schema
type
id
title
status
summary
tags
relations
resources
```

Extension fields follow all core fields and are sorted by field name in
bytewise lexicographic order.

Field order does not change Artifact semantics. Non-canonical order is a
warning during validation. A canonical formatter MUST emit the order defined
above deterministically.

The canonical ordering of relation entries and resource entries is deferred to
their respective specifications.

### Unknown fields

An unknown top-level field that does not match the extension-field pattern is
an error. It MUST NOT be ignored or silently removed. This rule prevents typing
errors from becoming unvalidated metadata.

Unknown valid extension fields are allowed and MUST be preserved.

### YAML boundary

Artifact files MUST use UTF-8. The frontmatter MUST:

- begin at the start of the file with `---`;
- end with a second `---` delimiter;
- contain exactly one top-level mapping;
- contain no duplicate mapping keys; and
- use YAML 1.2-compatible values.

YAML anchors, aliases, merge keys, and custom tags are forbidden. These
constructs are excluded to keep parsing, validation, mutation, and
serialization deterministic across implementations.

Whether an empty Markdown body is valid is determined by the artifact-specific
body schemas.

## Examples

### Minimal valid REQ envelope

```yaml
---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
---
```

This example is valid at the envelope level. Whether `REQ-031` and `draft` are
valid under the identity and lifecycle specifications is validated separately.

### Envelope with discovery metadata and an extension

```yaml
---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: active
summary: Search results must support content-type and modification-date filters without changing the underlying relevance order.
tags:
  - search
  - user-experience
relations:
  - type: derived-from
    target: PRD-012
resources:
  - type: json-schema
    location: .engineering/resources/REQ-031/search-filter.schema.json
    role: contract
    media_type: application/json
    normative: true
    description: Canonical persisted representation of a search-filter expression.
x-acme-owner-team: search-platform
---
```

This example is envelope-valid. Its identity, status, relation, and resource
entries require validation by later specifications.

### Invalid: missing a core field

```yaml
---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
---
```

This envelope is invalid because `resources` is absent. A parser MUST NOT treat
the missing field as an implicit empty array.

### Invalid: unknown core field

```yaml
titel: Search Result Filtering
```

`titel` is invalid because it is neither a core field nor a namespaced
extension field.

### Invalid: incorrect collection types

```yaml
tags: search
relations:
  type: derived-from
  target: PRD-012
```

Both fields are invalid because they MUST be arrays.

### Invalid: schema and type mismatch

```yaml
schema: ef/decision@1
type: requirement
```

The schema and type do not identify the same Artifact type.

### Invalid: duplicate key

```yaml
status: draft
status: active
```

Duplicate mapping keys are invalid even if a YAML parser would otherwise select
one of the values.

### Invalid: unnamespaced extension

```yaml
x-owner: search-platform
```

The field does not contain both an extension namespace and a field name. A
valid alternative is `x-acme-owner`.

## Validation

An envelope validator MUST report every independently detectable envelope
error in a single run when continuing validation is safe. Diagnostics intended
for machine consumption contain at least:

- stable diagnostic code;
- severity;
- human-readable message;
- file path; and
- field path when the problem belongs to a field.

The complete diagnostic object, including source locations and required
`related` collection, follows the [Validation and Integrity](09-validation.md) diagnostic contract. A stable
`location` SHOULD be included when available.

Example diagnostic:

```json
{
  "code": "EF-ENV-006",
  "severity": "error",
  "message": "Unknown top-level field 'titel'; extension fields must begin with a valid namespace.",
  "path": ".engineering/req/REQ-031.md",
  "field": "titel",
  "location": {
    "line": 8,
    "column": 1
  },
  "related": []
}
```

The envelope diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-ENV-001` | error | Missing or unterminated frontmatter |
| `EF-ENV-002` | error | Frontmatter is not exactly one top-level mapping |
| `EF-ENV-003` | error | Missing required core field |
| `EF-ENV-004` | error | Invalid field type or forbidden empty scalar |
| `EF-ENV-005` | error | Duplicate YAML mapping key |
| `EF-ENV-006` | error | Unknown non-extension field |
| `EF-ENV-007` | error | Invalid extension field name or value shape |
| `EF-ENV-008` | error | Unsupported schema identifier or major version |
| `EF-ENV-009` | error | Schema and type mismatch |
| `EF-ENV-010` | error | Forbidden YAML construct |
| `EF-ENV-011` | warning | Non-canonical field or extension ordering |
| `EF-ENV-012` | error | Invalid or duplicate tag |
| `EF-ENV-013` | warning | Non-canonical tag ordering |

Semantic consistency between `summary` and the body is a required authoring and
review invariant. Deterministic core validation is not required to infer this
semantic relationship automatically.

## Deferred

- ID syntax, prefixes, allocation, uniqueness, immutability, and filenames are
  defined in [Artifact Identity](02-identity.md).
- Lifecycle states, transitions, terminal-state immutability, and current-state
  semantics are defined in [Lifecycle](03-lifecycle.md).
- Relation entry fields, vocabulary, direction, compatibility, inverses,
  ordering, uniqueness, and graph validation are defined in [Relations Ontology](04-relations.md).
- Supersession and canonical-state rules are defined in [Supersession and Canonical State](05-supersession.md).
- Resource entry fields, ownership, paths, URLs, ordering, and validation hooks
  are defined in [Resource Schema](06-resources.md).
- Required Markdown sections and body validation are defined in [Artifact Body Schemas](08-artifact-schemas.md).
- Complete diagnostic output, strict mode, warnings-as-errors, and process exit
  codes are defined in [Validation and Integrity](09-validation.md).
- Schema compatibility, migration, project layout, and configuration are
  defined in [Filesystem and Configuration](11-filesystem-and-config.md).
