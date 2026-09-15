# @deviltea/spec-tool

> ESM-only Node.js CLI.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]

Spec is a Git-native engineering specification maintenance and collaboration
tool. The current package is still an inherited EF implementation and therefore
still uses `.engineering/` and parts of the EF Core ontology at runtime while
the Spec-native MVP is being implemented. Shipped behavior is not itself the
product-design authority.

## Design Authority

The highest-authority design record for Spec / `@deviltea/spec-tool` / `spec` is
[GitHub Discussion #65 — `spec-tool: canonical design discussion`](https://github.com/DevilTea/deviltea-labs/discussions/65).

When sources disagree, use this precedence:

1. Current accepted direction in Discussion #65.
2. Shipped code and tests, as evidence of current implementation behavior only.
3. `docs/ef-core/`, retained as inherited EF implementation/history reference.
4. Historical issues and archived design material, including #63 and #11.

Standalone planning documents are intentionally not maintained in this package.
New exploration, alternatives, and accepted design decisions belong in
Discussion #65. See [`docs/README.md`](docs/README.md) for the repository-level
authority note.

## Installation

Requires Node.js `^22.14.0 || ^24.0.0`.

Install the CLI globally:

```bash
npm install -g @deviltea/spec-tool
```

Or run it without installing:

```bash
npx @deviltea/spec-tool init
```

## Quick Start

The initial Spec CLI keeps the command surface deliberately small. These are
five of its core commands.

### `spec init`

Initializes a new Spec project (`.engineering/`) in the current Git worktree
root.

```bash
spec init
```

### `spec artifact create <type>`

Creates one new draft Artifact of the given type (`prd`, `req`, `adr`, `pol`,
or `chg`).

```bash
spec artifact create req --title "Search Result Filtering" --summary "Search results support explicit filtering by supported criteria."
```

### `spec validate`

Validates the current project snapshot (or, with `--scope transition`, an
explicit Git transition) and reports deterministic diagnostics.

```bash
spec validate
```

### `spec query lookup <artifact-id>`

Looks up one Artifact by its exact identity, one of several `spec query`
subcommands (`list`, `search`, `relations`, `trace`, `impact`, `history`,
`resolve-current`).

```bash
spec query lookup REQ-031
```

### `spec resource read <owner-id> <location>`

Reads the raw bytes of one Resource owned by the given Artifact, writing
exactly the file content to stdout.

```bash
spec resource read REQ-031 diagrams/flow.svg
```

## Exit Codes

| Exit | Meaning |
| ---: | --- |
| `0` | The requested operation completed successfully |
| `1` | Evaluation completed but EF domain findings rejected the result |
| `2` | The requested operation could not complete |
| `3` | Internal implementation failure |

Every result-producing command also accepts `--format json`, which prints
exactly one stable JSON result object to stdout for scripting and CI.

## Agent Skills

This package currently ships two inherited [Agent Skills](https://github.com/DevilTea/deviltea-labs/tree/main/packages/spec-tool/skills)
that sequence the shipped CLI without reimplementing its logic. They describe
current operational behavior, not canonical product design; Discussion #65 wins
on any design conflict:

- **`author-engineering-files`** — initializes a Spec project, discovers context
  with staged read-only queries, creates draft Artifacts, plans CHG-backed
  transitions for active content, and validates the result.
- **`review-engineering-change`** — reviews a proposed engineering change with
  read-only transition validation, impact and history queries, and
  explanation of the resulting deterministic diagnostics.

Installing `@deviltea/spec-tool` does not install or mutate an agent's Skill
directory. The Skill directories ship in the npm tarball and the GitHub
repository under `skills/`; install them with an existing compatible Skill
installer for your agent, for example the [`skills`](https://skills.sh/) CLI:

```bash
npx skills add DevilTea/deviltea-labs \
  --skill author-engineering-files \
  --skill review-engineering-change
```

This clones the repository and copies the two Skills (which live under
`packages/spec-tool/skills/` in this monorepo) into your agent's Skill directory;
add `-g` to install them globally instead of into the current project.


## Current Implementation Reference

The retained [`docs/ef-core/`](https://github.com/DevilTea/deviltea-labs/tree/main/packages/spec-tool/docs/ef-core)
describes the inherited EF behavior that much of the current implementation
still follows. It is useful when working on shipped code, but it is not the
canonical Spec product model and yields to Discussion #65 whenever they differ.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/spec-tool?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/spec-tool
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/spec-tool?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/spec-tool
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
