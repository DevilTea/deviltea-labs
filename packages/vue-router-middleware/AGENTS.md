# AGENTS.md

## Project Overview

`@deviltea/vue-router-middleware` is a small route middleware system for Vue Router. Middlewares are declared per-route via `meta.middleware` (a function or array, typed through a `vue-router` module augmentation) and executed by registering `handleMiddlewares` as a global `beforeEach` guard; a middleware can abort, redirect, or continue navigation, sync or async. Published as an ESM-only package with peer deps `vue >=3` and `vue-router >=4`.

**Repository structure:**
```
src/index.ts          # handleMiddlewares + defineMiddleware (whole runtime)
src/types.ts          # Middleware type + vue-router RouteMeta augmentation
test/index.test.ts    # Vitest suite (runtime + type tests)
tsdown.config.ts      # tsdown config (ESM + declarations -> dist/)
vitest.config.ts      # coverage + typecheck enabled on every test run
tsconfig.*.json       # Split configs: lib / node / test
pnpm-workspace.yaml   # pnpm supply-chain security settings only
.github/workflows/    # ci.yml, release.yml, security-audit.yml
```

## Setup Commands

```bash
# Install dependencies
pnpm install

# Build (tsdown -> dist/)
pnpm build

# Build in stub mode for local development
pnpm dev

# Run tests (watch mode) / with coverage report
pnpm test
pnpm test:cov

# Lint and fix
pnpm lint
pnpm lint:fix

# Type check (uses tsconfig.test.json)
pnpm typecheck
```

## Code Style

- TypeScript strict mode via `@deviltea/tsconfig`
- ESLint flat config extending `@deviltea/eslint-config` (single quotes, no semicolons, tabs)
- Runtime lives in `src/index.ts`, types in `src/types.ts` — keep it dependency-free (peer deps only) and ESM-only
- `sideEffects: false`; keep exports tree-shakable

## Testing

- Vitest; tests live in `test/index.test.ts`
- `vitest.config.ts` enables coverage (`src/**/*.ts`) and typecheck for every run
- Coverage is currently 100% statements/lines — keep it there when changing `src/`
- Run a single test with `pnpm test -- -t '<name>'`
- CI runs the suite on Node 22 and 24 across ubuntu/windows/macos
- Pre-commit hook (simple-git-hooks) runs `lint-staged` (`eslint --fix`)

## Release

- Releases are centralized in the repository root: dispatch **Create release PR** (`.github/workflows/release-pr.yml`) with `vue-router-middleware` and a Bumpp release type or exact version.
- After its verified release PR merges into `main`, create and push the matching annotated tag (for example, `vue-router-middleware@0.0.5`). **Publish package** (`.github/workflows/publish.yml`) validates, packs, and publishes through npm Trusted Publishing (OIDC).
- This package intentionally has no local `release` script. `prepublishOnly` still builds the tarball during centralized publishing.

## Gotchas

- ESLint enforces `package.json` key order (`jsonc/sort-keys` via `@deviltea/eslint-config`) — run `pnpm lint:fix` after editing `package.json`
- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings (this is a single-package repo); `strictDepBuilds` is on — new deps that need build scripts must be reviewed into `onlyBuiltDependencies`/`ignoredBuiltDependencies`
- Node 22.14+ and 24.x are supported (`engines` and CI matrix)
- `handleMiddlewares` skips all middlewares when navigating to an identical route (same path, name, query, params, hash) and when `to.matched` is empty — mind this when reasoning about guard behavior
- A weekly `security-audit.yml` workflow runs `pnpm audit --audit-level=moderate` (Sundays 21:00 UTC)
