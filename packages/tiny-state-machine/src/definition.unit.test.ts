import type { Definition, DiagnosticCode, MachineConfig, ValidDefinition } from './index'
import Ajv from 'ajv'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import schema from '../schema.json'
import { assertValidDefinition, createMachine, defineMachine, getEvents, getReachableStates, getStates, getTransitions, Machine, transition } from './index'

const config = {
	initial: 'idle',
	states: {
		idle: { on: { start: 'done' } },
		done: { type: 'final' },
	},
} as const

describe('definition boundary', () => {
	it('preserves literal types and exposes only validated, deeply readonly snapshots', () => {
		const definition = defineMachine(config)
		expectTypeOf(definition)
			.toEqualTypeOf<Definition<typeof config>>()
		const invalidUses = () => {
			// @ts-expect-error definition must be narrowed
			createMachine(definition)
			// @ts-expect-error definition must be narrowed
			getStates(definition)
			// @ts-expect-error a structurally identical object lacks the private brand
			const forged: ValidDefinition<typeof config> = { valid: true, data: config, diagnostics: [] }
			return forged
		}
		expectTypeOf(invalidUses)
			.toBeFunction()
		assertValidDefinition(definition)
		expect(definition.valid)
			.toBe(true)
		expect(definition.diagnostics)
			.toEqual([])
		expect(definition.data)
			.toEqual(config)
		expect(definition.data).not.toBe(config)
		expectTypeOf(definition.data.states.idle.on.start)
			.toEqualTypeOf<'done'>()
		const a = createMachine(definition)
		const b = new Machine(definition, null)
		a.send('start')
		expect(a.currentState)
			.toBe('done')
		expect(b.currentState)
			.toBe('idle')
		expectTypeOf(a.send)
			.parameter(0)
			.toEqualTypeOf<'start'>()
		const mutate = () => {
			// @ts-expect-error immutable snapshot
			definition.data.initial = 'idle'
			// @ts-expect-error immutable snapshot
			definition.data.states.idle.on.start = 'done'
		}
		expectTypeOf(mutate)
			.toBeFunction()
	})

	it('snapshots mutable inputs and metadata, shares graph safely across destroyed instances', () => {
		const input = {
			id: 'test',
			initial: 'a' as 'a' | 'b',
			states: { a: { on: { go: 'b' as 'a' | 'b' } }, b: {} },
			metadata: { labels: ['first', 'second'], nested: { value: 3 } },
		} satisfies MachineConfig & { metadata: object }
		const definition = defineMachine(input)
		assertValidDefinition(definition)
		const a = createMachine(definition)
		const b = createMachine(definition)
		input.initial = 'b'
		input.states.a.on.go = 'a'
		input.metadata.labels[0] = 'changed'
		input.metadata.nested.value = 8
		expect(definition.data.initial)
			.toBe('a')
		expect(definition.data.states.a.on.go)
			.toBe('b')
		expect(definition.data.metadata)
			.toEqual({ labels: ['first', 'second'], nested: { value: 3 } })
		for (const object of [definition, definition.diagnostics, definition.data, definition.data.states, definition.data.states.a, definition.data.states.a.on, definition.data.metadata, definition.data.metadata.labels, definition.data.metadata.nested]) {
			expect(Object.isFrozen(object))
				.toBe(true)
		}
		a.destroy()
		b.send('go')
		expect(b.currentState)
			.toBe('b')
		b.destroy()
		expect(getTransitions(definition))
			.toEqual([{ source: 'a', event: 'go', target: 'b' }])
		expect(createMachine(definition).currentState)
			.toBe('a')
		const edges = getTransitions(definition)
		edges.length = 0
		expect(getTransitions(definition))
			.toHaveLength(1)
		expect(transition(definition, 'a', 'go'))
			.toBe('b')
	})

	it('rejects invalid and forged definitions at every consumption boundary before executing a context factory', () => {
		const invalid = defineMachine({ initial: 'missing', states: {} })
		const valid = defineMachine(config)
		assertValidDefinition(valid)
		for (const value of [undefined, null, 42, config, invalid, { valid: true, data: config, diagnostics: [] }, { ...valid }, JSON.parse(JSON.stringify(valid))]) {
			const factory = vi.fn(() => ({}))
			for (const consume of [
				() => assertValidDefinition(value as never),
				() => createMachine(value as never, factory),
				() => new Machine(value as never, null),
				() => getStates(value as never),
				() => getEvents(value as never, 'idle'),
				() => getTransitions(value as never),
				() => transition(value as never, 'idle', 'start'),
				() => getReachableStates(value as never),
			]) {
				expect(consume)
					.toThrow('Expected a valid definition produced by defineMachine().')
			}
			expect(factory).not.toHaveBeenCalled()
		}
	})

	it('keeps all reserved own keys and optional undefined fields', () => {
		const input: unknown = JSON.parse('{"initial":"__proto__","states":{"__proto__":{"on":{"constructor":"prototype"}},"prototype":{"on":{"__proto__":""}},"":{"on":{"":"constructor"}},"constructor":{"type":"final"}}}')
		const definition = defineMachine(input)
		assertValidDefinition(definition)
		expect(Object.keys(definition.data.states))
			.toEqual(['__proto__', 'prototype', '', 'constructor'])
		expect(getStates(definition))
			.toEqual(['__proto__', 'prototype', '', 'constructor'])
		const machine = createMachine(definition)
		for (const event of ['constructor', '__proto__', ''])
			machine.send(event)
		expect(machine.currentState)
			.toBe('constructor')
		const optional = defineMachine({ id: undefined, initial: '', states: { '': { on: undefined, type: undefined }, 'end': { type: 'final', on: {} } } })
		assertValidDefinition(optional)
		expect(optional.data.id)
			.toBeUndefined()
		expect(Object.hasOwn(optional.data, 'id'))
			.toBe(true)
	})

	it('reports stable codes, precise paths, and immutable diagnostics without throwing or editing input', () => {
		const input = JSON.parse('{"id":1,"initial":"missing","states":{"a":{"on":{"bad":"missing","__proto__":1}},"b":{"type":"final","on":{"go":"a"}},"constructor":null,"broken":{"on":[]},"wrong":{"type":"nested"}}}')
		const before = JSON.stringify(input)
		const definition = defineMachine(input)
		expect(definition.valid)
			.toBe(false)
		expect(definition.data)
			.toBe(input)
		expect(definition.diagnostics.map(({ code, path }) => [code, path]))
			.toEqual([
				['INVALID_ID', ['id']],
				['UNKNOWN_TRANSITION_TARGET', ['states', 'a', 'on', 'bad']],
				['INVALID_TRANSITION_TARGET', ['states', 'a', 'on', '__proto__']],
				['FINAL_STATE_HAS_TRANSITIONS', ['states', 'b', 'on']],
				['INVALID_STATE', ['states', 'constructor']],
				['INVALID_TRANSITIONS', ['states', 'broken', 'on']],
				['INVALID_STATE_TYPE', ['states', 'wrong', 'type']],
				['UNKNOWN_INITIAL_STATE', ['initial']],
			])
		expect(definition.diagnostics[1])
			.toEqual({ code: 'UNKNOWN_TRANSITION_TARGET', path: ['states', 'a', 'on', 'bad'], severity: 'error', message: 'Unknown transition target: missing.' })
		expect(Object.isFrozen(definition))
			.toBe(true)
		expect(Object.isFrozen(definition.diagnostics))
			.toBe(true)
		for (const diagnostic of definition.diagnostics) {
			expect(Object.isFrozen(diagnostic))
				.toBe(true)
			expect(Object.isFrozen(diagnostic.path))
				.toBe(true)
		}
		expect(JSON.stringify(input))
			.toBe(before)
	})

	it.each<[unknown, DiagnosticCode]>([
		[null, 'INVALID_CONFIG'],
		[[], 'INVALID_CONFIG'],
		[undefined, 'INVALID_CONFIG'],
		[{ initial: 1, states: {} }, 'INVALID_INITIAL'],
		[{ initial: 'a', states: [] }, 'INVALID_STATES'],
		[{ initial: 'a' }, 'INVALID_STATES'],
		[{ initial: 'a', states: { a: [] } }, 'INVALID_STATE'],
		[{ initial: 'toString', states: {} }, 'UNKNOWN_INITIAL_STATE'],
		[{ initial: 'a', states: { a: { on: { go: 'constructor' } } } }, 'UNKNOWN_TRANSITION_TARGET'],
		[{ initial: 'a', states: Object.defineProperty({ a: { on: { go: 'hidden' } } }, 'hidden', { value: {} }) }, 'UNKNOWN_TRANSITION_TARGET'],
	])('rejects malformed configuration %#', (input, code) => {
		const result = defineMachine(input)
		expect(result.valid)
			.toBe(false)
		expect(result.diagnostics.map(d => d.code))
			.toContain(code)
	})

	it('does not execute accessors or trust exotic, cyclic or non-JSON data', () => {
		const getter = vi.fn(() => 'idle')
		const accessor = Object.defineProperty({ states: config.states }, 'initial', { enumerable: true, get: getter })
		const cyclic: Record<string, unknown> = { ...config }
		cyclic.self = cyclic
		const hidden = Object.create({ initial: 'idle', states: config.states })
		const sparse = Array.from({ length: 2 })
		delete sparse[0]
		const extra = Object.assign([], { extra: 1 })
		for (const input of [
			accessor,
			cyclic,
			hidden,
			{ ...config, meta: new Date() },
			{ ...config, meta: new Map() },
			{ ...config, meta: () => {} },
			{ ...config, meta: Symbol('x') },
			{ ...config, meta: 1n },
			{ ...config, meta: Number.POSITIVE_INFINITY },
			{ ...config, meta: sparse },
			{ ...config, meta: extra },
			{ ...config, [Symbol('x')]: 1 },
			new Proxy(config, { ownKeys() { throw new Error('trap') } }),
		]) {
			const result = defineMachine(input)
			expect(result.valid)
				.toBe(false)
			expect(result.diagnostics[0]?.code)
				.toBe('INVALID_DATA')
		}
		expect(getter).not.toHaveBeenCalled()
		const result = defineMachine(Object.assign(Object.create(null), config))
		expect(result.valid)
			.toBe(true)
	})

	it('accepts cycles in the graph, unreachable states, non-final dead ends and no final states', () => {
		const result = defineMachine({ initial: 'a', states: { a: { on: { loop: 'a' } }, b: {} } })
		expect(result.valid)
			.toBe(true)
		expect(result.diagnostics)
			.toEqual([])
	})
})

