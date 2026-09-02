import type { WidgetSource } from './index'
import { describe, expect, it } from 'vitest'
import { createWidgetPlugin, createWidgetSystem, normalizeSeparatedWidgetSource, separateWidgetSource } from './index'

function createPlugins() {
	interface ContainerInterfaces {
		config: {
			raw: { readonly label?: string, readonly flags?: { readonly enabled: boolean } }
			resolved: { readonly label: string }
		}
		slots: 'items'
	}

	const container = createWidgetPlugin('container')
		.description('Container')
		.interfaces<ContainerInterfaces>()
		.config({
			description: 'Container configuration',
			validate: (input): input is { readonly label?: string, readonly flags?: { readonly enabled: boolean } } => typeof input === 'object' && input !== null,
			resolve: raw => ({ label: raw?.label ?? 'Container' }),
		})
		.slots({ items: { description: 'Items' } })
		.done()
	const leaf = createWidgetPlugin('leaf')
		.description('Leaf')
		.interfaces<Record<never, never>>()
		.done()
	return { container, leaf }
}

describe('separated widget source tooling', () => {
	it('projects canonical nested source and normalizes it back deterministically', () => {
		const fixture = createPlugins()
		const system = createWidgetSystem({ plugins: [fixture.container, fixture.leaf] })
		const source: WidgetSource<[typeof fixture.container, typeof fixture.leaf]> = {
			id: 'root',
			type: 'container',
			config: { label: 'Root', flags: { enabled: true } },
			slots: {
				items: [{ id: 'child', type: 'leaf' }],
			},
		}

		const separated = separateWidgetSource(source)
		expect(separated)
			.toEqual({
				structure: { id: 'root', slots: { items: [{ id: 'child' }] } },
				widgets: [
					{ id: 'root', type: 'container', config: { label: 'Root', flags: { enabled: true } } },
					{ id: 'child', type: 'leaf' },
				],
			})

		const normalized = normalizeSeparatedWidgetSource(separated)
		expect(system.createBlueprint(source).status)
			.toBe('valid')
		expect(normalized.diagnostics)
			.toEqual([])
		expect(normalized.source)
			.toEqual(source)
		expect(Object.isFrozen(separated))
			.toBe(true)
		expect(Object.isFrozen(separated.widgets))
			.toBe(true)
		expect(Object.isFrozen(separated.widgets[0]?.config))
			.toBe(true)
	})

	it('uses the first flat data entry, reports duplicates, and reports unused data without guessing', () => {
		const input = {
			structure: { id: 'root' },
			widgets: [
				{ id: 'root', type: 'first', config: { value: 1 } },
				{ id: 'root', type: 'second', config: { value: 2 } },
				{ id: 'orphan', type: 'orphan' },
			],
		}
		const normalized = normalizeSeparatedWidgetSource(input)

		expect(normalized.source)
			.toEqual({ id: 'root', type: 'first', config: { value: 1 } })
		expect(normalized.diagnostics.map(diagnostic => ({ code: diagnostic.code, location: diagnostic.location })))
			.toEqual([
				{ code: 'duplicate-widget-id', location: { area: 'widgets', index: 1 } },
				{ code: 'unused-widget-data', location: { area: 'widgets', index: 2 } },
			])
		expect(input.widgets)
			.toEqual([
				{ id: 'root', type: 'first', config: { value: 1 } },
				{ id: 'root', type: 'second', config: { value: 2 } },
				{ id: 'orphan', type: 'orphan' },
			])
	})

	it('materializes missing flat data as a partial node and preserves the subtree', () => {
		const normalized = normalizeSeparatedWidgetSource({
			structure: {
				id: 'root',
				slots: { items: [{ id: 'missing', slots: { nested: [{ id: 'grandchild' }] } }] },
			},
			widgets: [{ id: 'root', type: 'container' }],
		})

		expect(normalized.source)
			.toEqual({
				id: 'root',
				type: 'container',
				slots: { items: [{ id: 'missing', slots: { nested: [{ id: 'grandchild' }] } }] },
			})
		expect(normalized.diagnostics)
			.toEqual([
				expect.objectContaining({
					code: 'missing-widget-data',
					widgetId: 'missing',
					location: { area: 'structure', path: ['slots', 'items', 0, 'id'] },
				}),
				expect.objectContaining({
					code: 'missing-widget-data',
					widgetId: 'grandchild',
					location: { area: 'structure', path: ['slots', 'items', 0, 'slots', 'nested', 0, 'id'] },
				}),
			])
	})

	it('de-identifies repeated structural occurrences while retaining their available data and descendants', () => {
		const normalized = normalizeSeparatedWidgetSource({
			structure: {
				id: 'root',
				slots: {
					items: [
						{ id: 'child' },
						{ id: 'child', slots: { nested: [{ id: 'grandchild' }] } },
					],
				},
			},
			widgets: [
				{ id: 'root', type: 'container' },
				{ id: 'child', type: 'leaf', config: { label: 'retained' } },
				{ id: 'grandchild', type: 'leaf' },
			],
		})

		expect(normalized.source)
			.toEqual({
				id: 'root',
				type: 'container',
				slots: {
					items: [
						{ id: 'child', type: 'leaf', config: { label: 'retained' } },
						{ type: 'leaf', config: { label: 'retained' }, slots: { nested: [{ id: 'grandchild', type: 'leaf' }] } },
					],
				},
			})
		expect(normalized.diagnostics)
			.toEqual([
				expect.objectContaining({
					code: 'duplicate-structure-id',
					widgetId: 'child',
					location: { area: 'structure', path: ['slots', 'items', 1, 'id'] },
				}),
			])
	})

	it('is explicit and does not auto-detect a separated envelope at the Blueprint boundary', () => {
		const { leaf } = createPlugins()
		const system = createWidgetSystem({ plugins: [leaf] })
		const blueprint = system.createBlueprint({
			structure: { id: 'root' },
			widgets: [{ id: 'root', type: 'leaf' }],
		})

		expect(blueprint.status)
			.toBe('invalid')
		expect(blueprint.root.resolved)
			.toBe(false)
	})

	it('reports malformed representation fields through diagnostics without invoking accessors', () => {
		let reads = 0
		const structure = Object.defineProperty({}, 'id', {
			get() {
				reads++
				throw new Error('must not execute')
			},
			enumerable: true,
		})
		const normalized = normalizeSeparatedWidgetSource({ structure, widgets: [] })

		expect(reads)
			.toBe(0)
		expect(normalized.source)
			.toEqual({})
		expect(normalized.diagnostics)
			.toEqual([
				expect.objectContaining({
					code: 'invalid-separated-structure',
					location: { area: 'structure', path: ['id'] },
				}),
			])
	})
})
