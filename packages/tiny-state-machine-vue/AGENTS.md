# @deviltea/tiny-state-machine-vue contributor guide

## Scope and layout

This ESM-only Vue adapter wraps `@deviltea/tiny-state-machine` without owning transition rules. Keep source and colocated tests in `src/`:

- `src/index.ts` re-exports the core package and provides `useMachine(machine, options?)`.
- `src/index.unit.test.ts` is the Vitest behavioral suite; do not add a separate `tests/` tree for unit tests.
- `tsdown.config.ts` emits ESM and declarations to `dist/`, leaving `vue` external (`neverBundle`). Do not edit generated `dist/` files.

`useMachine` returns read-only reactive state and disposal status, typed `send`, reactive `can`, and idempotent `dispose`. The default borrows the machine; an active Vue scope unsubscribes on disposal, with explicit `autoDestroy: true` for exclusively owned instances. Outside a scope the caller must dispose manually. External destruction marks the binding disposed. Preserve core exports as direct re-exports.

## Commands

Run from this directory or with `pnpm --filter @deviltea/tiny-state-machine-vue` from the repository root:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm exec eslint src
```

`test` runs `vitest run`. `typecheck` checks package declarations and tests. The workspace dependency on `@deviltea/tiny-state-machine` must be built/type-correct for package-level integration work.

## Unit-test standard

Use Vitest and colocate unit tests beside source as `*.unit.test.ts`. Prefer real Vue effect scopes and reactive tests; use focused mocks for unsubscribe contracts. Test behavior rather than lines executed, and make each test reject semantically similar but wrong implementations:

- assert exact ref initial values, transition synchronization, export identity, calls, and error values;
- cover default/explicit/disabled `autoDestroy`, successful and failing disposal, and inverse paths;
- cover boundaries, negative conditions, error paths, and exact observable output for every changed behavior;
- treat coverage as a diagnostic only: coverage alone is not evidence of correctness.

Do not change the core state-machine behavior here; this package adapts it. Keep Vue as an external runtime dependency.