describe('portable JSON schema contract', () => {
	const validate = new Ajv({ ownProperties: true })
		.compile(schema)
	function matchesStructure(input: unknown) {
		const result = defineMachine(input)
		const structuralErrors = result.diagnostics.filter(d => d.code !== 'UNKNOWN_INITIAL_STATE' && d.code !== 'UNKNOWN_TRANSITION_TARGET')
		expect(structuralErrors.length === 0)
			.toBe(validate(input))
		if (result.valid) {
			expect(result.data)
				.toEqual(input)
		}
	}

	it('agrees with Ajv on generated JSON and targeted structural mutations', () => {
		const key = fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom('', '__proto__', 'prototype', 'constructor', 'toString'))
		const state = fc.oneof(
			fc.jsonValue(),
			fc.record({ type: fc.constant('final'), on: fc.dictionary(key, fc.jsonValue()) }),
			fc.record({ on: fc.dictionary(key, fc.oneof(key, fc.jsonValue())) }),
			fc.constant({ type: 'final', on: {} }),
			fc.constant({}),
		)
		const configs = fc.record({ initial: fc.oneof(key, fc.jsonValue()), states: fc.oneof(fc.dictionary(key, state), fc.jsonValue()), id: fc.oneof(key, fc.jsonValue()) }, { requiredKeys: ['initial', 'states'] })
		fc.assert(fc.property(fc.oneof(fc.jsonValue(), configs), matchesStructure), { seed: 20261126, numRuns: 500 })
	})

	it('explicitly distinguishes structural acceptance from cross-reference errors', () => {
		for (const input of [
			{ initial: 'missing', states: {} },
			{ initial: 'a', states: { a: { on: { go: 'missing' } } } },
		]) {
			expect(validate(input))
				.toBe(true)
			expect(defineMachine(input).valid)
				.toBe(false)
		}
		for (const input of [
			config,
			JSON.parse('{"initial":"__proto__","states":{"__proto__":{"on":{"constructor":"prototype"}},"prototype":{"type":"final"}}}'),
			{ initial: 'a', states: { a: { type: 'final', on: {} } } },
			{ initial: 'a', states: { a: { type: 'final', on: { go: 'a' } } } },
			{ initial: 'a', states: { a: { on: [] } } },
			{ initial: 'a', states: { a: { on: { go: 1 } } } },
			{ initial: 'a', states: { a: { type: 'nested' } } },
		])
			matchesStructure(input)
	})
})
