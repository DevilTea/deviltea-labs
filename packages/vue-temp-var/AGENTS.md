# vue-temp-var

## Scope and layout

This pnpm-workspace package is an ESM-only Vue 3.3+ component library. `TempVar` is a generic SFC that passes its required `define` record to its default scoped slot, preserving values, reactivity, and slot-prop inference. `src/index.ts` default-exports that exact component.

```
src/TempVar.vue           # generic define prop and scoped-slot passthrough
src/index.ts              # default re-export
src/TempVar.unit.test.ts  # colocated Vitest component and type-contract tests
tsdown.config.ts          # Vue SFC ESM/declaration build
vitest.config.ts          # Vue-aware, package-local Vitest configuration
tsconfig.lib.json         # source and unit-test Vue type checking
```

Use it as `<TempVar v-slot="{ value }" :define="{ value }">…</TempVar>`.

## Commands

Run these from this directory, or prefix them from the monorepo root with `pnpm --filter vue-temp-var`.

```bash
pnpm test                 # Vitest watch mode
pnpm exec vitest run      # one non-watch test run
pnpm test:cov             # coverage report
pnpm type-check           # vue-tsc over tsconfig.lib.json
pnpm build                # type-check then tsdown -> dist/
pnpm lint
pnpm lint:fix
```

## Implementation rules

- Use strict TypeScript, tabs, single quotes, and no semicolons; package ESLint configuration inherits `@deviltea/eslint-config`.
- Keep the generic `define` prop required and preserve the default slot's `T` contract. The default export must stay the `TempVar.vue` component itself.
- Keep runtime dependencies at zero: `vue` remains a peer and `unplugin-vue` is build/test tooling only.
- The package export targets must match tsdown's `dist/index.js` and `dist/index.d.ts` output.

## Unit-test rules

- Use Vitest and colocate every unit test beside its source as `*.unit.test.ts`; do not create a separate test directory.
- Use Vue-aware tests that assert slot props and rendered/reactive updates. Do not rely on snapshots as the behavioral assertion.
- Tests must distinguish a correct implementation from semantically similar mistakes: assert the original slot-prop record identity, exact enumerable string and symbol keys, falsy values, changed values after in-place reactive updates and prop replacement, required prop/type contracts, safe omission of the default slot, and default-export identity.
- Cover boundary values, inverse conditions, error paths where the component has them, and exact outputs. Coverage is only a diagnostic; it is not a sufficient test objective.
- Keep the package-local coverage threshold at 100% for statements, lines, functions, and branches. A `0/0` functions or branches result is valid when Vue's SFC source map has no corresponding source-level counter; it means there is nothing coverable in the authored source, not that compiler-generated code was skipped.

## Gotchas

- `<slot v-bind="define" />` forwards enumerable record entries as slot props; it does not create a new application state. The parent must update the `define` prop to update consumers.
- The generic SFC type is part of the public API. Avoid widening `define` to an untyped object or making it optional, even if a runtime test still passes.
- Vitest needs the Vue SFC transform configured through `unplugin-vue/vite`; keep it aligned with the tsdown transform.
- `package.json` key ordering is linted. The workspace has strict dependency-build and release-age policies in `pnpm-workspace.yaml`; inspect any new dependency before adding it.
