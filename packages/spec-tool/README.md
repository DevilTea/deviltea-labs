# @deviltea/spec-tool

> ESM-only Node.js CLI.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]

Spec is a Git-native engineering specification maintenance and collaboration
tool. It maintains authoritative engineering knowledge, decision history, and
provenance as Markdown files with structured YAML frontmatter under
`.engineering/`. The initial implementation retains the existing EF Core
Artifact ontology (PROJECT, PRD, REQ, ADR, POL, CHG) and deterministic,
read-only-by-default behavior while the new product boundary is designed.

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

This package ships two [Agent Skills](https://github.com/DevilTea/deviltea-labs/tree/main/packages/spec-tool/skills)
that sequence the CLI for common workflows without reimplementing its logic:

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

### Repository workflow adoption

The Skills activate for specification-maintenance requests, but only repository-level
instructions can guarantee that a generic request (e.g. "add feature X")
first enters the EF lifecycle. Adapt this harness-neutral snippet into your
repository's instruction file (`AGENTS.md`, `CLAUDE.md`, or equivalent):

```text
When asked to make an engineering change to this repository:
1. Discover Spec context (does `.engineering/` exist, and what does it say)
   before writing code.
2. When applicable, draft or update the engineering intent in Spec first
   (PROJECT/PRD/REQ/ADR/POL) — see the `author-engineering-files` Skill.
3. Implement the change.
4. Record a CHG (or other authoritative effect) for the change — see
   `author-engineering-files`.
5. Run `spec validate --scope snapshot` on the working tree.
6. Validate the integration boundary of the candidate commit(s)
   (`spec validate --scope transition|bootstrap|range`) before the
   integration ref advances — see the `review-engineering-change` Skill.
7. Integrate only after validation succeeds.
```

## Full Specification

The retained EF Core v1 ontology, lifecycle, validation, query, and CLI
contract are specified in
[`docs/ef-core/`](https://github.com/DevilTea/deviltea-labs/tree/main/packages/spec-tool/docs/ef-core),
starting with the [Overview](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/docs/ef-core/00-overview.md)
and the [CLI Contract](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/docs/ef-core/13-cli-contract.md).

For a worked example wiring `spec validate --scope range` into CI so a whole
candidate range is validated while it is still unpublished, before the
integration ref advances, see the
[GitHub Actions integration-range recipe](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/docs/planning/03-ci-recipe-github-actions-range-validation.md).

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/spec-tool/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/spec-tool?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/spec-tool
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/spec-tool?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/spec-tool
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
