import type { MachineConfig } from './index'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createMachine, Machine } from './index'

const workflow = {
	initial: 'idle',
	states: {
		idle: { on: { start: 'working', skip: 'done' } },
		working: { on: { finish: 'done', retry: 'working', cancel: 'idle' } },
		done: { type: 'final' },
	},
} as const

const properties = { numRuns: 200, seed: 20261126 }
const stateKey = fc.oneof(fc.string({ maxLength: 10 }), fc.constantFrom('', '__proto__', 'toString', 'constructor', 'hasOwnProperty'))
const eventKey = stateKey
const graph = fc.uniqueArray(stateKey, { minLength: 1, maxLength: 8 })
	.chain(keys =>
		fc.array(fc.record({
			final: fc.boolean(),
			edges: fc.uniqueArray(fc.tuple(eventKey, fc.constantFrom(...keys)), { selector: ([event]) => event, maxLength: 6 }),
		}), { minLength: keys.length, maxLength: keys.length })
			.chain((nodes) => {
				const initial = fc.constantFrom(...keys)
				const edges = keys.flatMap((source, index) => nodes[index]!.final
					? []
					: nodes[index]!.edges.map(([event, target]) => ({ source, event, target })))
				const events = edges.map(edge => edge.event)
				const states = Object.fromEntries(keys.map((key, index) => [
					key,
					nodes[index]!.final ? { type: 'final' as const } : { on: Object.fromEntries(nodes[index]!.edges) },
				]))
				return fc.record({
					config: initial.map(initial => ({ initial, states }) satisfies MachineConfig),
					sequence: fc.array(events.length ? fc.oneof(eventKey, fc.constantFrom(...events)) : eventKey, { maxLength: 50 }),
					filter: fc.record({
						source: fc.option(fc.constantFrom(...keys), { nil: undefined }),
						event: fc.option(events.length ? fc.constantFrom(...events) : eventKey, { nil: undefined }),
						target: fc.option(fc.constantFrom(...keys), { nil: undefined }),
					}, { requiredKeys: [] }),
				})
					.map(value => ({ ...value, edges, keys }))
			}))

describe('state transition properties', () => {
	it('matches an independent edge-list model, including notification and filter semantics', () => fc.assert(fc.property(graph, ({ config, sequence, edges, keys, filter }) => {
		const machine = createMachine(config)
		const other = createMachine(config)
		const seen: unknown[] = []
		const filtered: unknown[] = []
		const expected: unknown[] = []
		const expectedFiltered: unknown[] = []
		let state = config.initial
		machine.onTransition(({ transition, machine: received, context, send }) => {
			expect(received)
				.toBe(machine)
			expect(context)
				.toBeNull()
			expect(machine.currentState)
				.toBe(transition.target)
			expect(Object.isFrozen(transition))
				.toBe(true)
			expect(send === null)
				.toBe(config.states[transition.target]?.type === 'final')
			seen.push(transition)
		})
		// Generated filters deliberately include impossible combinations and omissions.
		machine.onTransition(filter as never, ({ transition }) => filtered.push(transition))
		for (const event of sequence) {
			const edge = edges.find(edge => edge.source === state && edge.event === event)
			expect(machine.can(event))
				.toBe(edge !== undefined)
			machine.send(event)
			other.send(event)
			if (edge) {
				state = edge.target
				expected.push(edge)
				if (Object.entries(filter)
					.every(([key, value]) => value === undefined || edge[key as keyof typeof edge] === value)) {
					expectedFiltered.push(edge)
				}
			}
			expect(keys)
				.toContain(machine.currentState)
			expect(machine.currentState)
				.toBe(state)
			expect(other.currentState)
				.toBe(state)
		}
		expect(seen)
			.toEqual(expected)
		expect(filtered)
			.toEqual(expectedFiltered)
	}), properties))

	it('processes nested events in FIFO order for every observer', () => fc.assert(fc.property(fc.array(fc.constantFrom('start', 'finish', 'retry', 'cancel', 'skip', 'invalid'), { maxLength: 40 }), (events) => {
		const machine = createMachine(workflow)
		const reference = createMachine(workflow)
		const expected: unknown[] = []
		const observed: unknown[] = []
		reference.onTransition(({ transition }) => expected.push(transition))
		reference.send('start')
		for (const event of events)
			reference.send(event as never)
		machine.onTransition({ source: 'idle', event: 'start' }, ({ machine }) => {
			// Only the initial event enqueues, not later transitions.
			if (observed.length === 0) {
				for (const event of events)
					machine.send(event as never)
				expect(machine.currentState)
					.toBe('working')
			}
		})
		machine.onTransition(({ transition }) => {
			expect(machine.currentState)
				.toBe(transition.target)
			observed.push(transition)
		})
		machine.send('start')
		expect(observed)
			.toEqual(expected)
		expect(machine.currentState)
			.toBe(reference.currentState)
	}), properties))
})

