# AGENTS.md

## Project Overview

`@deviltea/eslint-config` is a published npm package that wraps [`@antfu/eslint-config`](https://github.com/antfu/eslint-config) (v9) with personal customizations: tab indentation, stricter chaining/newline stylistic rules, `no-lonely-if` for JS/TS, and a set of Vue SFC conventions (script-setup + composition API, type-based `defineProps`/`defineEmits`, PascalCase components). Exported as a single ESM factory function with the same signature as `antfu()`.

**Repository structure:**
```
src/index.ts        # Entire implementation: factory wrapping antfu() with option overrides
test/               # Node test runner coverage for factory option forwarding and override precedence
dist/               # tsdown output (index.mjs + index.d.mts) — the published artifact
eslint.config.js    # Self-lints using ./dist/index.mjs (dogfooding)
pnpm-workspace.yaml # pnpm supply-chain security settings only (single-package repo)
.github/workflows/  # ci.yml (build+test+lint), release.yml (manual dispatch), security-audit.yml (weekly pnpm audit)
```

## Setup Commands

```bash
# Install dependencies
pnpm install

# Build (tsdown -> dist/, ESM + dts, runs publint; options live in tsdown.config.ts)
pnpm build

# Test (builds first, then runs the Node.js test runner)
pnpm test

# Run the same build, test, and lint validation used by CI
pnpm check

# Lint and fix (requires a prior build — see Gotchas)
pnpm lint
pnpm lint:fix

# Version bump + publish (local path; CI path exists too — see Release)
pnpm release
```

## Code Style

- TypeScript strict mode (`strict` + `noUncheckedIndexedAccess`), `moduleResolution: Bundler`, ESNext target
- Tabs for indentation — this config's own signature preference
- ESLint flat config; the repo lints itself with its own built output
- The whole package lives in `src/index.ts` — keep it single-file; `@antfu/eslint-config` is the only runtime dependency
- ESM-only package (`type: module`, `import` export condition only)

## Testing

- Tests use the built-in Node.js test runner and require Node >= 24.
- Tests intercept the external `@antfu/eslint-config` import and assert the exact options passed by the wrapper.
- Keep tests focused on this package's contract: default rules, nested option preservation, override precedence, booleans, and user config forwarding.
- Do not snapshot the full resolved upstream ESLint config; that would make routine upstream upgrades unnecessarily brittle.

## Release

- Releases run in CI: trigger the `Release` workflow (workflow_dispatch) with a `bump_type` (patch/minor/major). It validates (`pnpm build && pnpm lint`), bumps the version with `bumpp` (pushes the release commit + `v*` tag), publishes to npm via trusted publishing (OIDC — no token secret), then generates GitHub release notes with `changelogithub`.
- The local `pnpm release` script bypasses CI validation and produces no GitHub release notes — prefer the workflow.

## Gotchas

- `eslint.config.js` imports `./dist/index.mjs`, so `pnpm build` must run before `pnpm lint` (`pnpm test` builds first, and CI runs test before lint); a stale `dist/` means you lint with old rules
- `pnpm-workspace.yaml` exists only to hold pnpm supply-chain security settings; the config itself enforces them via `pnpm/yaml-enforce-settings` (requires `shellEmulator: true` and `trustPolicy: no-downgrade`) — removing those keys makes lint fail
- `strictDepBuilds` is on with `onlyBuiltDependencies: []` — new deps that need build scripts must be reviewed into the allowlist
- Node >= 24 required (`engines`, enforced by `engine-strict=true` in `.npmrc`)
