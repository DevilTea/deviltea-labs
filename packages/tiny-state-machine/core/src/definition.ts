import type { CompiledGraph } from './compiler'
import type { Diagnostic } from './diagnostics'
import type { MachineConfig } from './index'
import { compileDefinition } from './compiler'

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

// A private nominal type and runtime identity registry prevent a structural
// object with valid: true from becoming an executable definition.
declare const definitionBrand: unique symbol

export interface ValidDefinition<Config extends MachineConfig = MachineConfig> {
	readonly valid: true
	readonly data: DeepReadonly<Config>
	readonly diagnostics: readonly Diagnostic[]
	readonly [definitionBrand]: Config
}

export interface InvalidDefinition {
	readonly valid: false
	readonly data: unknown
	readonly diagnostics: readonly Diagnostic[]
}

export type Definition<Config extends MachineConfig = MachineConfig> = ValidDefinition<Config> | InvalidDefinition

const graphs = new WeakMap<object, CompiledGraph>()

/** Validate and compile once; invalid input becomes diagnostics, not an exception. */
export function defineMachine<const Config extends MachineConfig<State>, State extends keyof Config['states'] & string>(input: Config): Definition<Config>
export function defineMachine(input: unknown): Definition
export function defineMachine(input: unknown): Definition {
	const { data, diagnostics, graph } = compileDefinition(input)
	if (!graph)
		return Object.freeze({ valid: false, data, diagnostics: Object.freeze(diagnostics) })
	const definition = Object.freeze({ valid: true, data, diagnostics: Object.freeze(diagnostics) }) as ValidDefinition
	graphs.set(definition, graph)
	return definition
}

/** Internal identity lookup; no validation or recompilation at use sites. */
export function getCompiledGraph(definition: unknown): CompiledGraph {
	const graph = graphs.get(definition as object)
	if (!graph)
		throw new Error('Expected a valid definition produced by defineMachine().')
	return graph
}

/** Fail fast if a definition is invalid or not produced by this package instance. */
export function assertValidDefinition<Config extends MachineConfig>(definition: Definition<Config>): asserts definition is ValidDefinition<Config> {
	getCompiledGraph(definition)
}
