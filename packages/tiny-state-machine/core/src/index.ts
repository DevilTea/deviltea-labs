import type { CompiledGraph } from './compiler'
import type { ValidDefinition } from './definition'
import { getCompiledGraph } from './definition'
import { resolveTransition } from './transition-engine'

export type { DeepReadonly, Definition, InvalidDefinition, ValidDefinition } from './definition'
export { assertValidDefinition, defineMachine } from './definition'
export type { Diagnostic, DiagnosticCode } from './diagnostics'
export { getDeadEndStates, getEvents, getFinalStates, getReachableStates, getStates, getTransitions, getUnreachableStates, transition } from './graph'

type Prettify<T> = { [Key in keyof T]: T[Key] } & {}

type MachineState<StateKey extends string>
	= | { type?: never, on?: Record<string, StateKey> }
		| { type: 'final', on?: Record<string, never> }

export interface MachineConfig<StateKey extends string = string> {
	id?: string
	initial: StateKey
	states: {
		[EachState in StateKey]: MachineState<StateKey>
	}
}

export type StateKeyOf<Config extends MachineConfig> = keyof Config['states'] & string
type StateEvents<State> = State extends { type: 'final' }
	? never
	: State extends { on?: infer On }
		? keyof NonNullable<On> & string
		: never

export type EventKeyOf<
	Config extends MachineConfig,
	StateKey extends StateKeyOf<Config> = StateKeyOf<Config>,
> = StateKey extends StateKeyOf<Config> ? StateEvents<Config['states'][StateKey]> : never

type StateEventTarget<State, Event> = State extends { type: 'final' }
	? never
	: State extends { on?: infer On }
		? Event extends keyof NonNullable<On>
			? Extract<NonNullable<On>[Event], string>
			: never
		: never

type EventTargetStateKeyOf<
	Config extends MachineConfig,
	StateKey extends StateKeyOf<Config>,
	Event extends EventKeyOf<Config, StateKey>,
> = StateEventTarget<Config['states'][StateKey], Event>

export type AllPossibleTransitionDataOf<Config extends MachineConfig> = {
	[StateKey in StateKeyOf<Config>]: {
		[EventKey in EventKeyOf<Config, StateKey>]: {
			readonly source: StateKey
			readonly event: EventKey
			readonly target: EventTargetStateKeyOf<Config, StateKey, EventKey>
		}
	}[EventKeyOf<Config, StateKey>]
}[StateKeyOf<Config>]

type TransitionFilter<Config extends MachineConfig> = {
	readonly [Key in keyof RuntimeTransition]?: AllPossibleTransitionDataOf<Config>[Key]
}

type NarrowTransition<Data extends RuntimeTransition, Filter> = {
	readonly [Key in keyof RuntimeTransition]: Data[Key] & (Filter extends Record<Key, infer Value> ? Value : string)
}

type TransitionDataOf<
	Config extends MachineConfig,
	Filter = unknown,
	Data extends AllPossibleTransitionDataOf<Config> = AllPossibleTransitionDataOf<Config>,
> = Data extends RuntimeTransition
	? NarrowTransition<Data, Filter> extends infer Narrowed extends RuntimeTransition
		? [Narrowed['source']] extends [never] ? never
				: [Narrowed['event']] extends [never] ? never
						: [Narrowed['target']] extends [never] ? never : Narrowed
		: never
	: never

type FinalStateKeyOf<Config extends MachineConfig> = {
	[State in StateKeyOf<Config>]: Config['states'][State] extends { type: 'final' } ? State : never
}[StateKeyOf<Config>]

type PossibleFinalStateKeyOf<Config extends MachineConfig> = {
	[State in StateKeyOf<Config>]: Extract<Config['states'][State], { type: 'final' }> extends never ? never : State
}[StateKeyOf<Config>]

type TransitionHandlerPayload<
	Config extends MachineConfig,
	Filter = unknown,
	EventKey extends EventKeyOf<Config, Extract<TransitionDataOf<Config, Filter>['target'], StateKeyOf<Config>>> = EventKeyOf<Config, Extract<TransitionDataOf<Config, Filter>['target'], StateKeyOf<Config>>>,
> = Prettify<
	// Always have these properties
	& {
		readonly transition: TransitionDataOf<Config, Filter>
		readonly machine: Machine<Config>
	}
	// Conditionally provide the send function
	& { readonly send: [TransitionDataOf<Config, Filter>['target']] extends [FinalStateKeyOf<Config>]
		? null
		: ((event: EventKey) => void) | (Extract<TransitionDataOf<Config, Filter>['target'], PossibleFinalStateKeyOf<Config>> extends never ? never : null) }
>
type TransitionHandler<
	Config extends MachineConfig,
	Filter = unknown,
> = (payload: TransitionHandlerPayload<Config, Filter>) => unknown

type RuntimeTransition = Readonly<{ source: string, event: string, target: string }>
type RuntimePayload = Readonly<{
	transition: RuntimeTransition
	machine: unknown
	send: ((event: string) => void) | null
}>
type RuntimeHandler = (payload: RuntimePayload) => unknown
function notify<T>(handlers: Set<(value: T) => unknown>, value: T, errors: unknown[]) {
	for (const handler of [...handlers]) {
		if (!handlers.has(handler))
			continue
		try {
			handler(value)
		}
		catch (error) {
			errors.push(error)
		}
	}
}

function throwErrors(errors: unknown[]) {
	if (errors.length === 1)
		throw errors[0]
	if (errors.length > 1)
		throw new AggregateError(errors, 'Multiple machine handlers failed.')
}

