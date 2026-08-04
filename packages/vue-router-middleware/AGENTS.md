# @deviltea/vue-router-middleware

## Scope and layout

This pnpm-workspace package provides an ESM Vue Router 4 middleware guard. Its runtime is deliberately small and dependency-free: `src/index.ts` exports `handleMiddlewares` and `defineMiddleware`; `src/types.ts` exports `Middleware` and augments `vue-router`'s `RouteMeta` with `middleware`.

```
src/index.ts             # guard runtime and defineMiddleware
src/types.ts             # public middleware type and RouteMeta augmentation
src/index.unit.test.ts   # colocated Vitest runtime/type-contract tests
tsdown.config.ts         # ESM build and declaration generation
vitest.config.ts         # package-local Vitest configuration
tsconfig.*.json          # lib, test, and tooling project configs
```

`meta.middleware` accepts one middleware or an array. Register `handleMiddlewares` with `router.beforeEach`. A middleware receives `(to, from)` and may return `true`, `null`, or `undefined` to continue; `false` aborts; a Vue Router location redirects. Both sync and async middleware are supported.

## Commands

Run these from this directory, or prefix them from the monorepo root with `pnpm --filter @deviltea/vue-router-middleware`.

```bash
pnpm test                 # Vitest watch mode
pnpm exec vitest run      # one non-watch test run
pnpm test:cov             # coverage report
pnpm typecheck            # tsc against tsconfig.test.json
pnpm build                # tsdown -> dist/
pnpm lint
pnpm lint:fix
```

## Implementation rules

- Use strict TypeScript, tabs, single quotes, and no semicolons; package ESLint configuration inherits `@deviltea/eslint-config`.
- Keep public runtime exports tree-shakable (`sideEffects: false`) and retain the ESM-only output contract.
- Keep `vue` and `vue-router` as peers; do not add runtime dependencies for this guard.
- `defineMiddleware` is a type helper and must return the identical function reference.

## Unit-test rules

- Use Vitest and colocate every unit test beside its source as `*.unit.test.ts`; do not add new tests under a separate `test/` directory.
- Write discriminating tests: they must fail for plausible but wrong implementations, not merely execute lines. Assert exact return values, calls, argument identity, order, and stopping behavior where relevant.
- Cover boundary values, inverse conditions, error/rejection paths, and exact outputs. For this guard, test each of the five same-route fields independently, shallow-key existence and strict/reference value equality, empty `matched`/middleware cases, and sync plus async outcomes.
- Treat coverage as a diagnostic only; high coverage is not evidence that behavior is specified or protected.

## Gotchas

- Same-route detection is shallow and requires equality of `path`, `name`, `query`, `params`, and `hash`; a difference in any one must execute middleware. Equal-looking nested query/param values are different unless they are the same reference.
- Middleware is collected in `to.matched` order. Array middleware is flattened in place; the first non-continuation result is returned and later middleware must not run. A thrown or rejected error propagates.
- No matched route or no collected middleware returns exactly `true`.
- `package.json` key ordering is linted. The workspace has strict dependency-build and release-age policies in `pnpm-workspace.yaml`; inspect any new dependency before adding it.
