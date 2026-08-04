# @deviltea/tiny-state-machine contributor guide

## Scope and layout

This ESM-only package implements the framework-agnostic finite-state-machine API. Keep runtime implementation and colocated behavioral tests in `src/`:

- `src/index.ts` exports `Machine`, `createMachine`, and the public configuration/context types.
- `src/index.unit.test.ts` is the Vitest behavioral suite; do not add a separate `tests/` tree for unit tests.
- `tsdown.config.ts` builds `src/index.ts` to ESM plus declarations in `dist/`; `dist/` is generated and must not be edited.

`createMachine(config, context?)` starts at `config.initial`. `context` may be an object, `null`, or a lazy factory. `send(event)` ignores events unavailable from the current state. A successful transition updates `currentState` before notifying `onTransition` subscribers. Subscriber payloads contain the exact `{ transition, machine, context, send }` contract; `send` must remain bound to its machine. Filters on `source`, `event`, and `target` are conjunctive when multiple fields are supplied. Filtered handlers for a target state declared with runtime `type: 'final'` receive `send: null`.

`destroy()` runs `onBeforeDestroyed` handlers while state/context remain readable, clears destruction registrations and internal state, marks the machine destroyed, then runs `onAfterDestroyed` handlers. Once destroyed, state/context access and operational registration/sending/destroying throw `Error('The machine has been destroyed.')`; `isDestroyed` remains readable. Unsubscribe functions are safe to call after removal or destruction.

## Commands

Run from this directory or with `pnpm --filter @deviltea/tiny-state-machine` from the repository root:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm exec eslint src
```

`test` runs `vitest run`. `typecheck` checks both package declarations and tests. Build before package/publishing validation when changing exports.

## Unit-test standard

Use Vitest and name colocated tests `*.unit.test.ts`. Test behavior, not implementation details or coverage percentage. Each change must include assertions that distinguish the intended implementation from plausible near-misses:

- assert exact transition records, payload values/identity, ordering, and observable errors;
- cover boundary states/events, inverse or non-matching filters, invalid events, unsubscribe and cleanup behavior;
- cover error paths and lifecycle semantics, including repeated/invalid operations where they are part of the public contract;
- use coverage only as a diagnostic: high coverage is never sufficient evidence of correct behavior.

Avoid production changes solely to make tests easier. Preserve the synchronous notification and lifecycle semantics unless the public API is intentionally changed.
