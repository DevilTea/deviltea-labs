import type { MachineConfig } from './index'
import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'
import publishedSchema from '../schema.json'
import { machineConfigShape } from './definition'
import { createMachine, defineMachine, machineConfigSchema, parseMachineConfig, safeParseMachineConfig } from './index'

describe('machine definitions', () => {
	it('preserves literal types and identity, and allows independent instances', () => {
		const definition = defineMachine({
			id: 'workflow',
			initial: 'idle',
			states: {
				idle: { on: { start: 'done' } },
				done: { type: 'final' },
			},
		})
		expectTypeOf(definition.initial)
			.toEqualTypeOf<'idle'>()
		expectTypeOf(definition.states.idle.on.start)
			.toEqualTypeOf<'done'>()
		expect(defineMachine(definition))
			.toBe(definition)
		expect(parseMachineConfig(definition))
			.toBe(definition)
		expect(v.parse(machineConfigSchema, definition))
			.toBe(definition)
		const a = createMachine(definition)
		const b = createMachine(definition)
		a.send('start')
		expect(a.currentState)
			.toBe('done')
		expect(b.currentState)
			.toBe('idle')
		expectTypeOf(a.send)
			.parameter(0)
			.toEqualTypeOf<'start'>()
		const invalid = () => {
			// @ts-expect-error unknown target
			defineMachine({ initial: 'a', states: { a: { on: { go: 'missing' } } } })
			// @ts-expect-error unknown initial
			defineMachine({ initial: 'missing', states: { a: {} } })
			// @ts-expect-error final cannot have outgoing edges
			defineMachine({ initial: 'a', states: { a: { type: 'final', on: { go: 'a' } } } })
		}
		expectTypeOf(invalid)
			.toBeFunction()
	})

	it('accepts absent or undefined optional fields and empty final transitions', () => {
		const input = { id: undefined, initial: '', states: { '': { on: undefined, type: undefined }, 'end': { type: 'final', on: {} } } } satisfies MachineConfig
		const result = safeParseMachineConfig(input)
		expect(result.success)
			.toBe(true)
		expect(result.output)
			.toBe(input)
	})

	it('keeps own reserved and empty state/event keys through validation and execution', () => {
		const input = JSON.parse('{"initial":"__proto__","states":{"__proto__":{"on":{"constructor":"prototype"}},"prototype":{"on":{"__proto__":""}},"":{"on":{"":"constructor"}},"constructor":{"type":"final"}}}')
		const definition = parseMachineConfig(input)
		expect(definition)
			.toBe(input)
		expect(Object.keys(definition.states))
			.toEqual(['__proto__', 'prototype', '', 'constructor'])
		const machine = createMachine(definition)
		for (const event of ['constructor', '__proto__', ''])
			machine.send(event)
		expect(machine.currentState)
			.toBe('constructor')
	})

	it('returns structured paths and multiple issues without changing input', () => {
		const input = JSON.parse('{"initial":"missing","states":{"a":{"on":{"bad":"missing","__proto__":1}},"b":{"type":"final","on":{"go":"a"}},"constructor":null,"broken":{"on":[]}}}')
		const before = JSON.stringify(input)
		const result = safeParseMachineConfig(input)
		expect(result.success)
			.toBe(false)
		if (result.success)
			throw new Error('Expected invalid input')
		expect(result.issues.map(issue => [issue.message, issue.path?.map(item => item.key)]))
			.toEqual([
				['Invalid transition: a -> bad.', ['states', 'a', 'on', 'bad']],
				['Invalid transition: a -> __proto__.', ['states', 'a', 'on', '__proto__']],
				['Final state cannot have transitions: b.', ['states', 'b', 'on']],
				['Invalid state: constructor.', ['states', 'constructor']],
				['Invalid transitions for state: broken.', ['states', 'broken', 'on']],
				['Invalid initial state: missing.', ['initial']],
			])
		expect(result.issues[0]?.path?.[0])
			.toEqual({ type: 'object', origin: 'value', input, key: 'states', value: input.states })
		expect(JSON.stringify(input))
			.toBe(before)
		expect(() => parseMachineConfig(input))
			.toThrow('Invalid transition: a -> bad.')
		expect(() => createMachine(input))
			.toThrow('Invalid transition: a -> bad.')
		expect(() => defineMachine(input))
			.toThrow('Invalid transition: a -> bad.')
	})

	it('rejects invalid optional id and non-enumerable targets or initial states', () => {
		expect(safeParseMachineConfig({ id: 1, initial: 'a', states: { a: {} } }).success)
			.toBe(false)
		const states = Object.defineProperty({ a: { on: { go: 'hidden' } } }, 'hidden', { value: {} })
		expect(safeParseMachineConfig({ initial: 'a', states }).success)
			.toBe(false)
		expect(safeParseMachineConfig({ initial: 'hidden', states: Object.defineProperty({}, 'hidden', { value: {} }) }).success)
			.toBe(false)
		expect(safeParseMachineConfig({ initial: 'toString', states: {} }).success)
			.toBe(false)
	})

	it('publishes the generated structural JSON schema without drift', () => {
		expect(publishedSchema)
			.toEqual(toJsonSchema(machineConfigShape))
		expect(publishedSchema.required)
			.toEqual(['initial', 'states'])
		expect(publishedSchema.properties.states.additionalProperties.anyOf[1]?.properties.type)
			.toEqual({ const: 'final' })
	})
})
