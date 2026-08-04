# EF Core: Resource Schema

Status: Accepted

## Scope

This document defines the EF Core v1 Resource descriptor, local and external
locations, resource types and roles, media types, normative content, ownership,
ordering, lifecycle behavior, missing and orphan validation, and validation
hooks.

Resources supplement an owning Artifact. They do not have independent Artifact
identity, lifecycle, relations, or Markdown bodies.

## Definitions

### Resource

A Resource is a supporting representation, contract, evidence item, example,
reference, prototype, or asset associated with one Artifact.

A Resource consists of a descriptor in the owner's `resources` array and,
for a local Resource, a repository file at the descriptor's `location`.

### Resource owner

The owner is the Artifact whose frontmatter stores the Resource descriptor.
Every local Resource has exactly one owner. The owner controls Resource
mutation and lifecycle behavior.

An external URL is referenced rather than owned content. The same external URL
may independently appear in more than one Artifact.

### Local Resource

A Resource whose `location` is a normalized project-relative path is local. Its
content is part of the repository file source of truth.

### External Resource

A Resource whose `location` is an absolute HTTP or HTTPS URL is external. Its
remote content is not an authoritative repository file and therefore cannot be
normative.

### Normative Resource

A Resource with `normative: true` contributes to the canonical engineering
meaning of its owner Artifact. Normative content MUST be stored locally in the
repository.

### Supporting Resource

A Resource with `normative: false` helps explain, demonstrate, reference, or
verify an Artifact without independently defining its canonical meaning.

## Schema

### Resource descriptor

Every Resource descriptor contains exactly six required core fields:

```yaml
resources:
  - type: openapi
    location: .engineering/resources/REQ-031/search-api.openapi.yaml
    role: contract
    media_type: application/yaml
    normative: true
    description: Canonical HTTP contract for search filtering.
```

| Field | Type | Required | Empty allowed |
|---|---|---:|---:|
| `type` | string | Yes | No |
| `location` | string | Yes | No |
| `role` | string | Yes | No |
| `media_type` | string | Yes | No |
| `normative` | boolean | Yes | Not applicable |
| `description` | string | Yes | No |

All six core fields MUST appear explicitly. A parser MUST NOT supply missing
Resource fields silently.

Resource descriptors have no `id`, `title`, `status`, `relations`, or body.
EF Core v1 does not use separate nullable `path` and `url` fields; `location`
provides one stable descriptor shape for both local paths and external URLs.

### Resource extension fields

A Resource descriptor MAY contain namespaced `x-*` extension fields using the
Artifact envelope extension-name and JSON-compatible value rules.

Extension fields follow all Resource core fields in bytewise lexicographic
field order. Unknown non-extension fields are invalid. Core tooling MUST
preserve unknown valid extension fields and MUST NOT derive core Resource
semantics from them.

### Built-in Resource types

`type` identifies the representation or specialized validator class. EF Core
v1 defines:

```text
openapi
json-schema
diagram
example
benchmark
prototype
screenshot
reference
data
asset
other
```

The meanings are:

| Type | Meaning |
|---|---|
| `openapi` | OpenAPI document |
| `json-schema` | JSON Schema document |
| `diagram` | Architecture, sequence, flow, or other diagram |
| `example` | API, payload, configuration, or behavior example |
| `benchmark` | Performance measurement or benchmark evidence |
| `prototype` | Prototype or executable demonstration |
| `screenshot` | Visual evidence or interface reference |
| `reference` | External specification, paper, or document |
| `data` | Structured supporting dataset |
| `asset` | Other binary or presentation asset |
| `other` | Representation without specialized core semantics |

A custom Resource type MUST use a namespaced extension name such as
`x-acme-threat-model`. An unknown, non-namespaced type is invalid.

`other` receives generic Resource validation and no type-specific validation
hook.

### Resource roles

`role` identifies the Resource's engineering function relative to its owner.
EF Core v1 defines:

```text
contract
evidence
explanation
example
reference
prototype
asset
```

| Role | Meaning |
|---|---|
| `contract` | Machine-readable or precise content that forms part of the Artifact contract |
| `evidence` | Evidence supporting an assertion, verification, change, or decision |
| `explanation` | Material that helps a reader understand the Artifact |
| `example` | A concrete illustration of expected or allowed behavior |
| `reference` | Background or external source material |
| `prototype` | Exploratory or demonstrative implementation |
| `asset` | Rendering, presentation, or other supporting asset |

`type` and `role` are independent. For example, a JSON Schema can be a
normative `contract` or a non-normative `example`, and a screenshot can be
`evidence` or an explanatory `asset`.

Custom roles are not part of EF Core v1. A use case that needs extra
classification can add a namespaced extension field without changing core role
semantics.

### Media type

