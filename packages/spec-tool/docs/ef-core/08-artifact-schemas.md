# EF Core: Artifact Body Schemas

Status: Accepted

## Scope

This document defines the EF Core v1 Markdown body schemas for PROJECT, PRD,
REQ, ADR, POL, and CHG. It defines required sections, section ordering, draft
completeness, terminal lifecycle notes, custom sections, semantic boundaries,
relation and Resource compatibility, and body validation.

The body schemas add no Artifact-specific top-level frontmatter fields. Every
Artifact continues to use the common envelope defined by the Artifact Envelope
specification.

## Definitions

### Artifact body

The Artifact body is the GitHub Flavored Markdown content after YAML
frontmatter. It stores the Artifact's human-readable engineering meaning.

The body complements structured frontmatter. It does not redefine identity,
lifecycle, relations, Resources, or CHG effects.

### Core section

A core section is a level-two heading and its content whose exact heading name,
presence, relative order, and completeness are governed by an Artifact type's
body schema.

### Custom section

A custom section is an additional level-two section after all core sections. It
has natural Markdown semantics unless a namespaced extension or plugin defines
additional validation.

### Meaningful content

Meaningful section content contains at least one non-empty Markdown AST node
other than whitespace or an HTML comment. Placeholder-only content does not
satisfy active-section completeness.

### Lifecycle section

`## Lifecycle` is the final human-readable explanation appended when a PRD,
REQ, ADR, or POL becomes `superseded` or `retired`. Structured lifecycle status,
replacement relations, and CHG provenance remain authoritative.

## Common Schema Rules

### Heading level and title

Artifact bodies MUST NOT contain an H1 heading. The frontmatter `title` is the
Artifact title and renderers MAY generate an H1 from it.

Core and custom top-level body sections use H2 headings. H3 and deeper headings
MAY organize content inside an H2 section.

Except for whitespace and HTML comments, content MUST NOT appear before the
first H2 section.

### Exact headings and order

Required core heading names are case-sensitive and have no aliases. Each
required heading MUST appear exactly once and in the order defined by its body
schema.

Custom H2 sections MAY follow all required core sections. For a knowledge
Artifact with a terminal Lifecycle section, custom sections appear before
`## Lifecycle`, which is always the final H2.

Custom headings MUST NOT duplicate a required core heading or `Lifecycle`.

### Natural Markdown

Section content MAY use prose, lists, task lists, tables, links, code fences,
raw HTML, and H3 or deeper subsections supported by GitHub Flavored Markdown.

The body is not a YAML DSL. Unless this specification explicitly identifies a
minimal marker or list requirement, Core validation does not parse prose into
additional structured engineering fields.

### Structured-data boundary

A body mention does not create structured metadata:

- writing an Artifact ID does not create a relation;
- writing a path or URL does not create a Resource descriptor;
- saying an Artifact is active does not change `status`;
- describing a replacement does not create `superseded-by`; and
- describing a CHG effect does not create an effect relation.

The corresponding frontmatter structures MUST be written explicitly when those
machine semantics apply.

### Completeness by lifecycle

Body completeness is lifecycle-sensitive:

| Artifact state | Core body requirement |
|---|---|
| PROJECT `active` | Every required section is present and meaningful. |
| PRD, REQ, ADR, POL `draft` | Every required heading is present; content MAY be incomplete or empty. |
| PRD, REQ, ADR, POL `active` | Every required section is present and meaningful. |
| PRD, REQ, ADR, POL `superseded` | Complete active body is preserved; meaningful Lifecycle section is appended. |
| PRD, REQ, ADR, POL `retired` from active | Complete active body is preserved; meaningful Lifecycle section is appended. |
| PRD, REQ, ADR, POL `retired` from draft | Required headings remain; incomplete core content MAY remain; meaningful Lifecycle section is appended. |
| CHG `draft` | MAY be incomplete according to CHG rules. |
| CHG `completed` or `retired` | Must satisfy the final CHG body schema. |

Determining whether a retired Artifact was previously active requires trusted
history or previous-state context. A standalone current-file validator requires
its core headings and Lifecycle section but cannot infer that earlier state.

### Placeholder content

A draft MAY contain authoring placeholders. An active Artifact section whose
only meaningful content is a placeholder is invalid.

At minimum, a section consisting only of a case-insensitive form of `TODO`,
`TBD`, or `Lorem ipsum`, optionally surrounded by punctuation or Markdown
emphasis, is placeholder-only. Occurrences inside code examples or otherwise
substantive content do not invalidate the section automatically.

