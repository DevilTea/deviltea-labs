import * as core from '@deviltea/tiny-state-machine'
import * as fc from 'fast-check'
import { expect, expectTypeOf, it, vi } from 'vitest'
import { computed, effectScope, isReadonly, watch } from 'vue'
import { createMachine, Machine, useMachine } from './index'

const config = {
	initial: 'idle',
	states: {
		idle: { on: { start: 'active' } },
		active: { on: { stop: 'idle', finish: 'done' } },
		done: { type: 'final' },
	},
} as const

it('re-exports the original core', () => {
	expect(createMachine)
		.toBe(core.createMachine)
	expect(Machine)
		.toBe(core.Machine)
})

it('maintains a readonly reactive state and can() across generated event sequences', () => fc.assert(fc.property(fc.array(fc.constantFrom('start', 'stop', 'finish'), { maxLength: 40 }), (events) => {
	const machine = createMachine(config)
	const scope = effectScope()
	const binding = scope.run(() => useMachine(machine))!
	const canStart = computed(() => binding.can('start'))
	expect(isReadonly(binding.currentState))
		.toBe(true)
	expect(isReadonly(binding.isDisposed))
		.toBe(true)
	for (const event of events) {
		binding.send(event)
		expect(binding.currentState.value)
			.toBe(machine.currentState)
		expect(canStart.value)
			.toBe(machine.currentState === 'idle')
	}
	const last = binding.currentState.value
	scope.stop()
	expect(binding.isDisposed.value)
		.toBe(true)
	expect(machine.isDestroyed)
		.toBe(false)
	expect(binding.can('start'))
		.toBe(false)
	expect(() => binding.send('start'))
		.toThrow('The machine binding has been disposed.')
	expect(binding.currentState.value)
		.toBe(last)
}), { seed: 20261126, numRuns: 200 }))

it('stopping one borrowed binding leaves other scopes and machine alive', () => {
	const machine = createMachine(config)
	const first = effectScope()
	const second = effectScope()
	const a = first.run(() => useMachine(machine))!
	const b = second.run(() => useMachine(machine))!
	first.stop()
	machine.send('start')
	expect(a.currentState.value)
		.toBe('idle')
	expect(b.currentState.value)
		.toBe('active')
	expect(a.isDisposed.value)
		.toBe(true)
	expect(b.isDisposed.value)
		.toBe(false)
	second.stop()
	expect(machine.isDestroyed)
		.toBe(false)
})

it('owned binding destroys the machine on scope disposal', () => {
	const machine = createMachine(config)
	const scope = effectScope()
	const binding = scope.run(() => useMachine(machine, { autoDestroy: true }))!
	scope.stop()
	expect(binding.isDisposed.value)
		.toBe(true)
	expect(machine.isDestroyed)
		.toBe(true)
	expect(() => binding.dispose()).not.toThrow()
})

it('supports explicit disposal outside a scope and external machine destruction', () => {
	const machine = createMachine(config)
	const binding = useMachine(machine)
	binding.dispose()
	binding.dispose()
	machine.send('start')
	expect(binding.currentState.value)
		.toBe('idle')
	const another = useMachine(machine)
	machine.destroy()
	expect(another.isDisposed.value)
		.toBe(true)
	expect(another.currentState.value)
		.toBe('active')
	expect(another.can('finish'))
		.toBe(false)
	expect(() => another.send('finish'))
		.toThrow('The machine binding has been disposed.')
	expect(() => another.dispose()).not.toThrow()
})

it('handles scope disposal during a synchronous watcher without interrupting notification', () => {
	const machine = createMachine(config)
	const scope = effectScope()
	const binding = scope.run(() => {
		const binding = useMachine(machine, { autoDestroy: true })
		watch(binding.currentState, () => scope.stop(), { flush: 'sync' })
		return binding
	})!
	let observed = false
	machine.onTransition(({ transition }) => {
		expect(transition.target)
			.toBe('active')
		observed = true
	})
	binding.send('start')
	expect(observed)
		.toBe(true)
	expect(machine.isDestroyed)
		.toBe(true)
	expect(binding.isDisposed.value)
		.toBe(true)
})

it('preserves public event and state types without a cast', () => {
	const binding = useMachine(createMachine(config))
	expectTypeOf(binding.currentState.value)
		.toEqualTypeOf<'idle' | 'active' | 'done'>()
	expectTypeOf(binding.send)
		.parameter(0)
		.toEqualTypeOf<'start' | 'stop' | 'finish'>()
	const invalid = () => {
		// @ts-expect-error computed state is read-only
		binding.currentState.value = 'active'
		// @ts-expect-error unknown event
		binding.send('unknown')
	}
	expectTypeOf(invalid)
		.toBeFunction()
	binding.dispose()
})

it('unsubscribes once on explicit disposal, without warning outside a scope', () => {
	const machine = createMachine(config)
	const unsubscribeTransition = vi.fn()
	const unsubscribeDestroyed = vi.fn()
	vi.spyOn(machine, 'onTransition')
		.mockReturnValue(unsubscribeTransition)
	vi.spyOn(machine, 'onAfterDestroyed')
		.mockReturnValue(unsubscribeDestroyed)
	const warn = vi.spyOn(console, 'warn')
		.mockImplementation(() => {})
	try {
		const binding = useMachine(machine)
		expect(warn).not.toHaveBeenCalled()
		binding.dispose()
		binding.dispose()
		expect(unsubscribeTransition)
			.toHaveBeenCalledTimes(1)
		expect(unsubscribeDestroyed)
			.toHaveBeenCalledTimes(1)
		expect(machine.isDestroyed)
			.toBe(false)
	}
	finally {
		warn.mockRestore()
	}
})
