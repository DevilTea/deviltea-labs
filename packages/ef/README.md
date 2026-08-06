# @deviltea/ef

> ESM-only Node.js CLI.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]

Engineering Files (EF) is a file-based, Git-native system for maintaining
canonical engineering knowledge, decision history, and change provenance. `ef`
is the deterministic CLI over that system: EF Artifacts (PROJECT, PRD, REQ,
ADR, POL, CHG) live as Markdown files with structured YAML frontmatter under
`.engineering/`, and `ef` provides a small, read-only-by-default surface to
initialize a project, create draft Artifacts, validate state, and query the
resulting graph — no database, no required LLM judgment, no hidden mutation.

## Installation

Requires Node.js `^22.14.0 || ^24.0.0`.

Install the CLI globally:

```bash
npm install -g @deviltea/ef
```

Or run it without installing:

```bash
npx @deviltea/ef init
```

## Quick Start

EF Core v1 keeps the command surface deliberately small. These are five of
its core commands.

### `ef init`

Initializes a new EF project (`.engineering/`) in the current Git worktree
root.

```bash
ef init
```

### `ef artifact create <type>`

Creates one new draft Artifact of the given type (`prd`, `req`, `adr`, `pol`,
or `chg`).

```bash
ef artifact create req --title "Search Result Filtering" --summary "Search results support explicit filtering by supported criteria."
```

### `ef validate`

Validates the current project snapshot (or, with `--scope transition`, an
explicit Git transition) and reports deterministic diagnostics.

```bash
ef validate
```

### `ef query lookup <artifact-id>`

Looks up one Artifact by its exact identity, one of several `ef query`
subcommands (`list`, `search`, `relations`, `trace`, `impact`, `history`,
`resolve-current`).

```bash
ef query lookup REQ-031
```

### `ef resource read <owner-id> <location>`

Reads the raw bytes of one Resource owned by the given Artifact, writing
exactly the file content to stdout.

```bash
ef resource read REQ-031 diagrams/flow.svg
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

This package ships two [Agent Skills](https://github.com/DevilTea/deviltea-labs/tree/main/packages/ef/skills)
that sequence the CLI for common workflows without reimplementing its logic:

- **`author-engineering-files`** — initializes a project, discovers context
  with staged read-only queries, creates draft Artifacts, plans CHG-backed
  transitions for active content, and validates the result.
- **`review-engineering-change`** — reviews a proposed engineering change with
  read-only transition validation, impact and history queries, and
  explanation of the resulting deterministic diagnostics.

Installing `@deviltea/ef` does not install or mutate an agent's Skill
directory. The Skill directories ship in the npm tarball and the GitHub
repository under `skills/`; install them with an existing compatible Skill
installer for your agent.

## Full Specification

The complete EF Core v1 ontology, lifecycle, validation, query, and CLI
contract are specified in
[`docs/ef-core/`](https://github.com/DevilTea/deviltea-labs/tree/main/packages/ef/docs/ef-core),
starting with the [Overview](https://github.com/DevilTea/deviltea-labs/blob/main/packages/ef/docs/ef-core/00-overview.md)
and the [CLI Contract](https://github.com/DevilTea/deviltea-labs/blob/main/packages/ef/docs/ef-core/13-cli-contract.md).

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/ef/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/ef?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/ef
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/ef?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/ef
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