`media_type` is a lowercase ASCII MIME media type in `type/subtype` form,
without parameters. Each side MUST match
`[a-z0-9][a-z0-9!#$&^_.+-]*`; the complete value therefore matches
`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`. Examples include:

```text
application/json
application/yaml
text/markdown
image/png
image/svg+xml
application/pdf
```

Charset and other parameters are not stored in v1 Resource descriptors. A
malformed or uppercase media type is invalid.

Core validation uses the declared media type and deterministic built-in rules.
It MUST NOT depend on an operating system MIME database. A mismatch between
file extension and declared media type under the table below is a warning.
Optional specialized validation cannot promote that mismatch to a Core error.

Core v1 defines mismatch warnings only for this finite ASCII
case-insensitive filename-suffix mapping:

| Suffix | Expected media type |
|---|---|
| `.csv` | `text/csv` |
| `.html`, `.htm` | `text/html` |
| `.json` | `application/json` |
| `.md` | `text/markdown` |
| `.pdf` | `application/pdf` |
| `.png` | `image/png` |
| `.svg` | `image/svg+xml` |
| `.yaml`, `.yml` | `application/yaml` |

When a local Resource's final path segment has one listed suffix and declares a
different media type, validation emits `EF-RES-018`. Unlisted suffixes produce
no mismatch finding. Implementations MUST NOT add Core mismatch mappings from
an operating-system or implementation-specific database.

### Description

`description` is a non-empty, self-contained explanation of why the Resource is
relevant to its owner. It is authoritative discovery metadata used for context
selection and MUST describe more than the filename alone.

EF Core v1 imposes no fixed character or sentence limit.

## Rules

### Location classification

A `location` with no URI scheme is a project-relative local path. An absolute
URL beginning with `https://` or `http://` is external.

No other URI scheme is valid in EF Core v1. In particular, `file://` is
forbidden. A colon is forbidden in a local path so a value cannot be
ambiguously interpreted as a URI scheme.

### Local path resolution

Local locations resolve relative to the EF project root, not relative to the
owning Artifact file. Artifact location is fixed by its canonical type path and
does not participate in Resource resolution.

A local location MUST:

- use `/` as its path separator;
- be a normalized relative path;
- contain no empty, `.` or `..` segment;
- not begin with `/` or `~`;
- contain no backslash or colon;
- resolve within the EF project root;
- be stored beneath `.engineering/resources/<OWNER-ID>/`, where
  `<OWNER-ID>` exactly matches the owning Artifact ID;
- match actual path case exactly; and
- resolve to a regular file rather than a directory.

Symlinks are forbidden for local Resource files and every directory component
of a local Resource path, even when resolution would remain inside the project
root.

Examples:

```text
.engineering/resources/REQ-031/search-filter.schema.json
.engineering/resources/ADR-022/benchmark.csv
```

The managed Resource directory layout is defined by the filesystem
specification.

### External URLs

An external location MUST be an ASCII absolute URI conforming to RFC 3986, with
scheme exactly `https` or `http`, an authority component, and a non-empty host.
Whitespace, control characters, malformed percent escapes, user information,
and non-ASCII IRI text are invalid. HTTPS is canonical. HTTP is allowed for
legacy sources but produces a security warning. The exact serialized URL is
authoritative; validators do not resolve, rewrite, decode, or otherwise
canonicalize it.

Deterministic core validation checks URL syntax only. It MUST NOT fetch the URL,
follow redirects, or depend on DNS, network availability, TLS state, or HTTP
status.

Remote availability checking MAY be provided by an explicit non-core network
operation. Its result does not determine deterministic core validity.

### Normative rules

`normative` MUST be a YAML boolean, not a string or number.

- `role: contract` requires `normative: true`.
- `role: explanation`, `example`, `reference`, `prototype`, or `asset` requires
  `normative: false`.
- `role: evidence` MAY be normative or supporting according to its declared
  engineering use.
- An external URL MUST always use `normative: false`.
- A normative Resource MUST be a local repository file.

External content cannot define canonical EF truth because it may change or
disappear independently of repository history. When an external source must be
preserved as normative input, the required content is captured as a local
Resource and its source URL can be listed separately as a non-normative
reference.

### Exclusive local ownership

Each local Resource location has exactly one owner in the entire EF project.
The same local path MUST NOT appear in more than one Artifact's `resources`
array, even with different roles, types, or extension fields.

Once a local location enters authoritative integration history, ownership of
that location MUST NOT be transferred to another Artifact. Active-owner
mutation can update or remove a Resource through CHG, but a removed location
remains historically associated with its original owner and cannot later be
reused by a different owner.

The required `.engineering/resources/<OWNER-ID>/` location and permanent
Artifact-ID reservation make this invariant derivable from the current path and
owner. Core transition validation does not need a separate Git-history ownership
scan.

