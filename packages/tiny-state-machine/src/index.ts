import { compile } from './definition'

export { defineMachine, machineConfigSchema, parseMachineConfig, safeParseMachineConfig } from './definition'
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

export type MachineContext = Record<any, any> | null

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
	Context extends MachineContext,
	Filter = unknown,
	EventKey extends EventKeyOf<Config, Extract<TransitionDataOf<Config, Filter>['target'], StateKeyOf<Config>>> = EventKeyOf<Config, Extract<TransitionDataOf<Config, Filter>['target'], StateKeyOf<Config>>>,
> = Prettify<
	// Always have these properties
	& {
		readonly transition: TransitionDataOf<Config, Filter>
		readonly machine: Machine<Config, Context>
		readonly context: Context
	}
	// Conditionally provide the send function
	& { readonly send: [TransitionDataOf<Config, Filter>['target']] extends [FinalStateKeyOf<Config>]
		? null
		: ((event: EventKey) => void) | (Extract<TransitionDataOf<Config, Filter>['target'], PossibleFinalStateKeyOf<Config>> extends never ? never : null) }
>
type TransitionHandler<
	Config extends MachineConfig,
	Context extends MachineContext,
	Filter = unknown,
> = (payload: TransitionHandlerPayload<Config, Context, Filter>) => unknown

type RuntimeTransition = Readonly<{ source: string, event: string, target: string }>
type RuntimePayload = Readonly<{
	transition: RuntimeTransition
	machine: unknown
	context: MachineContext
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

export class Machine<Config extends MachineConfig, Context extends MachineContext> {
	private _states: ReturnType<typeof compile>['states']
	private _context: Context
	private _currentState: string
	private _transitionHandlers = new Set<RuntimeHandler>()
	private _beforeDestroyedHandlers = new Set<(machine: Machine<Config, Context>) => unknown>()
	private _afterDestroyedHandlers = new Set<() => unknown>()
	private _queue: string[] = []
	private _dispatching = false
	private _destroyRequested = false
	private _destroying = false
	private _isDestroyed = false

	constructor(config: Config, context: Context) {
		const { initial, states } = compile(config)
		this._states = states
		this._context = context
		this._currentState = initial
	}

	private _throwIfDestroyed() {
		if (this._isDestroyed)
			throw new Error('The machine has been destroyed.')
	}

	private _throwIfDestroying() {
		if (this._destroying)
			throw new Error('The machine is being destroyed.')
	}

	get context() {
		this._throwIfDestroyed()
		return this._context
	}

	get currentState(): StateKeyOf<Config> {
		this._throwIfDestroyed()
		return this._currentState as StateKeyOf<Config>
	}

	get isDestroyed() {
		return this._isDestroyed
	}

	/** Observe committed transitions in registration order. */
	onTransition(handler: TransitionHandler<Config, Context>): () => void
	onTransition<const Filter extends TransitionFilter<Config>>(
		filter: Filter & (TransitionDataOf<Config, Filter> extends never ? never : unknown),
		handler: TransitionHandler<Config, Context, Filter>,
	): () => void
	onTransition(...args: [handler: (...args: any[]) => unknown] | [filter: Partial<RuntimeTransition>, handler: (...args: any[]) => unknown]): () => void {
		this._throwIfDestroyed()
		this._throwIfDestroying()
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
		this._transitionHandlers.add(handler)
		return () => {
			this._transitionHandlers.delete(handler)
		}
	}

	/** Whether the current state accepts an event. */
	can(event: string): event is EventKeyOf<Config> {
		this._throwIfDestroyed()
		return this._states.get(this._currentState)!.transitions.has(event)
	}

	/** Nested sends are queued until all observers have seen the current transition. */
	send(event: EventKeyOf<Config>): void {
		this._throwIfDestroyed()
		this._throwIfDestroying()
		this._queue.push(event)
		if (this._dispatching)
			return

		const errors: unknown[] = []
		this._dispatching = true
		try {
			for (let index = 0; index < this._queue.length; index++) {
				const next = this._queue[index]!
				const source = this._currentState
				const target = this._states.get(source)!.transitions.get(next)
				if (target === undefined)
					continue
				this._currentState = target
				const payload: RuntimePayload = Object.freeze({
					transition: Object.freeze({ source, event: next, target }),
					machine: this,
					context: this._context,
					send: this._states.get(target)!.final ? null : this.send.bind(this) as (event: string) => void,
				})
				notify(this._transitionHandlers, payload, errors)
				if (this._destroyRequested) {
					this._destroy(errors)
					break
				}
			}
		}
		finally {
			this._queue.length = 0
			this._dispatching = false
		}
		throwErrors(errors)
	}

	onBeforeDestroyed(handler: (machine: Machine<Config, Context>) => unknown) {
		this._throwIfDestroyed()
		this._throwIfDestroying()
		this._beforeDestroyedHandlers.add(handler)
		return () => {
			this._beforeDestroyedHandlers.delete(handler)
		}
	}

	onAfterDestroyed(handler: () => unknown) {
		this._throwIfDestroyed()
		this._throwIfDestroying()
		this._afterDestroyedHandlers.add(handler)
		return () => {
			this._afterDestroyedHandlers.delete(handler)
		}
	}

	private _destroy(errors: unknown[]) {
		this._destroying = true
		notify(this._beforeDestroyedHandlers, this, errors)
		this._beforeDestroyedHandlers.clear()
		this._transitionHandlers.clear()
		this._states.clear()
		this._context = null as Context
		this._isDestroyed = true
		notify(this._afterDestroyedHandlers, undefined, errors)
		this._afterDestroyedHandlers.clear()
	}

	/** Destroy after the active notification, discarding any remaining queued events. */
	destroy() {
		this._throwIfDestroyed()
		this._throwIfDestroying()
		if (this._dispatching) {
			this._destroyRequested = true
			return
		}
		const errors: unknown[] = []
		this._destroy(errors)
		throwErrors(errors)
	}
}

export function createMachine<
	const Config extends MachineConfig<State>,
	State extends keyof Config['states'] & string,
>(config: Config, context?: undefined): Machine<Config, null>
export function createMachine<
	const Config extends MachineConfig<State>,
	State extends keyof Config['states'] & string,
	Context extends MachineContext,
>(config: Config, context: Context | (() => Context)): Machine<Config, Context>
export function createMachine(config: MachineConfig, context?: MachineContext | (() => MachineContext)): any {
	return new Machine(config, typeof context === 'function' ? context() : context ?? null)
}