### Required list content

Where a schema requires list content, the section MUST contain at least one
non-empty Markdown list item. Nested prose MAY supplement the list.

Core does not assign stable identity to list items in EF Core v1.

## PROJECT

### Purpose

PROJECT answers what the project is, defines its canonical domain terminology,
and provides the stable entry context for the engineering knowledge graph.

PROJECT uses the common envelope with:

```text
schema: ef/project@1
type: project
id: PROJECT
status: active
```

It adds no type-specific frontmatter fields.

### Required sections

PROJECT requires, in order:

```text
## Vision
## Scope
## Non-goals
## Context
## Terminology
```

#### `Vision`

`Vision` states why the project exists and the durable outcome it aims to
create. It does not contain a short-term roadmap or delivery schedule.

#### `Scope`

`Scope` defines the systems, domains, repositories, responsibilities, and
external boundaries included in the project.

#### `Non-goals`

`Non-goals` explicitly excludes nearby concerns that the project does not own.
An active PROJECT MUST contain a meaningful statement. When no additional
non-goal is known, an explicit statement such as "No additional non-goals are
currently defined" is valid.

#### `Context`

`Context` stores long-lived background such as repository and system context,
external boundaries, and stable engineering principles. H3 subsections such as
`System Boundaries` and `Engineering Principles` MAY organize it.

#### `Terminology`

`Terminology` is the canonical project glossary used to keep domain language
consistent across Artifacts, Resources, implementation discussions, and Agent
context. It distinguishes the preferred project term from nearby, historical,
or ambiguous wording.

The section MUST contain exactly one GitHub Flavored Markdown table, and that
table MUST be its first meaningful node. It uses these case-sensitive columns
in this order:

```text
Term | Definition | Avoid or aliases
```

The table MAY contain zero data rows. A header-only table explicitly means that
the project has not yet established any canonical domain terms; it is valid
complete content rather than an empty section or placeholder. In each data row:

- `Term` is non-empty plain text containing the canonical spelling, including
  intended case;
- `Definition` is a non-empty, self-contained project-domain definition; and
- `Avoid or aliases` MAY be empty and identifies wording readers may encounter
  but SHOULD NOT use as the canonical term.

Canonical `Term` cells MUST use Unicode NFC, MUST be unique after trimming
surrounding whitespace, and MUST be sorted by the trimmed plain-text UTF-8 byte
sequence. Term identity does not extend beyond this PROJECT table: terms receive
no Artifact ID, lifecycle, Resource ownership, or relation edges. Additional
non-table explanatory Markdown MAY follow the glossary table, but it does not
create more entries.

Example:

```markdown
| Term | Definition | Avoid or aliases |
|---|---|---|
| Artifact | A formal EF document with stable project-scoped identity. | record, entity |
| Workspace | The project repository together with its declared linked-repository slots. | project group |
```

Valid initial empty glossary:

```markdown
| Term | Definition | Avoid or aliases |
|---|---|---|
```

Core validation proves the table structure, required cells, exact duplicate
absence, and canonical order. It does not prove that a definition is adequate
or that every use of language elsewhere follows the glossary. Such consistency
review is human, Agent, policy, or optional authoring-lint work.

### Lifecycle, relations, and Resources

PROJECT is created active and has no Lifecycle section. Its outgoing relation
type is limited to `references` by the relations ontology. It MAY own any valid
Resource whose role accurately describes its use.

## PRD

### Purpose

PRD stores product intent and explains why a product capability is needed. It
does not define the complete observable system contract or an implementation
solution.

PRD uses the common envelope with schema `ef/prd@1` and type `prd`. It adds no
type-specific frontmatter fields.

### Required sections

PRD requires, in order:

```text
## Problem
## User Need
## Desired Outcome
## Success Criteria
## Non-goals
```

#### `Problem`

`Problem` describes the current condition, pain, risk, or opportunity without
prematurely fixing an engineering solution.

#### `User Need`

`User Need` identifies affected users or actors and what they need to achieve or
improve. EF Core does not require a persona or user-story DSL.

#### `Desired Outcome`

`Desired Outcome` defines the intended product-level result rather than an
implementation task list.

#### `Success Criteria`

`Success Criteria` MUST contain at least one non-empty Markdown list item. Its
criteria describe observable product outcomes. Observable system contracts
derived from them belong in REQ.

#### `Non-goals`

`Non-goals` explicitly states product scope excluded from this PRD. It MUST be
meaningful when the PRD is active.