When multiple Artifacts depend on one local Resource, one appropriate Artifact
owns it and the others use Artifact `references` edges to that owner. EF Core v1
does not define relations whose target is an individual Resource descriptor.

External URLs do not have exclusive ownership. The same URL MAY appear once in
each of multiple Artifacts because each descriptor is an independent reference.

### Descriptor identity and duplicates

A Resource has no global stable ID. Within one owning Artifact, `location` is
the descriptor key.

- The same location MUST NOT occur twice in one Artifact.
- Extension values do not make duplicate locations distinct.
- Changing a location is a removal of the old descriptor and addition of a new
  descriptor in one mutation.
- Local location uniqueness additionally applies across the complete project.

### Canonical ordering

Resource descriptors MUST be sorted by `location` using bytewise lexicographic
order.

Fields within each descriptor use this order:

```text
type
location
role
media_type
normative
description
x-* fields in bytewise lexicographic order
```

Ordering does not change Resource semantics. Non-canonical ordering is a
warning, and a formatter MUST emit canonical order deterministically.

### Owner lifecycle and immutability

Resource content and descriptors follow the mutation class of their owner:

| Owner state | Resource mutation policy |
|---|---|
| `draft` | Mutable during authoring |
| `active` | Mutation requires a CHG transaction |
| `superseded` | Frozen |
| `retired` | Frozen |
| CHG `completed` | Frozen |
| CHG `retired` | Frozen |

Resource mutation includes adding or removing a descriptor, changing descriptor
metadata, moving or replacing a local file, and changing local file content.

The terminal transition and its Resource state become visible atomically. Once
the owner is terminal, neither its descriptors nor its owned local files may be
modified or removed.

### No inheritance or transfer on supersession

When an owner is superseded:

- its Resource descriptors remain unchanged and frozen;
- its owned local files remain at their existing locations and frozen;
- its replacements inherit no Resource descriptor or content implicitly;
- a replacement that needs equivalent content declares and owns a Resource at
  its own new local location; and
- no replacement takes ownership of the historical local path.

Even byte-identical content does not permit ownership transfer. Derived tools
MAY deduplicate storage internally, but authoritative descriptors and paths
continue to express distinct ownership.

### Missing local Resources

A local descriptor whose resolved regular file does not exist is invalid.
Validation MUST NOT silently create an empty file, remove the descriptor, or
search other directories for a matching basename.

### Orphan files

Orphan validation applies to the fixed EF-managed Resource root
`.engineering/resources/`. A file inside that root that has no owning
descriptor is an error.

Files outside the managed Resource root are ordinary repository files and are not
classified as orphan Resources merely because no Artifact declares them.

Treatment of temporary files is defined by the filesystem and configuration
specification.

### Required normative syntax checks

A normative local Resource with built-in type `json-schema` or `openapi` MUST
pass a required deterministic Core syntax check. This check is part of Resource
integrity rather than an optional advisory hook.

- A normative `json-schema` Resource MUST parse according to its declared JSON
  or YAML media type into a JSON-compatible value whose root is a mapping or
  boolean.
- A normative `openapi` Resource MUST parse according to its declared JSON or
  YAML media type into a mapping with a non-empty scalar `openapi` field.

These checks establish readable structured syntax and the minimum identifying
shape. Complete JSON Schema metaschema validation and complete OpenAPI semantic
validation remain optional advisory work. A required syntax failure emits
`EF-RES-020`. If an implementation cannot provide a required normative syntax
capability, the requested validation is incomplete and emits `EF-VAL-006`
rather than accepting the Resource without the check.

### Validation hooks

After every required normative syntax check, a built-in Resource type MAY select
an additional optional Core specialized validator. For example:

```text
openapi     -> OpenAPI syntax and structure validator
json-schema -> JSON Schema syntax and structure validator
```

Validation hooks MUST:

- be deterministic in core validation mode;
- perform no network access in Core mode;
- operate read-only;
- report stable diagnostics; and
- validate the declared Resource without modifying it.

Optional specialized validation is advisory Core output. Its presence, absence,
success, or failure MUST NOT change default or strict Core validity. A malformed
content report from such a validator is therefore informational rather than a
Core integrity error. Generic location, ownership, media type, and lifecycle
validation always applies.

An extension MAY provide a separate namespaced validation operation under its
own contract. Its findings are outside the Core validation result and MUST NOT
change Core validity, completeness, strict-mode outcome, or Core diagnostics.
A namespaced Resource type therefore cannot select or require a Core hook;
tooling invokes its validator only through that separate extension operation.

## Examples

### Normative local contract

```yaml
resources:
  - type: json-schema
    location: .engineering/resources/REQ-031/search-filter.schema.json
    role: contract
    media_type: application/json
    normative: true
    description: Canonical persisted representation of a search-filter expression.
```

