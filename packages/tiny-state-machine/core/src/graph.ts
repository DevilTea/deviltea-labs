import type { CompiledGraph } from './compiler'
import type { ValidDefinition } from './definition'
import type { AllPossibleTransitionDataOf, EventKeyOf, MachineConfig, StateKeyOf } from './index'
import { getCompiledGraph } from './definition'

type Graph = CompiledGraph

function stateOf(graph: Graph, state: string) {
	const node = graph.states.get(state)
	if (!node)
		throw new Error(`Unknown state: ${state}.`)
	return node
}

/** State keys in definition enumeration order. */
export function getStates<Config extends MachineConfig>(definition: ValidDefinition<Config>): StateKeyOf<Config>[] {
	return [...getCompiledGraph(definition).states.keys()] as StateKeyOf<Config>[]
}

/** Events accepted by this state, in definition enumeration order. */
export function getEvents<Config extends MachineConfig, State extends StateKeyOf<Config>>(definition: ValidDefinition<Config>, state: State): EventKeyOf<Config, State>[] {
	return [...stateOf(getCompiledGraph(definition), state).transitions.keys()] as EventKeyOf<Config, State>[]
}

/** Every edge, including self-transitions, in definition enumeration order. */
export function getTransitions<Config extends MachineConfig>(definition: ValidDefinition<Config>): AllPossibleTransitionDataOf<Config>[] {
	const graph = getCompiledGraph(definition)
	return [...graph.states].flatMap(([source, state]) =>
		[...state.transitions].map(([event, target]) => ({ source, event, target }))) as AllPossibleTransitionDataOf<Config>[]
}

/** Resolve an event without executing a machine or notifying subscribers. */
export function transition<Config extends MachineConfig>(definition: ValidDefinition<Config>, state: StateKeyOf<Config>, event: string): StateKeyOf<Config> | undefined {
	return stateOf(getCompiledGraph(definition), state).transitions.get(event) as StateKeyOf<Config> | undefined
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
export function getReachableStates<Config extends MachineConfig>(definition: ValidDefinition<Config>, start?: StateKeyOf<Config>): StateKeyOf<Config>[] {
	const graph = getCompiledGraph(definition)
	return [...reachable(graph, start ?? graph.initial)] as StateKeyOf<Config>[]
}

/** States not reachable from start, in definition enumeration order. */
export function getUnreachableStates<Config extends MachineConfig>(definition: ValidDefinition<Config>, start?: StateKeyOf<Config>): StateKeyOf<Config>[] {
	const graph = getCompiledGraph(definition)
	const seen = reachable(graph, start ?? graph.initial)
	return [...graph.states.keys()].filter(state => !seen.has(state)) as StateKeyOf<Config>[]
}

/** Explicit final states only; empty non-final nodes are not final. */
export function getFinalStates<Config extends MachineConfig>(definition: ValidDefinition<Config>): StateKeyOf<Config>[] {
	return [...getCompiledGraph(definition).states].filter(([, state]) => state.final)
		.map(([key]) => key) as StateKeyOf<Config>[]
}

/** Non-final states without outgoing edges. Includes unreachable states. */
export function getDeadEndStates<Config extends MachineConfig>(definition: ValidDefinition<Config>): StateKeyOf<Config>[] {
	return [...getCompiledGraph(definition).states].filter(([, state]) => !state.final && state.transitions.size === 0)
		.map(([key]) => key) as StateKeyOf<Config>[]
}
