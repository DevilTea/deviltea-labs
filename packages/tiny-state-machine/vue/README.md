# @deviltea/tiny-state-machine-vue

> ESM-only package.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

## Installation

Install Core and Vue Adapter at the same version. The adapter requires the exact matching Core as a peer so both imports share one definition registry. Use either `npm`, `yarn`, or `pnpm`:

```bash
npm install @deviltea/tiny-state-machine @deviltea/tiny-state-machine-vue vue
```

```bash
yarn add @deviltea/tiny-state-machine @deviltea/tiny-state-machine-vue vue
```

```bash
pnpm add @deviltea/tiny-state-machine @deviltea/tiny-state-machine-vue vue
```

## Usage

```ts
import { assertValidDefinition, createMachine, defineMachine, useMachine } from '@deviltea/tiny-state-machine-vue'

const definition = defineMachine({
	initial: 'idle',
	states: {
		idle: { on: { start: 'loading' } },
		loading: { on: { done: 'finished' } },
		finished: { type: 'final' },
	},
})
assertValidDefinition(definition)
const machine = createMachine(definition)

const { currentState, isDisposed, send, can, dispose } = useMachine(machine)

send('start')
console.log(currentState.value) // loading
console.log(can('done')) // true
send('done')
dispose()
```

### Ownership and disposal

- `currentState` and `isDisposed` are read-only computed refs.
- `send` infers event names from the machine definition; `can` is reactive and accepts arbitrary string input.
- By default, `useMachine(machine)` borrows an existing machine. Scope disposal unsubscribes the binding but leaves the machine alive; multiple components can share it.
- Use `useMachine(machine, { autoDestroy: true })` when the scope exclusively owns the machine.
- Outside an active Vue scope, call `dispose()` manually. Disposal is idempotent. External machine destruction also marks the binding disposed; its last observed state remains readable, `can` returns false, and `send` throws.
- Vue is a peer dependency and is not bundled.

### Migration

Machine is a type-only interface re-exported from Core; create instances through createMachine rather than a class constructor. Core machine creation now requires a valid definition. Define and check the configuration before creating the machine; core definition and graph APIs are re-exported unchanged. Machine now has only the Config generic; store domain data in Vue refs, application stores, or closures rather than machine or transition context.

Previously `autoDestroy` defaulted to true and the state ref was writable. Ownership now defaults to borrowed and state can only change through the machine. Opt in to automatic destruction for exclusively owned instances. Disposal errors are propagated instead of logged and swallowed.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/tiny-state-machine/vue/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/tiny-state-machine-vue?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/tiny-state-machine-vue
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/tiny-state-machine-vue?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/tiny-state-machine-vue
[bundle-src]: https://img.shields.io/bundlephobia/minzip/@deviltea/tiny-state-machine-vue?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=@deviltea/tiny-state-machine-vue
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
