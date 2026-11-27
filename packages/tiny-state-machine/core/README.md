# @deviltea/tiny-state-machine

> ESM-only package.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

## Installation

To install the package, use either `npm`, `yarn`, or `pnpm`:

```bash
npm install @deviltea/tiny-state-machine
```

```bash
yarn add @deviltea/tiny-state-machine
```

```bash
pnpm add @deviltea/tiny-state-machine
```

## Usage

Here is an example of how to create a simple state machine using `@deviltea/tiny-state-machine`.

### Example: Basic State Machine

```typescript
import { assertValidDefinition, createMachine, defineMachine } from '@deviltea/tiny-state-machine'

// Define a simple state machine with three states: idle, loading, and finished
const definition = defineMachine({
	initial: 'idle',
	states: {
		idle: {
			on: {
				start: 'loading',
			},
		},
		loading: {
			on: {
				done: 'finished',
			},
		},
		finished: {},
	},
})
assertValidDefinition(definition)
const machine = createMachine(definition)

console.log(machine.currentState) // "idle"

// Transition to the next state
machine.send('start')
console.log(machine.currentState) // "loading"

// Finish the transition
machine.send('done')
console.log(machine.currentState) // "finished"
```

### Example: Adding Transition Handlers

You can also add handlers that will be called during state transitions.

```typescript
import { assertValidDefinition, createMachine, defineMachine } from '@deviltea/tiny-state-machine'

const definition = defineMachine({
	initial: 'idle',
	states: {
		idle: {
			on: {
				start: 'loading',
			},
		},
		loading: {
			on: {
				done: 'finished',
			},
		},
		finished: {},
	},
})
assertValidDefinition(definition)
const machine = createMachine(definition)

const unsubscribe = machine.onTransition(({ transition }) => {
	console.log(
		`Transitioned from ${transition.source} to ${transition.target} via event '${transition.event}'`
	)
})

machine.send('start') // Logs: Transitioned from idle to loading via event 'start'
machine.send('done') // Logs: Transitioned from loading to finished via event 'done'

unsubscribe()
```

## Definitions and pure graph analysis

The configuration remains a flat JSON-compatible adjacency map. A Definition is the result of validating and compiling that configuration, separate from its runtime instances:

```ts
import { assertValidDefinition, createMachine, defineMachine, getReachableStates, getTransitions, transition } from '@deviltea/tiny-state-machine'

const definition = defineMachine({
	initial: 'idle',
	states: {
		idle: { on: { start: 'running' } },
		running: { on: { finish: 'done' } },
		done: { type: 'final' },
		unused: {},
	},
})

assertValidDefinition(definition)
const first = createMachine(definition)
const second = createMachine(definition)
first.send('start')
// second.currentState remains 'idle'

getReachableStates(definition) // ['idle', 'running', 'done']
getTransitions(definition) // [{ source: 'idle', event: 'start', target: 'running' }, ...]
transition(definition, 'idle', 'start') // 'running'
transition(definition, 'done', 'start') // undefined
```

`defineMachine(input)` accepts both typed configurations and unknown data, and returns a discriminated union `Definition<Config> = ValidDefinition<Config> | InvalidDefinition`. Invalid data does not throw during definition. For valid definitions, `data` is an independent deeply frozen snapshot with preserved literal types, and `diagnostics` is immutable. Invalid definitions retain the original input as `data: unknown` for inspection or editing; changing it does not revalidate the result.

Both `createMachine` and graph helpers accept only a genuine `ValidDefinition`. Narrow with `if (definition.valid)` or use `assertValidDefinition(definition)` to throw and narrow. They perform a constant-time internal identity lookup, not structural revalidation. A copy, deserialized wrapper or definition from another installed copy of the package is not executable; call `defineMachine` again with its configuration data.

The compiled graph is private and shared by the instances and analysis helpers. Destroying one machine releases only its own reference and resources, not the graph. Graph helpers do not execute observers or mutate the graph.

| Pure function | Result |
| --- | --- |
| `getStates(definition)` | State keys |
| `getEvents(definition, state)` | Events accepted by the specified state |
| `getTransitions(definition)` | All typed source/event/target records, including self-transitions |
| `transition(definition, state, event)` | Target state, or `undefined` if the event is unavailable |
| `getReachableStates(definition, start?)` | Reachable states, including the start, in breadth-first discovery order |
| `getUnreachableStates(definition, start?)` | States not reachable from the start |
| `getFinalStates(definition)` | Explicitly declared final states |
| `getDeadEndStates(definition)` | Non-final states with no outgoing edges, including unreachable ones |

