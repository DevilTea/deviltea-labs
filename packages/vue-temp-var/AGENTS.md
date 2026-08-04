# AGENTS.md

## Project Overview

`vue-temp-var` is an ESM-only single-component Vue library for defining temporary variables inside a template with full type inference: `<TempVar v-slot="{ x }" :define="{ x: … }">` passes the `define` prop through a scoped slot, so destructured values keep their types and stay reactive (see vuejs/rfcs#505). It has a `vue >=3.3` peer dependency.

**Repository structure:**
```
src/TempVar.vue       # The entire component (generic script-setup + slot passthrough)
src/index.ts          # Re-exports the component as default
tsdown.config.ts      # tsdown Vue SFC build (ESM + declarations -> dist/)
tsconfig.lib.json     # Library sources (extends @deviltea/tsconfig/browser)
```

## Setup Commands

```bash
# Install dependencies
pnpm install

# Build (runs type-check + tsdown -> dist/)
pnpm build

# Rebuild on change during development
pnpm dev

# Type check only (vue-tsc over tsconfig.lib.json)
pnpm type-check

# Lint / lint and fix
pnpm lint
pnpm lint:fix
```

## Code Style

- TypeScript strict mode via `@deviltea/tsconfig/browser`
- ESLint flat config extending `@deviltea/eslint-config` (tabs, single quotes, no semicolons)
- The whole library is `src/TempVar.vue` — keep it a single generic component with zero runtime dependencies (peer `vue` only)

## Testing

No test suite — validation is `pnpm build` (includes vue-tsc type-check) + `pnpm lint`.

## Release

- Releases are centralized in the repository root: dispatch **Create release PR** (`.github/workflows/release-pr.yml`) with `vue-temp-var` and a Bumpp release type or exact version.
- After its verified release PR merges into `main`, create and push the matching annotated tag (for example, `vue-temp-var@2.0.2`). **Publish package** (`.github/workflows/publish.yml`) validates, packs, and publishes through npm Trusted Publishing (OIDC).
- This package intentionally has no local `release` script. `prepublishOnly` still builds the tarball during centralized publishing.

## Gotchas

- tsdown uses `unplugin-vue/rolldown` to compile the Vue SFC and `dts.vue` to emit the ESM declaration entry; keep package.json `exports` paths in sync with its `dist/index.js` and `dist/index.d.ts` output
- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings; `strictDepBuilds` is on (only `esbuild` is in `ignoredBuiltDependencies`) — new deps that need build scripts must be reviewed into the lists
- `shellEmulator: true` — keep any glob in package.json scripts quoted
- Node 22.14+ and 24.x are supported (`engines` and CI matrix)
- A weekly `security-audit.yml` workflow runs `pnpm audit --audit-level=moderate` (Sundays 21:00 UTC)