describe('configuration and context', () => {
	it('supports context identity, a factory, and absent context', () => {
		const context = { count: 1 }
		const factory = vi.fn(() => context)
		expect(createMachine(workflow, context).context)
			.toBe(context)
		expect(createMachine(workflow, factory).context)
			.toBe(context)
		expect(factory)
			.toHaveBeenCalledExactlyOnceWith()
		expect(createMachine(workflow).context)
			.toBeNull()
		expect(createMachine(workflow, undefined).context)
			.toBeNull()
		expect(createMachine(workflow, null).context)
			.toBeNull()
	})

	it.each([
		[null, 'Invalid machine configuration.'],
		[[], 'Invalid machine configuration.'],
		[{ initial: 'a', states: [] }, 'Invalid machine configuration.'],
		[{ initial: 1, states: {} }, 'Invalid machine configuration.'],
		[{ initial: 'missing', states: { a: {} } }, 'Invalid initial state: missing.'],
		[{ initial: 'a', states: { a: null } }, 'Invalid state: a.'],
		[{ initial: 'a', states: { a: 'not an object' } }, 'Invalid state: a.'],
		[{ initial: 'a', states: { a: { type: 'other' } } }, 'Invalid state: a.'],
		[{ initial: 'a', states: { a: { on: [] } } }, 'Invalid transitions for state: a.'],
		[{ initial: 'a', states: { a: { on: { go: 1 } } } }, 'Invalid transition: a -> go.'],
		[{ initial: 'a', states: { a: { on: { go: 1 } }, 1: {} } }, 'Invalid transition: a -> go.'],
		[{ initial: 'a', states: { a: { on: { go: 'toString' } } } }, 'Invalid transition: a -> go.'],
		[{ initial: 'a', states: { a: { type: 'final', on: { go: 'a' } } } }, 'Final state cannot have transitions: a.'],
	])('rejects invalid data at the public runtime boundary: %j', (config, message) => {
		expect(() => new Machine(config as never, null))
			.toThrow(message)
	})

	it('snapshots the graph independently of subsequent config mutations', () => {
		const config: MachineConfig = { initial: 'a', states: { a: { on: { go: 'b' } }, b: {} } }
		const machine = createMachine(config)
		config.states.a!.on!.go = 'a'
		machine.send('go')
		expect(machine.currentState)
			.toBe('b')
		expect(createMachine(config).currentState)
			.toBe('a')
	})
	it('does not recognize inherited events, but accepts explicitly declared special keys', () => {
		const machine = createMachine(workflow)
		machine.send('toString' as never)
		expect(machine.currentState)
			.toBe('idle')
		const special = createMachine({ initial: 'a', states: { a: { on: { ['__proto__']: 'constructor' } }, constructor: {} } })
		special.send('__proto__')
		expect(special.currentState)
			.toBe('constructor')
	})
})