The default traversal start is the initial state. Unknown source states throw. Other lists follow JavaScript own-key enumeration order. Cycles, unreachable states, and non-final dead ends are valid; analysis reports them rather than rejecting the definition. Graph queries operate on the compiled graph without recompilation. Pure transition resolution, runtime sending, and can() share the same internal lookup; the lookup never invokes callbacks or mutates the graph. Single transition resolution is a map lookup; traversal is linear in the reachable nodes and edges.

## Validation and JSON Schema

```ts
import { createMachine, defineMachine } from '@deviltea/tiny-state-machine'

const definition = defineMachine(JSON.parse(jsonText))
if (definition.valid) {
	const machine = createMachine(definition)
}
else {
	for (const diagnostic of definition.diagnostics) {
		console.error(diagnostic.code, diagnostic.message, diagnostic.path)
	}
}
```

Diagnostics have stable `code`, `severity`, `message`, and a string-segment `path` (not a dot-separated path). Currently all diagnostics are errors; cycles, unreachable states, and non-final dead ends remain valid and are reported only by explicit graph queries.

Validation checks the declared shape, string IDs if present, existing initial and target states, and forbids outgoing transitions from explicit final states. All own enumerable state/event keys (including empty strings and reserved object names) are preserved. Additional JSON-compatible fields are snapshotted but not interpreted by the FSM. The compiler accepts plain objects (including null-prototype objects), dense arrays, JSON primitives, and optional undefined values. It rejects accessors, cycles in the input data, exotic objects, enumerable symbol keys, and unsupported values rather than silently losing data or invoking getters. Non-enumerable fields are not definition data. The JSON input contract is not a general JavaScript object-cloning contract.

A portable draft-07 JSON Schema is shipped at `@deviltea/tiny-state-machine/schema.json`. Use it for editor autocomplete and structural validation. JSON Schema cannot verify that a dynamic initial or target string names an existing state; use `defineMachine` for those semantic checks. The schema is maintained directly, with Ajv/fast-check contract tests comparing its structural acceptance to the compiler. The core has no runtime dependencies.

### Factory runtime and migration

The public `Machine<Config, Context>` is now a TypeScript interface, not a runtime class. Use `import type { Machine }` for type annotations and `createMachine(validDefinition, context?)` for construction; `new Machine(...)` and `instanceof Machine` are no longer supported. The factory returns an object with closure-backed methods, so destructuring `send`, `can`, subscriptions, or `destroy` does not require binding a receiver. Non-final transition payloads expose the instance’s send function directly. The interface is structural; TypeScript conformance alone is not proof of factory origin.

Previously `createMachine(rawConfig)` and `new Machine(rawConfig, context)` accepted unvalidated configurations. First call `defineMachine(rawConfig)`, check `valid` (or assert it), then pass the resulting definition to the factory. To edit a valid configuration, create and validate new data rather than mutate the snapshot. Persist or transmit `definition.data`, not the definition wrapper.

## Runtime contract

- Only genuine valid definitions are accepted; no configuration validation or compilation occurs during construction. Context factories are not invoked for invalid or forged definitions.
- `machine.can(event)` tests whether the current state accepts an event. Unknown events are ignored by `send`; self-transitions are observable transitions.
- Observers receive a read-only transition record and payload after the new state is committed. Filters combine all specified fields with AND. A target declared as `{ type: 'final' }` always yields `send: null`.
- Nested sends are queued in FIFO order; every observer sees the current transition before the next transition runs. The outermost send drains the queue synchronously. The bound send function operates on the machine's current state, not a captured state.
- Synchronous observer exceptions are collected and rethrown after notifications and queued work complete (one error by identity, multiple as an AggregateError). Asynchronous handlers are not awaited and must handle their own rejections.
- Destroying during a transition defers destruction until that notification completes and discards pending events. Before-destroy observers may read state/context but cannot send or register new handlers. After-destroy observers run after cleanup. Cleanup completes even when observers throw.

## Verification

The workspace uses Vitest, fast-check property-based tests (generated machine graphs, event sequences, and JSON schema contract cases), Ajv as an independent structural validator, and StrykerJS mutation testing. Run `pnpm test:mutation` from the repository root; the report covers the core and Vue adapter.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/tiny-state-machine/core/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/tiny-state-machine
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/tiny-state-machine
[bundle-src]: https://img.shields.io/bundlephobia/minzip/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=@deviltea/tiny-state-machine
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
