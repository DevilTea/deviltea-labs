# AGENTS.md

## Project Overview

`@deviltea/eslint-config` is a published npm package that wraps [`@antfu/eslint-config`](https://github.com/antfu/eslint-config) (v9) with personal customizations: tab indentation, stricter chaining/newline stylistic rules, `no-lonely-if` for JS/TS, and a set of Vue SFC conventions (script-setup + composition API, type-based `defineProps`/`defineEmits`, PascalCase components). Exported as a single ESM factory function with the same signature as `antfu()`.

**Repository structure:**
```
src/index.ts        # Entire implementation: factory wrapping antfu() with option overrides
test/               # Wrapper unit tests and packed-package consumer smoke tests
dist/               # tsdown output (index.mjs + index.d.mts) — the published artifact
eslint.config.js    # Self-lints using ./dist/index.mjs (dogfooding)
pnpm-workspace.yaml # pnpm supply-chain security settings only (single-package repo)
.github/workflows/  # ci.yml (unit/lint + ESLint compatibility matrix), release.yml, security-audit.yml
```

## Setup Commands

```bash
# Install dependencies
pnpm install

# Build (tsdown -> dist/, ESM + dts, runs publint; options live in tsdown.config.ts)
pnpm build

# Unit tests for wrapper behavior (builds first)
pnpm test

# Pack and install the package into a temporary consumer, then verify runtime, types, and JS/TS/Vue lint
pnpm test:package

# Run the complete local validation suite
pnpm check

# Lint and fix (requires a prior build — see Gotchas)
pnpm lint
pnpm lint:fix

# Validate, bump, and publish locally (the CI workflow remains preferred)
pnpm release
```

## Code Style

- TypeScript strict mode (`strict` + `noUncheckedIndexedAccess`), `moduleResolution: Bundler`, ESNext target
- Tabs for indentation — this config's own signature preference
- ESLint flat config; the repo lints itself with its own built output
- The whole package lives in `src/index.ts` — keep it single-file; `@antfu/eslint-config` is the only runtime dependency
- ESM-only package (`type: module`, `import` export condition only)

## Dependency Policy

- Pin `@antfu/eslint-config` exactly. A shareable config must not change lint behavior when consumers reinstall the same `@deviltea/eslint-config` version.
- Upgrade the upstream config through a dedicated PR with unit, packed-consumer, and effective-rule review.
- Avoid adding release-only npm tools when the GitHub-hosted runner already provides an equivalent trusted platform command. The release workflow uses the preinstalled GitHub CLI for release notes.

## Testing

- Unit tests use the built-in Node.js test runner and require Node >= 24.
- Unit tests intercept the external `@antfu/eslint-config` import and assert the exact options passed by the wrapper.
- Keep unit tests focused on this package's contract: default rules, nested option preservation, override precedence, booleans, and user config forwarding.
- Do not snapshot the full resolved upstream ESLint config; that would make routine upstream upgrades unnecessarily brittle.
- `test/package-smoke.mjs` packs the publishable tarball, installs it into a temporary consumer with strict peer dependency checks, and validates runtime import, generated declarations, and JS/TS/Vue lint behavior.
- CI runs the package smoke test against ESLint 10.4.0, the minimum supported version imposed by the current dependency graph, and the latest compatible ESLint 10 release. Set `ESLINT_VERSION` to reproduce a specific matrix entry locally.

## Release

- Trigger the `Release` workflow (`workflow_dispatch`) with a `bump_type` (`patch`, `minor`, or `major`).
- The workflow serializes releases, installs the frozen lockfile, runs the complete `pnpm check` suite, bumps and tags with `bumpp`, publishes through npm trusted publishing (OIDC), and creates GitHub-generated release notes for the verified remote tag.
- The local `pnpm release` script also runs `pnpm check` before bumping and publishing, but it does not create GitHub release notes; prefer the workflow for official releases.

## Gotchas

- `eslint.config.js` imports `./dist/index.mjs`, so `pnpm build` must run before `pnpm lint` (`pnpm test` builds first, and CI runs test before lint); a stale `dist/` means you lint with old rules
- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings; the config itself enforces them via `pnpm/yaml-enforce-settings` (requires `shellEmulator: true` and `trustPolicy: no-downgrade`) — removing those keys makes lint fail
- `strictDepBuilds` is on with `onlyBuiltDependencies: []` — new deps that need build scripts must be reviewed into the allowlist
- Node >= 24 required (`engines`, enforced by `engine-strict=true` in `.npmrc`)
