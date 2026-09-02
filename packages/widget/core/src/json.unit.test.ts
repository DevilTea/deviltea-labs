import { describe, expect, it } from 'vitest'
import { createWidgetPlugin, createWidgetSystem } from './index'
import { isJsonValue } from './json'

describe('authored JSON runtime domain', () => {
	it('rejects symbol-keyed objects and arrays', () => {
		const object = { value: 1 }
		Object.defineProperty(object, Symbol('malformed'), { value: true })
		const array = [1]
		Object.defineProperty(array, Symbol('malformed'), { value: true })

		expect(isJsonValue(object))
			.toBe(false)
		expect(isJsonValue(array))
			.toBe(false)
	})

	it('rejects named array properties outside indices and length', () => {
		const array = [1]
		Object.defineProperty(array, 'metadata', { value: 'not JSON array material' })

		expect(isJsonValue(array))
			.toBe(false)
	})

	it('fails closed for sparse, accessor-backed, cyclic, custom, and non-finite values', () => {
		const sparse = Array.from({ length: 1 })
		class CustomArray extends Array<number> {}
		const accessor: Record<string, unknown> = {}
		Object.defineProperty(accessor, 'value', { get: () => 1 })
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const custom = Object.create({ inherited: true })
		custom.value = 1

		expect(isJsonValue(sparse))
			.toBe(false)
		expect(isJsonValue(new CustomArray(1)))
			.toBe(false)
		expect(isJsonValue(accessor))
			.toBe(false)
		expect(isJsonValue(cyclic))
			.toBe(false)
		expect(isJsonValue(custom))
			.toBe(false)
		expect(isJsonValue(Number.NaN))
			.toBe(false)
		expect(isJsonValue(Number.POSITIVE_INFINITY))
			.toBe(false)
	})

	it('keeps the Blueprint source proof false for forged symbol and named-array material', () => {
		const plugin = createWidgetPlugin('leaf')
			.description('Leaf widget')
			.interfaces<Record<never, never>>()
			.done()
		const system = createWidgetSystem({ plugins: [plugin] })
		const symbolSource = { id: 'root', type: 'leaf' }
		Object.defineProperty(symbolSource, Symbol('malformed'), { value: true })
		const namedArray = [{ id: 'root', type: 'leaf' }]
		Object.defineProperty(namedArray, 'metadata', { value: true })

		expect(system.createBlueprint(symbolSource).sourceJsonCompatible)
			.toBe(false)
		expect(system.createBlueprint(namedArray).sourceJsonCompatible)
			.toBe(false)
	})
})
