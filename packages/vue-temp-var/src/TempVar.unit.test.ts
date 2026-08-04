import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import TempVarDefault from './index'
import TempVar from './TempVar.vue'

interface HostNode {
	children: HostNode[]
	parent: HostNode | null
	text: string
	type: string
}

function hostNode(type: string, text = ''): HostNode {
	return { children: [], parent: null, text, type }
}

function renderedText(node: HostNode): string {
	return node.text + node.children.map(renderedText)
		.join('')
}

const renderer = createRenderer<HostNode, HostNode>({
	createComment: text => hostNode('comment', text),
	createElement: type => hostNode(type),
	createText: text => hostNode('text', text),
	insert(child, parent, anchor = null) {
		child.parent = parent
		if (anchor === null) {
			parent.children.push(child)
			return
		}

		parent.children.splice(parent.children.indexOf(anchor), 0, child)
	},
	nextSibling(node) {
		if (!node.parent)
			return null

		return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null
	},
	parentNode: node => node.parent,
	patchProp: () => {},
	remove(child) {
		const parent = child.parent
		if (parent)
			parent.children.splice(parent.children.indexOf(child), 1)
		child.parent = null
	},
	setElementText(node, text) {
		node.children = [hostNode('text', text)]
	},
	setText: (node, text) => {
		node.text = text
	},
})

describe('tempVar', () => {
	it('forwards the original define record to the default slot without dropping falsy or symbol keys', () => {
		const metadata = Symbol('metadata')
		const user = { id: 1 }
		const define = {
			disabled: false,
			empty: '',
			missing: undefined,
			total: 0,
			user,
			[metadata]: 'private',
		}
		const received = vi.fn()
		const root = hostNode('root')
		const App = defineComponent({
			setup: () => () => h(TempVar, { define }, {
				default: (slotProps: typeof define) => {
					received(slotProps)
					return h('output', `${slotProps.total}:${slotProps.disabled}:${slotProps.user.id}`)
				},
			}),
		})

		renderer.createApp(App)
			.mount(root)

		expect(received)
			.toHaveBeenCalledOnce()
		const slotProps = received.mock.calls[0]?.[0]
		expect(slotProps)
			.toBe(define)
		expect(Reflect.ownKeys(slotProps))
			.toStrictEqual(['disabled', 'empty', 'missing', 'total', 'user', metadata])
		expect(slotProps)
			.toMatchObject({ disabled: false, empty: '', missing: undefined, total: 0, user })
		expect(slotProps[metadata])
			.toBe('private')
		expect(renderedText(root))
			.toBe('0:false:1')
	})

	it('rerenders its slot for mutations and replacements of the reactive define prop', async () => {
		const define = ref({ label: 'before', value: 1 })
		const received: Array<{ label: string, value: number }> = []
		const root = hostNode('root')
		const App = defineComponent({
			setup: () => () => h(TempVar, { define: define.value }, {
				default: (slotProps: { label: string, value: number }) => {
					received.push({ label: slotProps.label, value: slotProps.value })
					return h('output', `${slotProps.label}:${slotProps.value}`)
				},
			}),
		})

		renderer.createApp(App)
			.mount(root)
		define.value.value = 2
		await nextTick()

		const replacement = { label: 'after', value: 0 }
		define.value = replacement
		await nextTick()

		expect(received)
			.toStrictEqual([
				{ label: 'before', value: 1 },
				{ label: 'before', value: 2 },
				{ label: 'after', value: 0 },
			])
		expect(renderedText(root))
			.toBe('after:0')
	})

	it('renders safely when the caller omits the default slot', () => {
		const root = hostNode('root')
		const App = defineComponent({
			setup: () => () => h(TempVar, { define: { value: 'unused' } }),
		})

		expect(() => renderer.createApp(App)
			.mount(root))
			.not.toThrow()
		expect(renderedText(root))
			.toBe('')
		expect(root.children.every(node => renderedText(node) === ''))
			.toBe(true)
	})

	it('keeps the SFC as the exact default export', () => {
		expect(TempVarDefault)
			.toBe(TempVar)
	})

	it('preserves the generic required prop and default-slot contracts', () => {
		type NumberTempVar = typeof TempVar<{ value: number }>
		type NumberTempVarProps = Parameters<NumberTempVar>[0]
		type NumberTempVarContext = NonNullable<Parameters<NumberTempVar>[1]>
		type NumberTempVarSlot = NonNullable<NumberTempVarContext['slots']['default']>
		type NumberTempVarSlotProps = Parameters<NumberTempVarSlot>[0]

		const genericComponent: typeof TempVar = TempVarDefault
		const validProps: NumberTempVarProps = { define: { value: 1 } }
		// @ts-expect-error The generic define prop is required.
		const missingDefine: NumberTempVarProps = {}

		expectTypeOf<typeof TempVarDefault>()
			.toEqualTypeOf<typeof TempVar>()
		expectTypeOf<NumberTempVarProps>()
			.toMatchTypeOf<{ define: { value: number } }>()
		expectTypeOf<{ define: { value: number } }>()
			.toMatchTypeOf<NumberTempVarProps>()
		expectTypeOf<NumberTempVarSlotProps>()
			.toEqualTypeOf<{ value: number }>()
		expect(genericComponent)
			.toBe(TempVar)
		expect(validProps.define.value)
			.toBe(1)
		expect(missingDefine)
			.toEqual({})
	})
})