### Lifecycle, relations, and Resources

PRD may use `derived-from` with PRD, `governed-by` with POL,
`superseded-by` with PRD, and `references` according to the relation ontology.
No parent or derivation relation is universally required.

Research, prototypes, screenshots, evidence, and references MAY be Resources.
Machine-observable contracts are canonicalized as REQ rather than being hidden
only in PRD prose.

## REQ

### Purpose

REQ stores one long-lived observable system contract. It describes what the
system must do, not an implementation task or project-management work item.

REQ uses the common envelope with schema `ef/requirement@1` and type
`requirement`. It adds no type-specific frontmatter fields.

### Required sections

REQ requires, in order:

```text
## Requirement
## Rationale
## Acceptance Criteria
```

#### `Requirement`

`Requirement` states the normative observable behavior, constraint, or contract.
It SHOULD avoid fixing a particular implementation when multiple valid
solutions could satisfy the behavior.

#### `Rationale`

`Rationale` explains why the requirement exists, including relevant risk,
constraint, or product background.

#### `Acceptance Criteria`

`Acceptance Criteria` MUST contain at least one non-empty Markdown list item.
Each criterion SHOULD be decidable through observation or evidence.

Core validation checks list structure but does not claim to prove that natural
language is complete, unambiguous, or executable as a test.

### Optional subject matter

Constraints, verification notes, security considerations, API examples, error
semantics, compatibility details, and other domain-specific material MAY use
custom sections after the required core sections.

Separate required `Constraints` and `Verification` sections are intentionally
not part of the minimal schema. Local constraints can be normative Requirement
content, while Acceptance Criteria express verification expectations.

### Lifecycle, relations, and Resources

REQ may use `derived-from` with PRD or REQ, `governed-by` with POL,
`superseded-by` with REQ, and `references` according to the relation ontology.
No PRD relation is universally required because requirements can originate from
regulation, incidents, existing behavior, or other sources.

Machine-readable contracts, examples, and evidence MAY be Resources.
Significant implementation choices belong in ADR.

## ADR

### Purpose

ADR stores a significant chosen engineering decision, its decision space,
rationale, alternatives, consequences, and trade-offs.

ADR uses the common envelope with schema `ef/decision@1` and type `decision`.
It adds no type-specific frontmatter fields. An active ADR is an accepted,
currently applicable decision.

### Required sections

ADR requires, in order:

```text
## Context
## Decision
## Alternatives
## Consequences
```

#### `Context`

`Context` describes the problem, constraints, and meaningful solution space
that made a decision necessary.

#### `Decision`

`Decision` clearly states the chosen solution and its rationale. In an active
ADR it MUST describe a decision rather than an unresolved proposal.

#### `Alternatives`

`Alternatives` meaningfully describes at least one rejected or non-selected
approach. It MAY use prose, lists, tables, or H3 subsections; no fixed
alternative DSL is required.

An item with no meaningful alternatives or trade-offs may not warrant ADR
semantics and can be represented in another appropriate Artifact or body.

#### `Consequences`

`Consequences` describes positive and negative outcomes, trade-offs, risks, and
follow-up implications. EF Core does not require a fixed pros-and-cons table.

### Lifecycle, relations, and Resources

ADR may use `addresses` with REQ, `governed-by` with POL,
`superseded-by` with ADR, and `references` according to the relation ontology.
Not every ADR is required to address a REQ because some decisions are
project-level.

Benchmarks, diagrams, prototypes, evidence, and references MAY be Resources.
Observable behavior established by a decision must also be represented in REQ
when it is part of the system contract.

## POL

### Purpose

POL stores a cross-cutting engineering rule that applies across requirements,
modules, roles, or changes. A rule local to one observable contract generally
belongs in REQ.

POL uses the common envelope with schema `ef/policy@1` and type `policy`. It
adds no type-specific frontmatter fields.

### Required sections

POL requires, in order:

```text
## Policy
## Scope
## Rationale
## Compliance
```

#### `Policy`

`Policy` states the normative cross-cutting rule.

#### `Scope`

`Scope` defines where the policy applies and any explicit boundary where it does
not apply.

#### `Rationale`

`Rationale` explains the policy purpose, risks, and relevant origin.

#### `Compliance`

`Compliance` MUST contain at least one non-empty Markdown list item describing
how conformity is determined. Checks MAY be automatic, manual, or both.

### Lifecycle, relations, and Resources

POL may use `derived-from` with REQ or POL, `superseded-by` with POL, and
`references` according to the relation ontology.

