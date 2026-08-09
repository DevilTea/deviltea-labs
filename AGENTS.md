# AGENTS.md

## Monorepo guide

This pnpm workspace publishes reusable packages from `packages/*` and hosts the documentation site in `docs/site`. Treat each package as an independently releasable product: preserve its public exports, package boundary, and package-specific build/typecheck commands. Do not describe this repository as a collection of standalone repositories; workspace-wide commands and the root catalog are the source of truth.

## Commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test
pnpm build
pnpm check
```

`pnpm test:unit` runs Vitest tests owned by the root configuration, including colocated `packages/**/src/**/*.unit.test.ts` files. `pnpm test` additionally runs package consumer/contract tests that pack or install artifacts. Use a package's own script when iterating on just that package; keep its smoke or contract command separate from fast unit tests.

## Releasing

Releases are driven locally: `pnpm release <package> <release>` bumps the package and opens its release pull request with auto-merge enabled, and `pnpm release:tag <package>` pushes the annotated tag after that pull request merges. Only the tag push triggers publishing, which happens exclusively in `publish.yml` via npm Trusted Publishing. Both commands push to `origin` and the second one publishes to npm, so never run them without an explicit instruction to release. See [docs/migration/release-cutover.md](docs/migration/release-cutover.md).

## Testing policy

- Write Vitest unit tests as `*.unit.test.ts` next to runtime source where practical. JSON-only configuration packages such as `packages/tsconfig` are validated instead by positive and negative compiler consumer contracts and do not participate in Vitest coverage.
- Test externally observable behavior with precise assertions: exact return values, options, rule settings, arguments, public exports, and precedence. Do not treat a coverage percentage as evidence of correctness.
- Include discriminating cases that reject plausible-but-wrong implementations: boundary values, false/disabled branches, user overrides versus defaults, preservation of unrelated input, and ordering/forwarding behavior.
- Exercise error or rejection paths whenever the product has one. For compiler/config products, retain consumer contract tests that prove both accepted and rejected programs; unit tests complement rather than replace them.
- Avoid snapshots of broad third-party output. Assert this repository's contract so upstream upgrades remain reviewable.
- Keep publish/install smoke tests and scripts when they validate packaging, declarations, peer dependencies, or actual tool integration; those are integration tests, not candidates for unit-test migration.
- Root Vitest V8 coverage reports every runtime source file in `eslint-config`, `tiny-state-machine`, `tiny-state-machine-vue`, `vue-router-middleware`, and `vue-temp-var` (including Vue SFCs). Keep its explicit include/exclude list accurate when runtime files move; `packages/tsconfig` is intentionally excluded because its JSON presets are validated by contract tests instead. Do not hide fully covered files from the text report: package/file visibility is required for a trustworthy report. The global 90% coverage thresholds are a minimum regression guardrail, not a substitute for discriminating assertions or the testing policy above; never auto-update them to mask a regression.

## Conventions

- This repository is ESM (`"type": "module"`) and uses pnpm 10 with versions managed in `pnpm-workspace.yaml`'s catalog.
- Follow the nearest package `AGENTS.md` for package-specific constraints. `CLAUDE.md` mirrors it by reference for compatible agent tooling.
- Do not hand-edit generated `dist/` artifacts or TypeScript build-info files. Keep changes scoped to the package being changed.
- Before handoff, run the narrowest relevant unit test, then lint/typecheck or the package validation command when practical.
