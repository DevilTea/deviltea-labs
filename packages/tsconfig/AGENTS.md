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

- Releases are centralized in the repository root: dispatch **Create release PR** (`.github/workflows/release-pr.yml`) with `tsconfig` and a Bumpp release type or exact version.
- After its verified release PR merges into `main`, create and push the matching annotated tag (for example, `tsconfig@1.0.1`). **Publish package** (`.github/workflows/publish.yml`) validates, packs, and publishes through npm Trusted Publishing (OIDC).
- This package intentionally has no local `release` script.

## Gotchas

- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings (this is a single-package repo); `strictDepBuilds` is on — new deps that need build scripts must be reviewed into `onlyBuiltDependencies`/`ignoredBuiltDependencies`
- Node 22.14+ and 24.x are supported (`engines`); consumers need TypeScript 6.x (`>=6.0.0 <7.0.0`)
