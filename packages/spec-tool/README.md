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
`features`, `requirements`, `decisions`, `policies`, and `changes`.

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
```

`spec init` creates all canonical directories, the exact config, and a valid
active PROJECT Artifact. `spec validate` checks the current `.spec/` workspace
for layout, config, UUIDv7 identity, uniqueness, schema/kind and kind/status
compatibility, canonical placement, required active/completed body sections,
and relation/resource descriptor structure. It does not judge natural-language
semantic quality.

The initial implementation intentionally stops at this core slice. Artifact
CRUD, query, lifecycle mutation, relation mutation, and Resource mutation
commands are subsequent MVP slices.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/LICENSE)
License © 2023-PRESENT [DevilTea](https://github.com/DevilTea).
