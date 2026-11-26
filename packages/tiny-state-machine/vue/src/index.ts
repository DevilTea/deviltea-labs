import type { EventKeyOf, Machine, MachineConfig, MachineContext, StateKeyOf } from '@deviltea/tiny-state-machine'
import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue'

export * from '@deviltea/tiny-state-machine'

export interface UseMachineOptions {
	/** Set true only when this scope exclusively owns the machine. */
	autoDestroy?: boolean
}

/**
 * Observe an existing machine without making its state or context writable.
 * By default the machine is borrowed; stopping the scope only unsubscribes.
 */
export function useMachine<Config extends MachineConfig, Context extends MachineContext>(
	machine: Machine<Config, Context>,
	{ autoDestroy = false }: UseMachineOptions = {},
) {
	const state = shallowRef<StateKeyOf<Config>>(machine.currentState)
	const currentState = computed<StateKeyOf<Config>>(() => state.value)
	const stopTransition = machine.onTransition(({ transition }) => {
		state.value = transition.target
	})
	const disposed = shallowRef(false)
	const stopDestroyed = machine.onAfterDestroyed(() => {
		disposed.value = true
	})
	function dispose() {
		if (disposed.value)
			return
		disposed.value = true
		stopTransition()
		stopDestroyed()
		if (autoDestroy && !machine.isDestroyed)
			machine.destroy()
	}
	if (getCurrentScope())
		onScopeDispose(dispose)
	function send(event: EventKeyOf<Config>) {
		if (disposed.value)
			throw new Error('The machine binding has been disposed.')
		machine.send(event)
	}
	function can(event: string) {
		// Track state changes when used from a computed or template.
		void state.value
		return !disposed.value && !machine.isDestroyed && machine.can(event)
	}
	return {
		currentState,
		isDisposed: computed(() => disposed.value),
		send,
		can,
		dispose,
	}
}