describe('notifications and lifecycle', () => {
	it('uses immutable shared payloads and consistently supplies null in final states', () => {
		const machine = createMachine(workflow, { count: 1 })
		const observed: unknown[] = []
		machine.onTransition({ target: 'done' }, (payload) => {
			expect(Object.isFrozen(payload))
				.toBe(true)
			expect(payload.context)
				.toBe(machine.context)
			expect(payload.send)
				.toBeNull()
			observed.push(payload)
		})
		machine.onTransition(payload => observed.push(payload))
		machine.send('skip')
		expect(observed)
			.toHaveLength(2)
		expect(observed[0])
			.toBe(observed[1])
		expect(observed[0])
			.toMatchObject({ transition: { source: 'idle', event: 'skip', target: 'done' }, send: null })
		machine.send('start')
		expect(machine.currentState)
			.toBe('done')
		expect(observed)
			.toHaveLength(2)
	})

	it('snapshots filters, skips removed subscriptions, and delays newly added subscriptions', () => {
		const machine = createMachine(workflow)
		const calls: string[] = []
		let stop: () => void
		const filter: { source: 'idle' | 'working' } = { source: 'idle' }
		machine.onTransition(filter, () => calls.push('filtered'))
		filter.source = 'working'
		machine.onTransition(() => {
			calls.push('first')
			stop()
			machine.onTransition(() => calls.push('new'))
		})
		stop = machine.onTransition(() => calls.push('removed'))
		machine.send('start')
		expect(calls)
			.toEqual(['filtered', 'first'])
		machine.send('retry')
		expect(calls)
			.toEqual(['filtered', 'first', 'first', 'new'])
		stop()
	})

	it('notifies all observers and drains queued work even after synchronous errors', () => {
		const machine = createMachine(workflow)
		const a = new Error('first')
		const b = new Error('second')
		machine.onTransition({ event: 'start' }, ({ send }) => {
			send('finish')
			throw a
		})
		machine.onTransition({ event: 'start' }, () => {
			throw b
		})
		const listener = vi.fn()
		machine.onTransition(listener)
		try {
			machine.send('start')
			expect.unreachable()
		}
		catch (error) {
			expect(error)
				.toBeInstanceOf(AggregateError)
			expect((error as AggregateError).errors)
				.toEqual([a, b])
			expect((error as AggregateError).message)
				.toBe('Multiple machine handlers failed.')
		}
		expect(listener)
			.toHaveBeenCalledTimes(2)
		expect(machine.currentState)
			.toBe('done')
	})

	it('rethrows a single error by identity and accepts later events', () => {
		const machine = createMachine(workflow)
		const error = new Error('single')
		machine.onTransition({ event: 'start' }, () => {
			throw error
		})
		expect(() => machine.send('start'))
			.toThrow(error)
		machine.send('finish')
		expect(machine.currentState)
			.toBe('done')
	})

	it('defers destruction during notification, discards queued events, and cleans up after errors', () => {
		const machine = createMachine(workflow)
		const calls: string[] = []
		const error = new Error('before')
		const unsubscribe = machine.onTransition(({ machine }) => {
			machine.send('finish')
			machine.destroy()
			expect(machine.isDestroyed)
				.toBe(false)
		})
		machine.onTransition(({ transition }) => calls.push(transition.event))
		machine.onBeforeDestroyed((received) => {
			expect(received)
				.toBe(machine)
			expect(machine.currentState)
				.toBe('working')
			expect(machine.context)
				.toBeNull()
			expect(() => machine.send('retry'))
				.toThrow('The machine is being destroyed.')
			expect(() => machine.destroy())
				.toThrow('The machine is being destroyed.')
			expect(() => machine.onTransition(() => {}))
				.toThrow('The machine is being destroyed.')
			expect(() => machine.onBeforeDestroyed(() => {}))
				.toThrow('The machine is being destroyed.')
			expect(() => machine.onAfterDestroyed(() => {}))
				.toThrow('The machine is being destroyed.')
			calls.push('before')
			throw error
		})
		machine.onBeforeDestroyed(() => calls.push('before2'))
		machine.onAfterDestroyed(() => {
			expect(machine.isDestroyed)
				.toBe(true)
			calls.push('after')
		})
		expect(() => machine.send('start'))
			.toThrow(error)
		expect(calls)
			.toEqual(['start', 'before', 'before2', 'after'])
		expect(machine.isDestroyed)
			.toBe(true)
		for (const operation of [
			() => machine.currentState,
			() => machine.context,
			() => machine.can('start'),
			() => machine.send('start'),
			() => machine.onTransition(() => {}),
			() => machine.onBeforeDestroyed(() => {}),
			() => machine.onAfterDestroyed(() => {}),
			() => machine.destroy(),
		]) {
			expect(operation)
				.toThrow('The machine has been destroyed.')
		}
		expect(unsubscribe).not.toThrow()
	})

	it('supports direct destruction, removing lifecycle subscriptions, and multiple lifecycle errors', () => {
		const machine = createMachine(workflow)
		const removed = vi.fn()
		const stopBefore = machine.onBeforeDestroyed(removed)
		const stopAfter = machine.onAfterDestroyed(removed)
		stopBefore()
		stopAfter()
		const a = new Error('before')
		const b = new Error('after')
		machine.onBeforeDestroyed(() => {
			throw a
		})
		machine.onAfterDestroyed(() => {
			throw b
		})
		expect(() => machine.destroy())
			.toThrow(AggregateError)
		expect(machine.isDestroyed)
			.toBe(true)
		expect(removed).not.toHaveBeenCalled()
		stopBefore()
		stopAfter()
	})
})

it('infers public state, event, context and target-specific handler types', () => {
	const machine = createMachine(workflow, { count: 1 })
	expectTypeOf(machine.currentState)
		.toEqualTypeOf<'idle' | 'working' | 'done'>()
	expectTypeOf(machine.send)
		.parameter(0)
		.toEqualTypeOf<'start' | 'skip' | 'finish' | 'retry' | 'cancel'>()
	expectTypeOf(machine.context)
		.toMatchTypeOf<{ count: number }>()
	machine.onTransition({ target: 'working' }, ({ send, transition }) => {
		expectTypeOf(send)
			.parameter(0)
			.toEqualTypeOf<'finish' | 'retry' | 'cancel'>()
		expectTypeOf(transition.target)
			.toEqualTypeOf<'working'>()
	})
	machine.onTransition({ target: 'done' }, ({ send }) => expectTypeOf(send)
		.toEqualTypeOf<null>())
	// @ts-expect-error source/event combination does not exist in the graph
	machine.onTransition({ source: 'idle', event: 'finish' }, () => {})
	const invalid = () => {
		// @ts-expect-error unknown initial state
		createMachine({ initial: 'missing', states: { a: {} } })
		// @ts-expect-error unknown transition target
		createMachine({ initial: 'a', states: { a: { on: { go: 'missing' } } } })
		// @ts-expect-error final states cannot have outgoing edges
		createMachine({ initial: 'a', states: { a: { type: 'final', on: { go: 'a' } } } })
		// @ts-expect-error unknown event
		machine.send('unknown')
	}
	expectTypeOf(invalid)
		.toBeFunction()
})
