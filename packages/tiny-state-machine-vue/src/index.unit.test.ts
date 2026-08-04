import * as core from '@deviltea/tiny-state-machine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as adapter from './index'

const vue = vi.hoisted(() => ({
	onScopeDispose: vi.fn(),
	ref: vi.fn(<T>(value: T) => ({ value })),
}))

vi.mock('vue', () => vue)

const config = {
	initial: 'idle',
	states: {
		idle: { on: { start: 'loading' } },
		loading: { on: { complete: 'finished' } },
		finished: {},
	},
} as const

describe('useMachine', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('initializes the ref precisely and synchronizes it after each machine transition', () => {
		const machine = core.createMachine(config)

		const result = adapter.useMachine(machine as never, { autoDestroy: false })

		expect(vue.ref)
			.toHaveBeenCalledExactlyOnceWith('idle')
		expect(result.currentState.value)
			.toBe('idle')
		expect(vue.onScopeDispose).not.toHaveBeenCalled()
		machine.send('start')
		expect(result.currentState.value)
			.toBe('loading')
		machine.send('complete')
		expect(result.currentState.value)
			.toBe('finished')
	})

	it.each([
		['default options', undefined],
		['explicit true', { autoDestroy: true }],
	] as const)('registers scope disposal for %s and destroys successfully', (_label, options) => {
		const machine = core.createMachine(config)

		adapter.useMachine(machine as never, options)

		expect(vue.onScopeDispose)
			.toHaveBeenCalledTimes(1)
		const dispose = vue.onScopeDispose.mock.calls[0]![0]
		expect(machine.isDestroyed)
			.toBe(false)
		dispose()
		expect(machine.isDestroyed)
			.toBe(true)
	})

	it('does not register scope disposal or destroy when autoDestroy is false', () => {
		const machine = core.createMachine(config)

		adapter.useMachine(machine as never, { autoDestroy: false })

		expect(vue.onScopeDispose).not.toHaveBeenCalled()
		expect(machine.isDestroyed)
			.toBe(false)
	})

	it('logs the original disposal error when destruction fails', () => {
		const machine = core.createMachine(config)
		const error = new Error('dispose failed')
		const consoleError = vi.spyOn(console, 'error')
			.mockImplementation(() => {})

		adapter.useMachine(machine as never)
		vi.spyOn(machine, 'destroy')
			.mockImplementation(() => {
				throw error
			})

		const dispose = vue.onScopeDispose.mock.calls[0]![0]
		dispose()

		expect(consoleError)
			.toHaveBeenCalledExactlyOnceWith(error)
	})
})

describe('core re-exports', () => {
	it('preserves the core runtime export identities', () => {
		expect(adapter.createMachine)
			.toBe(core.createMachine)
		expect(adapter.Machine)
			.toBe(core.Machine)
	})
})
