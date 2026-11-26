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
import { createMachine } from '@deviltea/tiny-state-machine'

// Define a simple state machine with three states: idle, loading, and finished
const machine = createMachine({
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
import { createMachine } from '@deviltea/tiny-state-machine'

const machine = createMachine({
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

A definition remains a flat JSON-compatible adjacency map. Define it separately from its runtime instances:

```ts
import { createMachine, defineMachine, getReachableStates, getTransitions, transition } from '@deviltea/tiny-state-machine'

const definition = defineMachine({
	initial: 'idle',
	states: {
		idle: { on: { start: 'running' } },
		running: { on: { finish: 'done' } },
		done: { type: 'final' },
		unused: {},
	},
})

const first = createMachine(definition)
const second = createMachine(definition)
first.send('start')
// second.currentState remains 'idle'

getReachableStates(definition) // ['idle', 'running', 'done']
getTransitions(definition) // [{ source: 'idle', event: 'start', target: 'running' }, ...]
transition(definition, 'idle', 'start') // 'running'
transition(definition, 'done', 'start') // undefined
```

`defineMachine` validates the configuration and returns the original object with its exact inferred TypeScript type. It does not freeze, clone, or start a machine. Treat definitions as data; each runtime instance independently validates and snapshots the graph. Graph helpers validate the current input on every call and do not mutate it or execute callbacks.

| Pure function | Result |
| --- | --- |
| `getStates(config)` | State keys |
| `getEvents(config, state)` | Events accepted by the specified state |
| `getTransitions(config)` | All typed source/event/target records, including self-transitions |
| `transition(config, state, event)` | Target state, or `undefined` if the event is unavailable |
| `getReachableStates(config, start?)` | Reachable states, including the start, in breadth-first discovery order |
| `getUnreachableStates(config, start?)` | States not reachable from the start |
| `getFinalStates(config)` | Explicitly declared final states |
| `getDeadEndStates(config)` | Non-final states with no outgoing edges, including unreachable ones |

The default traversal start is the initial state. Unknown source states throw. Other lists follow JavaScript own-key enumeration order. Cycles, unreachable states, and non-final dead ends are valid; analysis reports them rather than rejecting the definition. Each helper compiles its input once per call (linear in the size of the graph); the running machine retains its own indexed graph.

## Validation and JSON Schema

```ts
import { machineConfigSchema, parseMachineConfig, safeParseMachineConfig } from '@deviltea/tiny-state-machine'

const result = safeParseMachineConfig(JSON.parse(jsonText))
if (result.success) {
	const machine = createMachine(result.output)
}
else {
	for (const issue of result.issues) {
		console.error(issue.message, issue.path)
	}
}
```

- `machineConfigSchema` is a Valibot schema (also usable through Standard Schema). `parseMachineConfig(input)` throws a Valibot ValiError; `safeParseMachineConfig(input)` returns structured issues without throwing for malformed JSON data. Successful parsing preserves the input object; it does not sanitize or clone it.
- Validation checks the declared shape, string IDs if present, existing initial and target states, and forbids outgoing transitions from explicit final states. Extra fields are not interpreted by the FSM. The runtime and graph helpers use the same validation. Own enumerable state/event keys, including empty strings and reserved object names, are preserved.
- A portable draft-07 JSON Schema is shipped at `@deviltea/tiny-state-machine/schema.json` (package-relative JSON file). Use it for editor autocomplete and structural validation. JSON Schema cannot verify that a dynamic initial or target string names an existing state; use the Valibot schema for those semantic checks. Regenerate the JSON file with `pnpm schema:generate` from this package; a test detects schema drift.
- Valibot is a runtime dependency; its JSON Schema converter is development-only.

## Runtime contract

- The declarative machine definition is validated and copied at construction. Unknown initial states, missing targets, invalid state definitions, and outgoing transitions from explicit final states throw.
- `machine.can(event)` tests whether the current state accepts an event. Unknown events are ignored by `send`; self-transitions are observable transitions.
- Observers receive a read-only transition record and payload after the new state is committed. Filters combine all specified fields with AND. A target declared as `{ type: 'final' }` always yields `send: null`.
- Nested sends are queued in FIFO order; every observer sees the current transition before the next transition runs. The outermost send drains the queue synchronously. The bound send function operates on the machine's current state, not a captured state.
- Synchronous observer exceptions are collected and rethrown after notifications and queued work complete (one error by identity, multiple as an AggregateError). Asynchronous handlers are not awaited and must handle their own rejections.
- Destroying during a transition defers destruction until that notification completes and discards pending events. Before-destroy observers may read state/context but cannot send or register new handlers. After-destroy observers run after cleanup. Cleanup completes even when observers throw.

## Verification

The workspace uses Vitest, fast-check property-based tests (generated machine graphs and event sequences), and StrykerJS mutation testing. Run `pnpm test:mutation` from the repository root; the report covers the core and Vue adapter.

## License

[MIT](https://github.com/DevilTea/deviltea-labs/blob/main/packages/tiny-state-machine/LICENSE) License © 2023-PRESENT [DevilTea](https://github.com/DevilTea)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@deviltea/tiny-state-machine
[npm-downloads-src]: https://img.shields.io/npm/dm/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@deviltea/tiny-state-machine
[bundle-src]: https://img.shields.io/bundlephobia/minzip/@deviltea/tiny-state-machine?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=@deviltea/tiny-state-machine
[license-src]: https://img.shields.io/github/license/DevilTea/deviltea-labs.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/DevilTea/deviltea-labs/blob/main/LICENSE
