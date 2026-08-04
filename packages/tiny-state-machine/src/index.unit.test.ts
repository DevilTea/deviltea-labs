import type { MachineConfig } from './index'
import { describe, expect, it, vi } from 'vitest'
import { createMachine } from './index'

const workflowConfig = {
	initial: 'idle',
	states: {
		idle: {
			on: {
				begin: 'working',
				skip: 'done',
			},
		},
		working: {
			on: {
				finish: 'done',
				cancel: 'cancelled',
			},
		},
		done: {},
		cancelled: {},
	},
} as const satisfies MachineConfig

// `type: 'final'` is a runtime-only convention not represented by MachineConfig.
const workflowWithFinalState = {
	...workflowConfig,
	states: {
		...workflowConfig.states,
		done: { type: 'final' },
	},
} as typeof workflowConfig

function createWorkflow(context: Record<string, unknown> | null = { requestId: 7 }) {
	return createMachine(workflowWithFinalState, context)
}

describe('createMachine', () => {
	it('starts at the configured initial state and preserves direct or lazy context identity', () => {
		const directContext = { requestId: 7 }
		const directMachine = createMachine(workflowConfig, directContext)
		const lazyContext = { requestId: 8 }
		const factory = vi.fn(() => lazyContext)
		const lazyMachine = createMachine(workflowConfig, factory)

		expect(directMachine.currentState)
			.toBe('idle')
		expect(directMachine.context)
			.toBe(directContext)
		expect(lazyMachine.context)
			.toBe(lazyContext)
		expect(factory)
			.toHaveBeenCalledTimes(1)
		expect(factory)
			.toHaveBeenCalledWith()
	})

	it('uses null context when none is supplied', () => {
		expect(createMachine(workflowConfig).context)
			.toBeNull()
	})
})

describe('machine transitions', () => {
	it('updates state before notification and emits the exact payload with a machine-bound send', () => {
		const context = { requestId: 7 }
		const machine = createWorkflow(context)
		const transitions: Array<Record<string, unknown>> = []

		machine.onTransition((payload) => {
			transitions.push(payload)
			expect(machine.currentState)
				.toBe(payload.transition.target)
			expect(payload.machine)
				.toBe(machine)
			expect(payload.context)
				.toBe(context)

			if (payload.transition.event === 'begin') {
				const { send } = payload
				send('finish')
			}
		})

		machine.send('begin')

		expect(machine.currentState)
			.toBe('done')
		expect(transitions)
			.toHaveLength(2)
		expect(transitions[0])
			.toMatchObject({
				transition: { source: 'idle', event: 'begin', target: 'working' },
				machine,
				context,
			})
		expect(Object.keys(transitions[0]!)
			.sort())
			.toEqual(['context', 'machine', 'send', 'transition'])
		expect(transitions[1])
			.toMatchObject({
				transition: { source: 'working', event: 'finish', target: 'done' },
				machine,
				context,
			})
	})

	it('ignores invalid events without changing state or notifying subscribers', () => {
		const machine = createWorkflow()
		const handler = vi.fn()
		machine.onTransition(handler)

		machine.send('finish' as never)

		expect(machine.currentState)
			.toBe('idle')
		expect(handler).not.toHaveBeenCalled()
	})

	it('matches every supplied filter field conjunctively and rejects near matches', () => {
		const machine = createWorkflow()
		const sourceIdle = vi.fn()
		const eventFinish = vi.fn()
		const targetDone = vi.fn()
		const sourceAndEvent = vi.fn()
		const sourceEventAndTarget = vi.fn()
		const nearMatch = vi.fn()

		machine.onTransition({ source: 'idle' }, sourceIdle)
		machine.onTransition({ event: 'finish' }, eventFinish)
		machine.onTransition({ target: 'done' }, targetDone)
		machine.onTransition({ source: 'working', event: 'finish' }, sourceAndEvent)
		machine.onTransition({ source: 'working', event: 'finish', target: 'done' }, sourceEventAndTarget)
		machine.onTransition({ source: 'idle', event: 'finish' } as never, nearMatch)

		machine.send('begin')
		machine.send('finish')

		expect(sourceIdle)
			.toHaveBeenCalledTimes(1)
		expect(eventFinish)
			.toHaveBeenCalledTimes(1)
		expect(targetDone)
			.toHaveBeenCalledTimes(1)
		expect(sourceAndEvent)
			.toHaveBeenCalledTimes(1)
		expect(sourceEventAndTarget)
			.toHaveBeenCalledTimes(1)
		expect(nearMatch).not.toHaveBeenCalled()
		expect(sourceAndEvent)
			.toHaveBeenLastCalledWith(expect.objectContaining({
				transition: { source: 'working', event: 'finish', target: 'done' },
			}))
	})

	it('passes null send to filtered final-state handlers but a send function before final states', () => {
		const machine = createWorkflow()
		const sends: unknown[] = []

		machine.onTransition({ target: 'working' }, payload => sends.push(payload.send))
		machine.onTransition({ target: 'done' }, payload => sends.push(payload.send))

		machine.send('begin')
		machine.send('finish')

		expect(sends[0])
			.toEqual(expect.any(Function))
		expect(sends[1])
			.toBeNull()
	})

	it('stops a subscribed transition handler immediately and allows repeated unsubscribe', () => {
		const machine = createWorkflow()
		const handler = vi.fn()
		const unsubscribe = machine.onTransition(handler)

		machine.send('begin')
		unsubscribe()
		unsubscribe()
		machine.send('finish')

		expect(handler)
			.toHaveBeenCalledTimes(1)
		expect(handler)
			.toHaveBeenCalledWith(expect.objectContaining({
				transition: { source: 'idle', event: 'begin', target: 'working' },
			}))
	})
})

describe('machine destruction', () => {
	it('runs lifecycle handlers in order, retains access before destruction, then cleans up', () => {
		const context = { requestId: 7 }
		const machine = createWorkflow(context)
		const calls: string[] = []
		const transitionHandler = vi.fn()
		machine.onTransition(transitionHandler)
		machine.onBeforeDestroyed((received) => {
			calls.push(`before:${received.currentState}:${received.context === context}:${received.isDestroyed}`)
		})
		machine.onBeforeDestroyed(() => calls.push('before:second'))
		machine.onAfterDestroyed(() => {
			calls.push(`after:${machine.isDestroyed}`)
			expect(() => machine.currentState)
				.toThrowError('The machine has been destroyed.')
		})
		machine.onAfterDestroyed(() => calls.push('after:second'))

		machine.destroy()

		expect(calls)
			.toEqual([
				'before:idle:true:false',
				'before:second',
				'after:true',
				'after:second',
			])
		expect(machine.isDestroyed)
			.toBe(true)
		expect(transitionHandler).not.toHaveBeenCalled()
	})

	it('throws the exact destroyed error for all inaccessible operations and double destroy', () => {
		const machine = createWorkflow()
		const unsubscribe = machine.onTransition(() => {})
		machine.destroy()

		const operations = [
			() => machine.context,
			() => machine.currentState,
			() => machine.send('begin'),
			() => machine.onTransition(() => {}),
			() => machine.onBeforeDestroyed(() => {}),
			() => machine.onAfterDestroyed(() => {}),
			() => machine.destroy(),
		]

		for (const operation of operations) {
			expect(operation)
				.toThrowError('The machine has been destroyed.')
		}

		expect(() => unsubscribe()).not.toThrow()
		expect(machine.isDestroyed)
			.toBe(true)
	})
})
