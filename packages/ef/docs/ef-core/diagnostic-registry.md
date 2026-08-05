# EF Core Diagnostic Registry

Status: Accepted

## Purpose

This companion registry is the central index of stable EF Core diagnostic
codes. The owning numbered specification remains normative for full
semantics and suppression rules. A compatible implementation MUST NOT
reassign a published code to a different condition.

Numeric values absent inside an existing namespace are reserved. Assigning
one requires updating this registry and the owning specification in the same
change. Deprecated codes remain listed permanently rather than being reused.

## Codes

| Code | Severity | Scope | Exit treatment | Owner | Condition |
|---|---|---|---|---|---|
| `EF-BODY-001` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Required core heading is missing |
| `EF-BODY-002` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Required core or Lifecycle heading is duplicated |
| `EF-BODY-003` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Required core headings are out of order |
| `EF-BODY-004` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Active or otherwise complete required section is empty |
| `EF-BODY-005` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Required list section contains no non-empty list item |
| `EF-BODY-006` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Artifact body contains an H1 heading |
| `EF-BODY-007` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Meaningful content appears before the first H2 |
| `EF-BODY-008` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Custom H2 appears before all required core sections |
| `EF-BODY-009` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Terminal knowledge Artifact lacks a meaningful Lifecycle section |
| `EF-BODY-010` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Non-terminal Artifact, PROJECT, or CHG contains a Lifecycle section |
| `EF-BODY-011` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Lifecycle is not the final H2 section |
| `EF-BODY-012` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Placeholder-only content is used as complete active content |
| `EF-BODY-014` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | CHG Verification result marker is invalid or missing |
| `EF-BODY-015` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Markdown cannot be parsed under the supported syntax |
| `EF-BODY-016` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Body schema does not match Artifact type |
| `EF-BODY-017` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | Active-origin terminal Artifact's complete core body was not preserved |
| `EF-BODY-018` | error | Markdown body and lifecycle completeness | defined by the owning command and validation-completeness contract | [08-artifact-schemas.md](08-artifact-schemas.md) | PROJECT Terminology table is missing, malformed, duplicated, or contains an invalid term |
| `EF-BODY-019` | warning | Markdown body and lifecycle completeness | fails only under strict or warnings-as-errors policy | [08-artifact-schemas.md](08-artifact-schemas.md) | PROJECT Terminology rows are not in canonical term order |
| `EF-CHG-002` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Completed CHG has no effect relations |
| `EF-CHG-003` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Effect does not match the before-and-after aggregate state |
| `EF-CHG-004` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | One CHG declares conflicting effects for one target |
| `EF-CHG-005` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Changed required target is not covered exactly once |
| `EF-CHG-006` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Unchanged target is incorrectly declared as an effect |
| `EF-CHG-007` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Multiple completing CHGs claim the same target |
| `EF-CHG-008` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Draft or retired CHG contains a factual effect relation |
| `EF-CHG-010` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | A structurally valid Verification result is incompatible with CHG lifecycle or completion |
| `EF-CHG-012` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | Resource mutation and owner effect are inconsistent |
| `EF-CHG-017` | error | Engineering transaction and effect integrity | defined by the owning command and validation-completeness contract | [07-change-transactions.md](07-change-transactions.md) | CHG declares an effect on itself or another CHG |
| `EF-ENV-001` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Missing or unterminated frontmatter |
| `EF-ENV-002` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Frontmatter is not exactly one top-level mapping |
| `EF-ENV-003` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Missing required core field |
| `EF-ENV-004` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Invalid field type or forbidden empty scalar |
| `EF-ENV-005` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Duplicate YAML mapping key |
| `EF-ENV-006` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Unknown non-extension field |
| `EF-ENV-007` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Invalid extension field name or value shape |
| `EF-ENV-008` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Unsupported schema identifier or major version |
| `EF-ENV-009` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Schema and type mismatch |
| `EF-ENV-010` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Forbidden YAML construct |
| `EF-ENV-011` | warning | YAML envelope representation | fails only under strict or warnings-as-errors policy | [01-artifact-envelope.md](01-artifact-envelope.md) | Non-canonical field or extension ordering |
| `EF-ENV-012` | error | YAML envelope representation | defined by the owning command and validation-completeness contract | [01-artifact-envelope.md](01-artifact-envelope.md) | Invalid or duplicate tag |
| `EF-ENV-013` | warning | YAML envelope representation | fails only under strict or warnings-as-errors policy | [01-artifact-envelope.md](01-artifact-envelope.md) | Non-canonical tag ordering |
| `EF-ID-001` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Missing or malformed Artifact ID |
| `EF-ID-002` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | ID prefix does not match Artifact type |
| `EF-ID-003` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Non-canonical or zero numeric component |
| `EF-ID-004` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Duplicate Artifact ID |
| `EF-ID-005` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Filename does not exactly match Artifact ID |
| `EF-ID-006` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | More than one PROJECT Artifact |
| `EF-ID-007` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Missing PROJECT Artifact in an initialized project |
| `EF-ID-008` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | PROJECT uses an ID other than `PROJECT` |
| `EF-ID-009` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Issued ID was transferred or reused |
| `EF-ID-010` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Issued Artifact ID was changed |
| `EF-ID-011` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Unsupported or customized core prefix |
| `EF-ID-012` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | Provisional branch collision blocks integration |
| `EF-ID-013` | error | Artifact identity and canonical path | defined by the owning command and validation-completeness contract | [02-identity.md](02-identity.md) | ID replacement did not update all structured references atomically |
| `EF-LIFE-001` | error | Lifecycle and whole-Artifact immutability | defined by the owning command and validation-completeness contract | [03-lifecycle.md](03-lifecycle.md) | Unknown lifecycle status |
| `EF-LIFE-002` | error | Lifecycle and whole-Artifact immutability | defined by the owning command and validation-completeness contract | [03-lifecycle.md](03-lifecycle.md) | Status is not allowed for the Artifact type |
| `EF-LIFE-003` | error | Lifecycle and whole-Artifact immutability | defined by the owning command and validation-completeness contract | [03-lifecycle.md](03-lifecycle.md) | Illegal lifecycle transition or prohibited first authoritative status |
| `EF-LIFE-004` | error | Lifecycle and whole-Artifact immutability | defined by the owning command and validation-completeness contract | [03-lifecycle.md](03-lifecycle.md) | Frozen terminal Artifact was modified |
| `EF-LIFE-009` | error | Lifecycle and whole-Artifact immutability | defined by the owning command and validation-completeness contract | [03-lifecycle.md](03-lifecycle.md) | Issued Artifact was physically deleted |
| `EF-QRY-001` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Query kind or required input is invalid |
| `EF-QRY-002` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Structured filter or pagination value is invalid |
| `EF-QRY-003` | info | Query invocation and completeness | unchanged | [10-query-and-trace.md](10-query-and-trace.md) | Exact lookup Artifact ID was not found |
| `EF-QRY-004` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Projection is unsupported |
| `EF-QRY-005` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Transitive trace relation type set is empty |
| `EF-QRY-006` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Direction or maximum depth is invalid |
| `EF-QRY-007` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Required Artifact graph is invalid |
| `EF-QRY-008` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Current resolution encountered an invalid graph |
| `EF-QRY-009` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Current resolution requested for unsupported Artifact type |
| `EF-QRY-010` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Requested history context is unavailable |
| `EF-QRY-011` | info | Query invocation and completeness | unchanged | [10-query-and-trace.md](10-query-and-trace.md) | Stale or corrupt cache was ignored successfully |
| `EF-QRY-012` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Query normalization or index version is unsupported |
| `EF-QRY-013` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Query cannot produce a complete trustworthy result |
| `EF-QRY-014` | error | Query invocation and completeness | defined by the owning command and validation-completeness contract | [10-query-and-trace.md](10-query-and-trace.md) | Required Artifact ID does not exist for this query kind |
| `EF-REL-001` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Unknown relation type or case variant |
| `EF-REL-002` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Relation entry is not a mapping or lacks a required field |
| `EF-REL-003` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Target Artifact does not exist |
| `EF-REL-004` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Source and target types are incompatible with relation type |
| `EF-REL-005` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Self-relation |
| `EF-REL-006` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Duplicate `(type, target)` relation |
| `EF-REL-007` | warning | Relation representation and graph integrity | fails only under strict or warnings-as-errors policy | [04-relations.md](04-relations.md) | Non-canonical relation or relation-field ordering |
| `EF-REL-008` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | `derived-from` cycle |
| `EF-REL-015` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | Unknown relation field or invalid extension field |
| `EF-REL-017` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | New `addresses` edge targets a non-active REQ |
| `EF-REL-018` | error | Relation representation and graph integrity | defined by the owning command and validation-completeness contract | [04-relations.md](04-relations.md) | New `governed-by` edge targets a non-active POL |
| `EF-RES-001` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Resource descriptor shape or required field is invalid |
| `EF-RES-002` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Resource type is unknown or custom type is not namespaced |
| `EF-RES-003` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Resource role is unknown |
| `EF-RES-004` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Location is empty, ambiguous, malformed, or uses an unsupported scheme |
| `EF-RES-005` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Media type is malformed or non-canonical |
| `EF-RES-006` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Local Resource file is missing or not a regular file |
| `EF-RES-007` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Local path escapes the project root or violates path normalization |
| `EF-RES-008` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Duplicate Resource location within one Artifact |
| `EF-RES-009` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Local Resource location has multiple owners |
| `EF-RES-010` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | External Resource is marked normative |
| `EF-RES-011` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Resource role and normative value are incompatible |
| `EF-RES-012` | info | Resource representation and ownership | unchanged | [06-resources.md](06-resources.md) | Optional Resource type-specific validation reported malformed content |
| `EF-RES-013` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Frozen Resource descriptor or local content was modified or removed |
| `EF-RES-015` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Unowned file exists inside an EF-managed Resource root |
| `EF-RES-016` | warning | Resource representation and ownership | fails only under strict or warnings-as-errors policy | [06-resources.md](06-resources.md) | Resource descriptors or fields are not canonically ordered |
| `EF-RES-017` | warning | Resource representation and ownership | fails only under strict or warnings-as-errors policy | [06-resources.md](06-resources.md) | External Resource uses insecure HTTP rather than HTTPS |
| `EF-RES-018` | warning | Resource representation and ownership | fails only under strict or warnings-as-errors policy | [06-resources.md](06-resources.md) | A listed canonical file suffix and declared media type are inconsistent |
| `EF-RES-019` | error | Resource representation and ownership | defined by the owning command and validation-completeness contract | [06-resources.md](06-resources.md) | Unknown Resource field or invalid extension field |
| `EF-SUP-001` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Superseded Artifact has no direct replacement |
| `EF-SUP-002` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Non-superseded Artifact declares `superseded-by` |
| `EF-SUP-003` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Source and replacement Artifact types differ |
| `EF-SUP-004` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Direct replacement was not active when transition completed |
| `EF-SUP-005` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Direct or indirect supersession cycle |
| `EF-SUP-007` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Frozen direct replacement set was modified |
| `EF-SUP-013` | error | Supersession topology and resolution | defined by the owning command and validation-completeness contract | [05-supersession.md](05-supersession.md) | Existing relation was implicitly retargeted during supersession |
| `EF-VAL-001` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | Requested validation scope or invocation is invalid |
| `EF-VAL-002` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | Trusted transition baseline is invalid |
| `EF-VAL-004` | info | Validation orchestration and execution | unchanged | [09-validation.md](09-validation.md) | Draft content is incomplete but lifecycle permits it |
| `EF-VAL-005` | info | Validation orchestration and execution | unchanged | [09-validation.md](09-validation.md) | Optional specialized validator is unavailable |
| `EF-VAL-006` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | Required Core validator capability is unavailable |
| `EF-VAL-007` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | Requested validation result is incomplete |
| `EF-VAL-008` | error | Validation orchestration and execution | 3 | [09-validation.md](09-validation.md) | Validator internal invariant failed |
| `EF-VAL-009` | error | Validation orchestration and execution | 1 | [09-validation.md](09-validation.md) | Bootstrap ref already contains an EF state |
| `EF-VAL-010` | error | Validation orchestration and execution | 1 | [09-validation.md](09-validation.md) | Proposed bootstrap contains a terminal knowledge Artifact or CHG |
| `EF-VAL-011` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | Proposed OID is missing or lexically invalid, does not resolve to a commit, cannot be materialized, or has inapplicable parentage |
| `EF-VAL-012` | error | Validation orchestration and execution | 2 | [09-validation.md](09-validation.md) | An incomplete working-tree initialization claim exists |

## Reserved numeric slots

- **EF-BODY:** `EF-BODY-013`
- **EF-CHG:** `EF-CHG-009`, `EF-CHG-011`, `EF-CHG-013`, `EF-CHG-014`, `EF-CHG-015`, `EF-CHG-016`
- **EF-ENV:** None
- **EF-ID:** None
- **EF-LIFE:** `EF-LIFE-005`, `EF-LIFE-006`, `EF-LIFE-007`, `EF-LIFE-008`
- **EF-QRY:** None
- **EF-REL:** `EF-REL-009`, `EF-REL-010`, `EF-REL-011`, `EF-REL-012`, `EF-REL-013`, `EF-REL-014`, `EF-REL-016`
- **EF-RES:** `EF-RES-014`
- **EF-SUP:** `EF-SUP-006`, `EF-SUP-008`, `EF-SUP-009`, `EF-SUP-010`, `EF-SUP-011`, `EF-SUP-012`
- **EF-VAL:** `EF-VAL-003`

## Maintenance rules

- Add a code first to its owning specification table, then regenerate this registry.
- Do not change severity or condition identity incompatibly within EF Core major 1.
- Message wording may improve; code, structured location, and ownership remain stable.
- A code removed from active use is marked deprecated here and is never reassigned.