External standards are non-normative external Resources. Any external rule that
must become authoritative EF truth is restated in the POL body or captured in a
local normative Resource.

## CHG

### Purpose

CHG stores the provenance and verification attestation of an engineering state
transition. It records effects but does not itself become current truth.

CHG uses the common envelope with schema `ef/change@1` and type `change`. It
adds no type-specific top-level frontmatter fields.

### Final body sections

A completed or retired CHG requires, in order:

```text
## Rationale
## Sources
## Changes
## Verification
```

The structural and result-marker semantics are defined by the CHG Transaction
Semantics specification:

- completed Sources and Changes each contain at least one list item;
- completed Verification begins with `Result: passed` or
  `Result: not-applicable`;
- retired Verification begins with `Result: not-completed`;
- completed effect relations are factual and match repository state; and
- retired CHG contains no factual effect relations.

A draft CHG MAY omit or leave final sections incomplete. If draft Verification
is present, it MAY use `Result: pending`.

### Lifecycle, relations, and Resources

CHG may use `governed-by`, `references`, `introduces`, `modifies`, and `retires`
according to the relation and transaction specifications.

CHG MAY own references and captured verification evidence as Resources. CHG
does not use the common terminal `Lifecycle` section because its final Rationale,
Changes, and Verification sections already explain completion or retirement.

## Terminal Lifecycle Section

### Applicability

PRD, REQ, ADR, and POL with status `superseded` or `retired` MUST contain a final
`## Lifecycle` section.

PROJECT and CHG MUST NOT use this section. Draft and active knowledge Artifacts
MUST NOT use it because they have not reached a terminal lifecycle state.

### Content

The Lifecycle section MUST be meaningful and explain why the Artifact became
non-current. It SHOULD name the responsible CHG when one exists and MAY mention
replacement IDs for human readability.

Structured `status`, `superseded-by` relations, and CHG effect relations remain
the sole machine-readable lifecycle truth. A validator does not derive graph
edges from Lifecycle prose.

### Superseded example

```markdown
## Lifecycle

Superseded by REQ-070 through CHG-182 after the filtering contracts were
consolidated.
```

### Retired example

```markdown
## Lifecycle

Retired through CHG-190 because the upstream capability no longer exists and no
replacement requirement is needed.
```

### Retired-draft example

```markdown
## Lifecycle

Retired before activation because the product direction changed.
```

The Lifecycle section is appended by the terminal transition and becomes frozen
with the Artifact.

## Custom Sections

Custom H2 sections allow domain-specific engineering content without expanding
the core body schema. Examples include:

```text
## Constraints
## API Examples
## Security Considerations
## Rollout Notes
## Open Questions
```

Rules:

- Custom sections follow every required core section.
- Custom sections precede a terminal Lifecycle section.
- A custom heading cannot duplicate a core or Lifecycle heading.
- Core assigns no implicit machine semantics to a custom section.
- A plugin MAY validate a custom section under a declared extension contract,
  but those findings are outside the Core validation result and cannot change
  Core validity, completeness, or strict-mode outcome.

## Semantic Boundaries

Canonicalization follows these boundaries:

| Engineering information | Canonical body destination |
|---|---|
| Project purpose, context, boundaries, and canonical terminology | PROJECT |
| User or business problem and desired outcome | PRD |
| Observable system contract | REQ |
| Chosen solution and trade-offs | ADR |
| Cross-cutting engineering rule | POL |
| Engineering state-transition provenance | CHG |
| Machine-readable contract, evidence, or representation | Resource |

Core deterministic validation checks structure and graph facts. It cannot prove
automatically that natural language has the correct taxonomy, is complete, or
contains an adequate engineering argument.

Authoring lint MAY warn about likely semantic misuse. Human or Agent review is
responsible for final semantic adequacy.

## Relation and Resource Compatibility

Body schemas do not introduce relation types beyond the relation ontology:

| Artifact | Outgoing relation types |
|---|---|
| PROJECT | `references` |
| PRD | `derived-from`, `governed-by`, `superseded-by`, `references` |
| REQ | `derived-from`, `governed-by`, `superseded-by`, `references` |
| ADR | `addresses`, `governed-by`, `superseded-by`, `references` |
| POL | `derived-from`, `superseded-by`, `references` |
| CHG | `governed-by`, `references`, `introduces`, `modifies`, `retires` |

Source and target compatibility remains governed by the relation specification.
Body schema alone adds no universal required relation.

