# Frozen-v1 CLI and TypeScript API

[Design authority: Discussion #65, Thread 4](https://github.com/DevilTea/deviltea-labs/discussions/65). The `spec` executable and the `@deviltea/spec-tool` TypeScript package adapt the **same semantic core**. This document describes the implemented v1 API, not an alternative design.

## Invocation, roots and output

```sh
spec --help
spec workspace init --root /path/to/repository
spec workspace validate --root /path/to/repository
spec graph export --root /path/to/repository
```

An explicit `--root` overrides repository auto-discovery. Otherwise Spec Tool uses `git rev-parse --show-toplevel` from the current directory, and rejects requests outside a Git working tree. All operations accept `--format json|human`; **JSON is the default**. Resource and operation names may precede or follow options.

Structured requests are **one JSON object on stdin**. Read-only no-argument operations (`workspace init`, `workspace validate`, `graph export`) accept an absent/empty JSON object, not arbitrary keys.

Successful operations write exactly one JSON result to **stdout**, exit 0, and leave stderr empty. Failure writes a JSON error to **stderr**, uses nonzero exit status, and leaves stdout empty. Failed workspace validation returns `{ "valid": false, "issues": [...] }` on stderr rather than a generic error envelope. Human rendering requires `--format human`.

Use `printf '%s\n' '...' | spec <resource> <operation> --root .`, or supply stdin through a subprocess. Each mutating request must carry an exact current `expectedRevision` (lowercase SHA-256 digest). Refresh after each semantic change. Do not treat `revision_conflict` as permission to blindly retry a stale request.

## Read operations

| CLI | TypeScript | JSON stdin |
| --- | --- | --- |
| `workspace init` | `client.workspace.init()` | `{}` |
| `workspace validate` | `client.workspace.validate()` | `{}` |
| `graph export` | `client.graph.export()` | `{}` |
| `graph get` | `client.graph.get(request)` | `{ "id": "<uuid>" }` |
| `graph list` | `client.graph.list(request?)` | `{ "kind"?: "<kind>" }` |
| `graph incoming` | `client.graph.incoming(request)` | `{ "id": "<uuid>", "type"?: "<relation>" }` |
| `graph outgoing` | `client.graph.outgoing(request)` | Same as incoming |
| `graph set-relation-targets` | `client.graph.setRelationTargets(request)` | See below |

Read/query results use `{ "revision": "...", "data": ... }`. `graph export` returns the full canonical normalized IR; `graph get` returns one full semantic node; `graph list` returns lightweight ID/kind/optional-title summaries. Incoming/outgoing return edge records only.

The six lowercase kinds are `story`, `feature`, `rule`, `scenario`, `contract`, `clause`. Relation types are `motivates`, `demonstrates` and `constrains`.

## Mutations

| Resource | Operations | Request shape |
| --- | --- | --- |
| Story | create | `{title, actor, goal, value, motivates: UUID[], expectedRevision}` |
| Story | update | `{id, changes: {title?, actor?, goal?, value?}, expectedRevision}` |
| Feature | create | `{title, summary, expectedRevision}` |
| Feature | update | `{id, changes: {title?, summary?}, expectedRevision}` |
| Rule | create | `{ownerId, statement, expectedRevision}` |
| Rule | update | `{id, changes: {statement?}, expectedRevision}` |
| Scenario | create | `{title, steps: Step[], demonstrates: UUID[], expectedRevision}` |
| Scenario | update | `{id, changes: {title?, steps?}, expectedRevision}` |
| Contract | create | `{title, summary, constrains: UUID[], expectedRevision}` |
| Contract | update | `{id, changes: {title?, summary?}, expectedRevision}` |
| Clause | create | `{ownerId, statement, constrains?: UUID[], expectedRevision}` |
| Clause | update | `{id, changes: {statement?}, expectedRevision}` |

Each of the six resources also has `delete` with `{id,expectedRevision}`. Deletes refuse inbound references; Features/Contracts with children also refuse ordinary delete.

`Step` is `{"type":"given"|"when"|"then","text":"nonempty single-line text"}`. Supply the **full sequence** for Scenario updates. It must have ordered `Given* → When+ → Then+` effective phases. The parser accepts `And`/`But` in persisted Gherkin and normalizes them to effective types.

### Relation mutation

```json
{
  "sourceId": "<story-or-scenario-or-contract-or-clause-uuid>",
  "type": "constrains",
  "targets": ["<feature-or-rule-uuid>"],
  "expectedRevision": "<current-sha256>"
}
```

The constraints are:

- `motivates`: Story → Feature, at least one.
- `demonstrates`: Scenario → Rule/Clause/Feature/Contract, at least one. This is **not** test status.
- `constrains`: Contract → Feature, at least one. Clause → Feature/Rule via optional own **nonempty complete override**, or inherit the owner's Contract scope.

Clause `constrains` accepts `"targets": null` to **remove** its override and restore inheritance. Contract `constrains` never permits null or an empty array. Explicit nonempty override does not union with the parent scope. Stored target UUIDs are sorted canonically.

### Ownership, conversion and explicit deletion

| CLI | TypeScript | Request |
| --- | --- | --- |
| `rule reorder` | `client.rule.reorder(...)` | `{ownerId,orderedIds,expectedRevision}` |
| `clause reorder` | `client.clause.reorder(...)` | Same |
| `rule reparent` | `client.rule.reparent(...)` | `{id,newOwnerId,expectedRevision}` |
| `clause reparent` | `client.clause.reparent(...)` | Same |
| `rule promote` | `client.rule.promote(...)` | `{id,newOwnerId,relations:{constrains:null\|UUID[]},expectedRevision}` |
| `clause demote` | `client.clause.demote(...)` | `{id,newOwnerId,relations:{},expectedRevision}` |
| `feature delete-with-children` | `client.feature.deleteWithChildren(...)` | `{ownerId,childIds,expectedRevision}` |
| `contract delete-with-children` | `client.contract.deleteWithChildren(...)` | Same |

Reorder requires the **complete** set of owned Rule/Clause IDs. Reparent preserves UUID and appends to a new same-kind owner. Promote/demote preserve UUID while changing kind and authority; their `relations` objects **explicitly** define final-state relations. Illegal references block conversion rather than being silently removed. Compound deletion requires the **exact** current child set and checks inbound references for owner and every child.

All successful mutations return exactly `{revision,changedNodes,deletedIds,changedEdges:{added,removed}}`; node/edge deltas reflect the **normalized final graph**, including inherited Clause edges. Presentation-only reorder yields unchanged revision and empty change sets.

## TypeScript and errors

```ts
import { createSpecClient, SpecError } from '@deviltea/spec-tool'
import type {
  ContractCreateRequest,
  MutationResponse,
  NormalizedIr,
  ValidationResult,
} from '@deviltea/spec-tool'

const client = createSpecClient('/path/to/repository')
const snapshot = await client.graph.export()
const request: ContractCreateRequest = {
  title: 'Network protocol',
  summary: 'Shared external contract',
  constrains: ['<existing-feature-uuid>'],
  expectedRevision: snapshot.revision,
}
const changed: MutationResponse = await client.contract.create(request)
const current: NormalizedIr = (await client.graph.export()).data
const validation: ValidationResult = await client.workspace.validate()
```

Runtime exports: `createSpecClient`, `SpecClient`, `SpecError`. Request/response/error/IR types are type-only exports from the package root.

Errors have `{code,message,details}`. Stable codes: `revision_conflict`, `not_found`, `validation_failed`, `relation_invalid`, `referenced_unit` and `invalid_request`. Invalid requests expose `details.issues[]`; referenced deletion exposes `details.targetId` and `details.inboundEdges`; relation errors expose `details.reason`, `sourceId`, `relationType` and `targetIds`.

The semantic API deliberately does **not** perform arbitrary raw-file CRUD, notes editing, migration, repair of invalid state, Gherkin repacking, test execution, code generation or implementation management.
