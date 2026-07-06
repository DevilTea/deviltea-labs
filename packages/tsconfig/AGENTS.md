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

- `pnpm release` — runs `bumpp` (version bump + git tag + push) then `pnpm publish`
- No release CI workflow; the only workflow is a weekly `security-audit.yml` running `pnpm audit --audit-level=moderate`

## Gotchas

- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings (this is a single-package repo); `strictDepBuilds` is on — new deps that need build scripts must be reviewed into `onlyBuiltDependencies`/`ignoredBuiltDependencies`
- Node >= 24 required (`engines`); consumers need TypeScript >= 5.9 (peer dependency)
- README usage examples (`"extends": "@deviltea/tsconfig/tsconfig.json"` etc.) do not match the actual `exports` map (`./base`, `./node`, `./dom`) — verify against `package.json` before touching either