Every Artifact type MAY own any Resource whose type, role, normative value,
description, location, and ownership accurately follow the Resource Schema.
Artifact-specific body sections do not create implicit Resource descriptors.

## Examples

### Minimal active REQ body

```markdown
## Requirement

The system must return a stable error code when a search filter is invalid.

## Rationale

Stable error codes allow clients to handle invalid input without parsing
human-readable error messages.

## Acceptance Criteria

- An unsupported filter returns `invalid_filter`.
- The response status is `400`.
- The response does not expose an internal stack trace.
```

### Valid draft REQ skeleton

```markdown
## Requirement

## Rationale

## Acceptance Criteria
```

The headings are valid for draft authoring, but the Artifact cannot become
active until every required section is meaningful and Acceptance Criteria has a
non-empty list item.

### Invalid active placeholder

```markdown
## Requirement

TODO

## Rationale

TBD

## Acceptance Criteria

- Lorem ipsum.
```

Placeholder-only content does not satisfy active completeness.

### Valid custom section placement

````markdown
## Requirement

The system must reject unsupported filters.

## Rationale

Clients require deterministic input validation.

## Acceptance Criteria

- An unsupported filter returns `invalid_filter`.

## API Examples

```json
{"error": "invalid_filter"}
```
````

### Invalid custom section placement

```markdown
## Requirement

The system must reject unsupported filters.

## API Examples

Example content appears before all required core sections.

## Rationale

Clients require deterministic validation.

## Acceptance Criteria

- An unsupported filter returns `invalid_filter`.
```

## Validation

Body validation parses GitHub Flavored Markdown into an AST. Headings inside
code fences, HTML blocks, or inline code are not body-section headings.

The body diagnostic codes are:

| Code | Severity | Condition |
|---|---|---|
| `EF-BODY-001` | error | Required core heading is missing |
| `EF-BODY-002` | error | Required core or Lifecycle heading is duplicated |
| `EF-BODY-003` | error | Required core headings are out of order |
| `EF-BODY-004` | error | Active or otherwise complete required section is empty |
| `EF-BODY-005` | error | Required list section contains no non-empty list item |
| `EF-BODY-006` | error | Artifact body contains an H1 heading |
| `EF-BODY-007` | error | Meaningful content appears before the first H2 |
| `EF-BODY-008` | error | Custom H2 appears before all required core sections |
| `EF-BODY-009` | error | Terminal knowledge Artifact lacks a meaningful Lifecycle section |
| `EF-BODY-010` | error | Non-terminal Artifact, PROJECT, or CHG contains a Lifecycle section |
| `EF-BODY-011` | error | Lifecycle is not the final H2 section |
| `EF-BODY-012` | error | Placeholder-only content is used as complete active content |
| `EF-BODY-014` | error | CHG Verification result marker is invalid or missing |
| `EF-BODY-015` | error | Markdown cannot be parsed under the supported syntax |
| `EF-BODY-016` | error | Body schema does not match Artifact type |
| `EF-BODY-017` | error | Active-origin terminal Artifact's complete core body was not preserved |
| `EF-BODY-018` | error | PROJECT Terminology table is missing, malformed, duplicated, or contains an invalid term |
| `EF-BODY-019` | warning | PROJECT Terminology rows are not in canonical term order |

A standalone validator can check Markdown parsing, headings, ordering, list
structure, current completeness, Lifecycle presence, placeholders, and CHG
markers. Determining whether a retired Artifact originated from active state and
whether its complete body was preserved requires previous-state or repository
history context.

Semantic-category lint is advisory and MUST NOT be presented as deterministic
proof that natural-language engineering meaning is correct or incorrect.

## Deferred

- Full-project validation phases, previous-state discovery, warning policy,
  strict mode, parser-version support, and exit behavior are defined in [Validation and Integrity](09-validation.md).
- Stable body query output, section extraction, context composition, and
  full-text search are defined in [Query and Trace](10-query-and-trace.md).
- Templates, managed paths, encoding details, line endings, and generated
  rendering are defined in [Filesystem and Configuration](11-filesystem-and-config.md).
- Temporary input normalization and promotion into canonical Artifact sections
  are defined in [Input Normalization and Promotion](12-input-normalization.md). EF Core does not
  define persistent raw-input staging bodies.
- Plugin-defined body sections, custom Artifact types, stable acceptance-item
  identity, stable terminology-entry identity, machine enforcement of glossary
  usage, and machine parsing of unrestricted prose are not part of EF Core v1.
