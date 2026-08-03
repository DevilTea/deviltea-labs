# AGENTS.md

## Project Overview

`@deviltea/tsconfig` is a published npm package of shared TypeScript config presets, forked from `@vue/tsconfig`. It ships three JSON configs for projects to `extends`: a strict runtime-agnostic base, a Node variant (`lib: ESNext`, `types: ["node"]`), and a DOM variant (`lib: ESNext + DOM + DOM.Iterable`). There is no source code to build — the tsconfig JSON files themselves are the product.

**Repository structure:**
```
tsconfig.base.json    # Strict base config (target/module ESNext, moduleResolution Bundler)
tsconfig.node.json    # extends base; Node lib/types
tsconfig.dom.json     # extends base; DOM libs
eslint.config.js      # Flat config, just wraps @deviltea/eslint-config
pnpm-workspace.yaml   # Holds pnpm supply-chain security settings only
```

## Setup Commands

```bash
# Install dependencies
pnpm install

# Lint and auto-fix
pnpm lint
```

## Code Style

- ESLint flat config extending `@deviltea/eslint-config` (tabs, single quotes, no semicolons)
- The presets enforce strict mode plus extras (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `noUnusedLocals/Parameters`, …) — changes here affect every consuming project
- Package exports are subpaths only: `./base`, `./node`, `./dom` (mapped to the `tsconfig.*.json` files)

## Release

- Releases run in CI: trigger the `Release` workflow (workflow_dispatch) with a `bump_type` (patch/minor/major). It validates (`pnpm lint`), bumps the version with `bumpp` (pushes the release commit + `v*` tag), publishes to npm via trusted publishing (OIDC — no token secret), then generates GitHub release notes with `changelogithub`.
- The local `pnpm release` script bypasses CI validation and produces no GitHub release notes — prefer the workflow.
- A weekly `security-audit.yml` workflow runs `pnpm audit --audit-level=moderate`

## Gotchas

- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings (this is a single-package repo); `strictDepBuilds` is on — new deps that need build scripts must be reviewed into `onlyBuiltDependencies`/`ignoredBuiltDependencies`
- Node >= 24 required (`engines`); consumers need TypeScript >= 5.9 (peer dependency)
