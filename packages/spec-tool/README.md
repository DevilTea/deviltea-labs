# @deviltea/spec-tool

> ESM-only Node.js CLI.

Spec is a Git-native engineering specification maintenance tool. The
Spec-native MVP stores one workspace under `.spec/`; it does not read, migrate,
or provide compatibility mode for `.engineering/` EF workspaces. Existing EF
workspaces remain the responsibility of `@deviltea/ef`.

The product-design authority is [GitHub Discussion #65 — `spec-tool: canonical design discussion`](https://github.com/DevilTea/deviltea-labs/discussions/65).
The retained `docs/ef-core/` tree is implementation history only.

## Storage

`.spec/config.yaml` has exactly this shape:

```yaml
schema: spec/config@1
```

Artifact files use the canonical path `.spec/<plural-kind>/<uuid>.md`. The
supported directories are `projects`, `prds`, `stories`, `use-cases`,
`features`, `requirements`, `decisions`, `policies`, and `changes`; local
Artifact-owned Resources live under `.spec/resources/<owner-uuid>/...`.

Every Artifact, including the single `kind: project` Artifact, has an opaque
UUIDv7 identity. Its frontmatter envelope contains exactly:

```yaml
schema: ...
kind: ...
id: ...
title: ...
status: ...
relations: []
resources: []
```

`relations` contain source-owned `{type, target}` entries. `resources` contain
Artifact-owned `{location, role, mediaType, description}` descriptors.

## CLI

Requires Node.js `^22.14.0 || ^24.0.0`.

```bash
npm install -g @deviltea/spec-tool
spec init
spec validate
spec version

spec artifact create --kind story --title "A story"
spec artifact get <uuid>
spec artifact update <uuid> --body-file story.md
spec artifact delete <uuid>
spec artifact list --kind story --status draft

spec relation add <source-uuid> <target-uuid> --type refines
spec relation remove <source-uuid> <target-uuid> --type refines
spec relation list --artifact <uuid> --direction all

spec lifecycle activate <uuid>
spec lifecycle complete <change-uuid>
spec lifecycle retire <uuid>
spec lifecycle supersede <replacement-uuid> <replaced-uuid>

spec resource add <artifact-uuid> \
  --location .spec/resources/<artifact-uuid>/contract.json \
  --role contract --media-type application/json
spec resource remove <artifact-uuid> <location>
spec resource list --artifact <artifact-uuid>
spec resource read <artifact-uuid> <location>

spec search <text> --kind story --status active
spec trace <artifact-uuid> --direction both
```

`spec init` creates all canonical directories, the exact config, and a valid
active PROJECT Artifact. `spec validate` checks the current `.spec/` workspace
for layout, config, UUIDv7 identity, uniqueness, schema/kind and kind/status
compatibility, canonical placement, required active/completed body sections,
relation graph invariants, and Resource descriptor/filesystem integrity. It does
not judge natural-language semantic quality or Git history.

`spec search` performs deterministic case-insensitive substring matching over
Artifact titles and bodies; it does not rank results. `spec trace` follows only
the canonical `refines` graph: `up` follows stored outgoing edges toward Story,
`down` follows derived incoming edges toward Requirement, and `both` returns the
complete connected refinement closure.

Artifact, relation, lifecycle, Resource, search, trace, and validation commands
return deterministic human output by default. Add `--format json` for the stable
machine-readable result envelope. CHG completion is explicit via
`spec lifecycle complete`; chained supersession transfers current replacement
targets to the new active replacement. Terminal Artifacts are immutable, only
draft Artifacts may be physically deleted, and `resource read` only reads local
files; it never fetches `https://` locations.

## Agent Skills

The published package includes two Spec-native Agent Skills:

- `maintain-spec-workspace` — invariant-aware Artifact, lifecycle, relation,
  Resource, search/trace, and validation operations.
- `review-spec-workspace` — read-only validation and deterministic inspection of
  the current `.spec/` workspace.

The inherited EF skill names and EF workflow guidance are not part of the Spec
package surface. Historical `docs/ef-core/` material remains repository-only and
is not shipped in the npm package.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/LICENSE)
License © 2023-PRESENT [DevilTea](https://github.com/DevilTea).