### Supporting diagram

```yaml
resources:
  - type: diagram
    location: .engineering/resources/ADR-022/relation-index.svg
    role: explanation
    media_type: image/svg+xml
    normative: false
    description: Data-flow diagram for updates to the derived relation index.
```

### External reference

```yaml
resources:
  - type: reference
    location: https://www.rfc-editor.org/rfc/rfc9110
    role: reference
    media_type: text/html
    normative: false
    description: HTTP semantics referenced by this requirement.
```

### Canonically ordered Resources

```yaml
resources:
  - type: benchmark
    location: .engineering/resources/REQ-031/filter-benchmark.csv
    role: evidence
    media_type: text/csv
    normative: false
    description: Baseline filtering latency measurements for the reference dataset.
  - type: json-schema
    location: .engineering/resources/REQ-031/search-filter.schema.json
    role: contract
    media_type: application/json
    normative: true
    description: Canonical persisted representation of a search-filter expression.
```

### Invalid external normative Resource

```yaml
resources:
  - type: reference
    location: https://example.com/current-contract.yaml
    role: contract
    media_type: application/yaml
    normative: true
    description: Remote canonical contract.
```

Remote content cannot be normative EF truth.

### Invalid escaping path

```yaml
location: ../shared/schema.json
```

Local Resources cannot escape the EF project root.

### Invalid duplicate ownership

```text
REQ-031 owns .engineering/resources/REQ-031/api.yaml
REQ-044 owns .engineering/resources/REQ-031/api.yaml
```

One local path cannot have two owners. One Artifact owns the Resource and the
other references that Artifact.

## Validation

Resource validation checks each descriptor, local filesystem state, complete
project ownership, owner lifecycle, required normative syntax checks, and
available built-in optional specialized hooks.

`EF-RES-012` is emitted only as informational advisory output when an optional
specialized validator runs and reports malformed content. An unavailable
optional specialized validator may produce the [Validation and Integrity](09-validation.md) informational
diagnostic. Neither condition makes default or strict Core validation invalid
or incomplete. Separate extension validation uses its own result contract.

The Resource diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-RES-001` | error | Resource descriptor shape or required field is invalid |
| `EF-RES-002` | error | Resource type is unknown or custom type is not namespaced |
| `EF-RES-003` | error | Resource role is unknown |
| `EF-RES-004` | error | Location is empty, ambiguous, malformed, or uses an unsupported scheme |
| `EF-RES-005` | error | Media type is malformed or non-canonical |
| `EF-RES-006` | error | Local Resource file is missing or not a regular file |
| `EF-RES-007` | error | Local path escapes the project root or violates path normalization |
| `EF-RES-008` | error | Duplicate Resource location within one Artifact |
| `EF-RES-009` | error | Local Resource location has multiple owners |
| `EF-RES-010` | error | External Resource is marked normative |
| `EF-RES-011` | error | Resource role and normative value are incompatible |
| `EF-RES-012` | info | Optional Resource type-specific validation reported malformed content |
| `EF-RES-013` | error | Frozen Resource descriptor or local content was modified or removed |
| `EF-RES-015` | error | Unowned file exists inside an EF-managed Resource root |
| `EF-RES-016` | warning | Resource descriptors or fields are not canonically ordered |
| `EF-RES-017` | warning | External Resource uses insecure HTTP rather than HTTPS |
| `EF-RES-018` | warning | A listed canonical file suffix and declared media type are inconsistent |
| `EF-RES-019` | error | Unknown Resource field or invalid extension field |
| `EF-RES-020` | error | Required normative Resource syntax validation failed |

A standalone descriptor validator can check shape, vocabulary, ordering, URL
syntax, and media types. Missing files, path containment, exclusive ownership,
orphans, lifecycle mutation, and validation hooks require project or
previous-state context.

## Deferred

- Resource addition, modification, removal, verification evidence, and CHG
  effect recording are defined in [CHG Transaction Semantics](07-change-transactions.md).
- Resource requirements and allowed role conventions specific to each Artifact
  type are defined in [Artifact Body Schemas](08-artifact-schemas.md).
- Managed-root scanning, validation-hook execution, network-check separation,
  and strict diagnostic behavior are defined in [Validation and Integrity](09-validation.md).
- Resource lookup and context-selection output are defined in [Query and Trace](10-query-and-trace.md).
- EF project root discovery, managed Resource directories, symlink policy,
  Git-tracking requirements, temporary files, and migration are defined in
  [Filesystem and Configuration](11-filesystem-and-config.md).
- Content-addressed storage, cross-project Resource addresses, Resource-level
  identity, Resource relations, custom roles, and remote normative Resources
  are not part of EF Core v1.