export interface Machine<Config extends MachineConfig> {
	readonly currentState: StateKeyOf<Config>
	readonly isDestroyed: boolean
	/** Observe committed transitions in registration order. */
	onTransition: ((handler: TransitionHandler<Config>) => () => void) & (<const Filter extends TransitionFilter<Config>>(
		filter: Filter & (TransitionDataOf<Config, Filter> extends never ? never : unknown),
		handler: TransitionHandler<Config, Filter>,
	) => () => void)
	can: (event: string) => event is EventKeyOf<Config>
	send: (event: EventKeyOf<Config>) => void
	onBeforeDestroyed: (handler: (machine: Machine<Config>) => unknown) => () => void
	onAfterDestroyed: (handler: () => unknown) => () => void
	destroy: () => void
}

function createRuntime<Config extends MachineConfig>(compiled: CompiledGraph): Machine<Config> {
	let graph: CompiledGraph | undefined = compiled
	let currentState = compiled.initial
	const transitionHandlers = new Set<RuntimeHandler>()
	const beforeDestroyedHandlers = new Set<(machine: Machine<Config>) => unknown>()
	const afterDestroyedHandlers = new Set<() => unknown>()
	const queue: string[] = []
	let dispatching = false
	let destroyRequested = false
	let destroying = false
	let isDestroyed = false

	const machine: Machine<Config> = {
		get currentState() {
			throwIfDestroyed()
			return currentState as StateKeyOf<Config>
		},
		get isDestroyed() {
			return isDestroyed
		},
		onTransition,
		can,
		send,
		onBeforeDestroyed,
		onAfterDestroyed,
		destroy,
	}

	function throwIfDestroyed() {
		if (isDestroyed)
			throw new Error('The machine has been destroyed.')
	}

	function throwIfDestroying() {
		if (destroying)
			throw new Error('The machine is being destroyed.')
	}

	/** Observe committed transitions in registration order. */
	function onTransition(handler: TransitionHandler<Config>): () => void
	function onTransition<const Filter extends TransitionFilter<Config>>(
		filter: Filter & (TransitionDataOf<Config, Filter> extends never ? never : unknown),
		handler: TransitionHandler<Config, Filter>,
	): () => void
	function onTransition(...args: [handler: (...args: any[]) => unknown] | [filter: Partial<RuntimeTransition>, handler: (...args: any[]) => unknown]): () => void {
		throwIfDestroyed()
		throwIfDestroying()
		const filter = args.length === 2 ? { ...args[0] } : undefined
		const callback = args.length === 2 ? args[1] : args[0]
		const handler: RuntimeHandler = (payload) => {
			const { source, event, target } = payload.transition
			if (filter === undefined || (
				(filter.source == null || filter.source === source)
				&& (filter.event == null || filter.event === event)
				&& (filter.target == null || filter.target === target)
			)) {
				return callback(payload)
			}
			return undefined
		}
		transitionHandlers.add(handler)
		return () => {
			transitionHandlers.delete(handler)
		}
	}

	/** Whether the current state accepts an event. */
	function can(event: string): event is EventKeyOf<Config> {
		throwIfDestroyed()
		return resolveTransition(graph!, currentState, event) !== undefined
	}

	/** Nested sends are queued until all observers have seen the current transition. */
	function send(event: EventKeyOf<Config>): void {
		throwIfDestroyed()
		throwIfDestroying()
		queue.push(event)
		if (dispatching)
			return

		const errors: unknown[] = []
		dispatching = true
		try {
			for (let index = 0; index < queue.length; index++) {
				const next = queue[index]!
				const source = currentState
				const target = resolveTransition(graph!, source, next)
				if (target === undefined)
					continue
				currentState = target
				const payload: RuntimePayload = Object.freeze({
					transition: Object.freeze({ source, event: next, target }),
					machine,
					send: graph!.states.get(target)!.final ? null : send as (event: string) => void,
				})
				notify(transitionHandlers, payload, errors)
				if (destroyRequested) {
					performDestroy(errors)
					break
				}
			}
		}
		finally {
			queue.length = 0
			dispatching = false
		}
		throwErrors(errors)
	}

	function onBeforeDestroyed(handler: (machine: Machine<Config>) => unknown) {
		throwIfDestroyed()
		throwIfDestroying()
		beforeDestroyedHandlers.add(handler)
		return () => {
			beforeDestroyedHandlers.delete(handler)
		}
	}

	function onAfterDestroyed(handler: () => unknown) {
		throwIfDestroyed()
		throwIfDestroying()
		afterDestroyedHandlers.add(handler)
		return () => {
			afterDestroyedHandlers.delete(handler)
		}
	}

	function performDestroy(errors: unknown[]) {
		destroying = true
		notify(beforeDestroyedHandlers, machine, errors)
		beforeDestroyedHandlers.clear()
		transitionHandlers.clear()
		graph = undefined
		isDestroyed = true
		notify(afterDestroyedHandlers, undefined, errors)
		afterDestroyedHandlers.clear()
	}

	/** Destroy after the active notification, discarding any remaining queued events. */
	function destroy() {
		throwIfDestroyed()
		throwIfDestroying()
		if (dispatching) {
			destroyRequested = true
			return
		}
		const errors: unknown[] = []
		performDestroy(errors)
		throwErrors(errors)
	}

	return machine
}

export function createMachine<Config extends MachineConfig>(definition: ValidDefinition<Config>): Machine<Config> {
	return createRuntime<Config>(getCompiledGraph(definition))
}
