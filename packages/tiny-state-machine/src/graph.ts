import type { AllPossibleTransitionDataOf, EventKeyOf, MachineConfig, StateKeyOf } from './index'
import { compile } from './definition'

type Graph = ReturnType<typeof compile>

function stateOf(graph: Graph, state: string) {
	const node = graph.states.get(state)
	if (!node)
		throw new Error(`Unknown state: ${state}.`)
	return node
}

/** State keys in definition enumeration order. */
export function getStates<Config extends MachineConfig>(config: Config): StateKeyOf<Config>[] {
	return [...compile(config).states.keys()] as StateKeyOf<Config>[]
}

/** Events accepted by this state, in definition enumeration order. */
export function getEvents<Config extends MachineConfig, State extends StateKeyOf<Config>>(config: Config, state: State): EventKeyOf<Config, State>[] {
	return [...stateOf(compile(config), state).transitions.keys()] as EventKeyOf<Config, State>[]
}

/** Every edge, including self-transitions, in definition enumeration order. */
export function getTransitions<Config extends MachineConfig>(config: Config): AllPossibleTransitionDataOf<Config>[] {
	const graph = compile(config)
	return [...graph.states].flatMap(([source, state]) =>
		[...state.transitions].map(([event, target]) => ({ source, event, target }))) as AllPossibleTransitionDataOf<Config>[]
}

/** Resolve an event without executing a machine or notifying subscribers. */
export function transition<Config extends MachineConfig>(config: Config, state: StateKeyOf<Config>, event: string): StateKeyOf<Config> | undefined {
	return stateOf(compile(config), state).transitions.get(event) as StateKeyOf<Config> | undefined
}

function reachable(graph: Graph, start: string) {
	const seen = new Set([start])
	// Iterating a Set visits newly added entries; no recursion or repeated scans.
	for (const state of seen) {
		for (const target of stateOf(graph, state).transitions.values())
			seen.add(target)
	}
	return seen
}

/** All states reachable from start (including start), in discovery order. */
export function getReachableStates<Config extends MachineConfig>(config: Config, start?: StateKeyOf<Config>): StateKeyOf<Config>[] {
	const graph = compile(config)
	return [...reachable(graph, start ?? graph.initial)] as StateKeyOf<Config>[]
}

/** States not reachable from start, in definition enumeration order. */
export function getUnreachableStates<Config extends MachineConfig>(config: Config, start?: StateKeyOf<Config>): StateKeyOf<Config>[] {
	const graph = compile(config)
	const seen = reachable(graph, start ?? graph.initial)
	return [...graph.states.keys()].filter(state => !seen.has(state)) as StateKeyOf<Config>[]
}

/** Explicit final states only; empty non-final nodes are not final. */
export function getFinalStates<Config extends MachineConfig>(config: Config): StateKeyOf<Config>[] {
	return [...compile(config).states].filter(([, state]) => state.final)
		.map(([key]) => key) as StateKeyOf<Config>[]
}

/** Non-final states without outgoing edges. Includes unreachable states. */
export function getDeadEndStates<Config extends MachineConfig>(config: Config): StateKeyOf<Config>[] {
	return [...compile(config).states].filter(([, state]) => !state.final && state.transitions.size === 0)
		.map(([key]) => key) as StateKeyOf<Config>[]
}
