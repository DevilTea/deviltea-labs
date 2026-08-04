# AGENTS.md

## Package scope

`@deviltea/eslint-config` is the monorepo's published ESM ESLint flat-config factory. `src/index.ts` wraps `@antfu/eslint-config` and applies DevilTea defaults while preserving the upstream factory signature and forwarding user configs unchanged.

```
src/index.ts                 # Product implementation
src/index.unit.test.ts       # Colocated Vitest unit tests
test/package-smoke.mjs       # Packed-consumer integration smoke test
tsdown.config.ts             # ESM and declaration build
eslint.config.js             # Dogfoods the built package
```

## Commands

```bash
pnpm --filter @deviltea/eslint-config run test
pnpm --filter @deviltea/eslint-config run test:coverage
pnpm --filter @deviltea/eslint-config run test:package
pnpm --filter @deviltea/eslint-config run build
pnpm --filter @deviltea/eslint-config run lint
```

The root `pnpm test:unit` also discovers `src/index.unit.test.ts`. `test:coverage` owns a package-local V8 report for `src/index.ts` and enforces complete statements, branches, functions, and lines. `test:package` intentionally remains a separate integration test: it packs the tarball, installs it into a consumer, and validates runtime, declaration, peer-dependency, and lint behavior.

## Implementation and test rules

- Keep the implementation ESM-only and retain `FactoryFn = typeof antfu`; callers must receive the same API shape as upstream.
- Default custom rules apply only for object/omitted feature options. A literal `false` is a supported opt-out and must reach `antfu` unchanged.
- Merge defaults before user `overrides`, so a user rule wins while unrelated nested options remain intact. Forward all trailing user configs in the original order and identity.
- Vitest unit tests mock the upstream factory and assert the exact options and forwarded arguments passed to it. Test defaults, explicit `undefined`, each feature's `true` and `false` passthrough, user-override precedence (including disabling a default), nested/top-level value preservation, multi-config ordering and identity, factory-return identity, and every custom Vue rule whose spelling/value matters.
- Do not replace these assertions with a resolved-config snapshot or coverage target. The smoke test is required for package-boundary failure paths; it is not a unit test and should not be migrated.

## Gotchas

- `eslint.config.js` imports `dist/index.mjs`; run `pnpm build` before linting this package.
- Versions come from the monorepo catalog in `pnpm-workspace.yaml`. Do not add a standalone lockfile or describe this package as a separate workspace.
