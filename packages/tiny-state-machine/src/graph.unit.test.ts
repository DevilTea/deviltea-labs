import type { MachineConfig } from './index'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { assertValidDefinition, createMachine, defineMachine, getDeadEndStates, getEvents, getFinalStates, getReachableStates, getStates, getTransitions, getUnreachableStates, transition } from './index'

const graph = defineMachine({
	initial: 'idle',
	states: {
		idle: { on: { start: 'running', stall: 'stuck' } },
		running: { on: { stop: 'idle', retry: 'running', finish: 'done' } },
		done: { type: 'final' },
		stuck: {},
		orphan: { on: { go: 'done' } },
		unused: { type: 'final', on: {} },
	},
})
assertValidDefinition(graph)

describe('pure graph operations', () => {
	it('returns ordered states, local events, exact edges and explicit finals', () => {
		expect(getStates(graph))
			.toEqual(['idle', 'running', 'done', 'stuck', 'orphan', 'unused'])
		expect(getEvents(graph, 'running'))
			.toEqual(['stop', 'retry', 'finish'])
		expect(getEvents(graph, 'done'))
			.toEqual([])
		expect(getTransitions(graph))
			.toEqual([
				{ source: 'idle', event: 'start', target: 'running' },
				{ source: 'idle', event: 'stall', target: 'stuck' },
				{ source: 'running', event: 'stop', target: 'idle' },
				{ source: 'running', event: 'retry', target: 'running' },
				{ source: 'running', event: 'finish', target: 'done' },
				{ source: 'orphan', event: 'go', target: 'done' },
			])
		expect(getFinalStates(graph))
			.toEqual(['done', 'unused'])
		expect(getDeadEndStates(graph))
			.toEqual(['stuck'])
		expectTypeOf(getEvents(graph, 'running'))
			.toEqualTypeOf<('stop' | 'retry' | 'finish')[]>()
		expectTypeOf(getStates(graph))
			.toEqualTypeOf<('idle' | 'running' | 'done' | 'stuck' | 'orphan' | 'unused')[]>()
		const _edges = getTransitions(graph)
		expectTypeOf<Extract<(typeof _edges)[number], { source: 'idle', event: 'start' }>['target']>()
			.toEqualTypeOf<'running'>()
	})

	it('handles cycles, self-transitions, isolated nodes and explicit start states', () => {
		expect(getReachableStates(graph))
			.toEqual(['idle', 'running', 'stuck', 'done'])
		expect(getUnreachableStates(graph))
			.toEqual(['orphan', 'unused'])
		expect(getReachableStates(graph, 'orphan'))
			.toEqual(['orphan', 'done'])
		expect(getReachableStates(graph, 'unused'))
			.toEqual(['unused'])
		expect(getUnreachableStates(graph, 'orphan'))
			.toEqual(['idle', 'running', 'stuck', 'unused'])
		expect(getReachableStates(graph, 'running'))
			.toEqual(['running', 'idle', 'done', 'stuck'])
	})

	it('resolves transitions without mutating definition or a running instance', () => {
		const snapshot = JSON.stringify(graph)
		const machine = createMachine(graph)
		expect(transition(graph, 'idle', 'start'))
			.toBe('running')
		expect(transition(graph, 'running', 'retry'))
			.toBe('running')
		expect(transition(graph, 'done', 'start'))
			.toBeUndefined()
		expect(transition(graph, 'idle', 'finish'))
			.toBeUndefined()
		expect(transition(graph, 'idle', 'toString'))
			.toBeUndefined()
		expect(machine.currentState)
			.toBe('idle')
		expect(JSON.stringify(graph))
			.toBe(snapshot)
	})

	it('rejects untrusted definitions and unknown source states', () => {
		const invalid = defineMachine({ initial: 'a', states: { a: { on: { go: 'missing' } } } })
		for (const inspect of [getStates, getTransitions, getFinalStates, getDeadEndStates, getReachableStates, getUnreachableStates]) {
			expect(() => inspect(invalid as never))
				.toThrow('Expected a valid definition produced by defineMachine().')
		}
		for (const inspect of [
			() => getEvents(graph, 'unknown' as never),
			() => transition(graph, 'unknown' as never, 'start'),
			() => getReachableStates(graph, 'unknown' as never),
			() => getUnreachableStates(graph, 'unknown' as never),
		]) {
			expect(inspect)
				.toThrow('Unknown state: unknown.')
		}
	})

	it('agrees with an independent edge-list and fixed-point reachability oracle', () => {
		const key = fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom('', '__proto__', 'constructor', 'prototype', 'toString'))
		const generated = fc.uniqueArray(key, { minLength: 1, maxLength: 7 })
			.chain(keys =>
				fc.array(fc.record({
					final: fc.boolean(),
					edges: fc.uniqueArray(fc.tuple(key, fc.constantFrom(...keys)), { selector: ([event]) => event, maxLength: 5 }),
				}), { minLength: keys.length, maxLength: keys.length })
					.chain(nodes =>
						fc.constantFrom(...keys)
							.map(initial => ({ keys, nodes, initial }))))
		fc.assert(fc.property(generated, ({ keys, nodes, initial }) => {
			const edges = keys.flatMap((source, i) => nodes[i]!.final ? [] : nodes[i]!.edges.map(([event, target]) => ({ source, event, target })))
			const config: MachineConfig = {
				initial,
				states: Object.fromEntries(keys.map((key, i) => [key, nodes[i]!.final ? { type: 'final' } : { on: Object.fromEntries(nodes[i]!.edges) }])),
			}
			const definition = defineMachine(config)
			assertValidDefinition(definition)
			// Fixed point over an independently generated edge list, not the library traversal.
			const reachable = new Set([initial])
			for (let i = 0; i < keys.length; i++) {
				for (const edge of edges) {
					if (reachable.has(edge.source))
						reachable.add(edge.target)
				}
			}
			expect(new Set(getStates(definition)))
				.toEqual(new Set(keys))
			expect(new Set(getTransitions(definition)
				.map(edge => JSON.stringify(edge))))
				.toEqual(new Set(edges.map(edge => JSON.stringify(edge))))
			expect(new Set(getReachableStates(definition)))
				.toEqual(reachable)
			expect(new Set(getUnreachableStates(definition)))
				.toEqual(new Set(keys.filter(key => !reachable.has(key))))
			expect(new Set(getFinalStates(definition)))
				.toEqual(new Set(keys.filter((_, i) => nodes[i]!.final)))
			expect(new Set(getDeadEndStates(definition)))
				.toEqual(new Set(keys.filter((_, i) => !nodes[i]!.final && nodes[i]!.edges.length === 0)))
			for (const source of keys) {
				const outgoing = edges.filter(edge => edge.source === source)
				expect(new Set(getEvents(definition, source)))
					.toEqual(new Set(outgoing.map(edge => edge.event)))
				for (const edge of outgoing) {
					expect(transition(definition, source, edge.event))
						.toBe(edge.target)
				}
			}
		}), { seed: 20261126, numRuns: 200 })
	})
})
