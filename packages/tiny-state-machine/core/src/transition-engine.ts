import type { CompiledGraph } from './compiler'

/** Internal pure lookup shared by the graph queries and runtime. */
export function stateOf(graph: CompiledGraph, state: string) {
	const node = graph.states.get(state)
	if (!node)
		throw new Error(`Unknown state: ${state}.`)
	return node
}

/** Resolve one local event, without state mutation, queues or callbacks. */
export function resolveTransition(graph: CompiledGraph, state: string, event: string): string | undefined {
	return stateOf(graph, state).transitions.get(event)
}
