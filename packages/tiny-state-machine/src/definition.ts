import type { MachineConfig } from './index'
import * as v from 'valibot'

const string = v.string()
const stateType = v.optional(v.literal('final'))
const optionalId = v.optional(string)
const transitionsShape = v.record(string, string)

// The portable schema describes JSON shape. Cross-reference checks belong to
// the runtime schema; JSON Schema cannot express arbitrary sibling key lookup.
export const machineConfigShape = v.object({
	id: optionalId,
	initial: string,
	states: v.record(string, v.union([
		v.object({ type: v.optional(v.never()), on: v.optional(transitionsShape) }),
		v.object({ type: v.literal('final'), on: v.optional(v.record(string, v.never())) }),
	])),
})

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathItem(input: object, key: string): v.ObjectPathItem {
	return { type: 'object', origin: 'value', input: input as Record<string, unknown>, key, value: Reflect.get(input, key) }
}

/** Full validation without record parsing that would discard reserved object keys. */
export const machineConfigSchema = v.pipe(
	v.custom<Record<string, unknown>>(isRecord, 'Invalid machine configuration.'),
	v.rawCheck(({ dataset, addIssue }) => {
		if (!dataset.typed)
			return
		const config = dataset.value
		if (!isRecord(config.states) || !v.is(string, config.initial) || !v.is(optionalId, config.id)) {
			addIssue({ message: 'Invalid machine configuration.' })
			return
		}
		const statesPath = pathItem(config, 'states')
		for (const [key, state] of Object.entries(config.states)) {
			const statePath: [v.ObjectPathItem, ...v.ObjectPathItem[]] = [statesPath, pathItem(config.states, key)]
			if (!isRecord(state) || !v.is(stateType, state.type)) {
				addIssue({ message: `Invalid state: ${key}.`, path: statePath })
				continue
			}
			if (state.on !== undefined) {
				const onPath: [v.ObjectPathItem, ...v.ObjectPathItem[]] = [...statePath, pathItem(state, 'on')]
				if (!isRecord(state.on)) {
					addIssue({ message: `Invalid transitions for state: ${key}.`, path: onPath })
					continue
				}
				for (const [event, target] of Object.entries(state.on)) {
					if (!v.is(string, target) || !Object.prototype.propertyIsEnumerable.call(config.states, target)) {
						addIssue({ message: `Invalid transition: ${key} -> ${event}.`, path: [...onPath, pathItem(state.on, event)] })
					}
				}
				if (state.type === 'final' && Object.keys(state.on).length > 0)
					addIssue({ message: `Final state cannot have transitions: ${key}.`, path: onPath })
			}
		}
		if (!Object.prototype.propertyIsEnumerable.call(config.states, config.initial))
			addIssue({ message: `Invalid initial state: ${config.initial}.`, path: [pathItem(config, 'initial')] })
	}),
	v.transform(config => config as unknown as MachineConfig),
)

export function safeParseMachineConfig(input: unknown) {
	return v.safeParse(machineConfigSchema, input)
}

export function parseMachineConfig(input: unknown): MachineConfig {
	return v.parse(machineConfigSchema, input)
}

/** Validate a definition and preserve its exact inferred type and identity. */
export function defineMachine<
	const Config extends MachineConfig<State>,
	State extends keyof Config['states'] & string,
>(config: Config): Config {
	parseMachineConfig(config)
	return config
}

interface RuntimeState { final: boolean, transitions: Map<string, string> }

/** Shared compiler: every consumer validates before snapshotting own entries. */
export function compile(config: MachineConfig) {
	const validated = parseMachineConfig(config)
	const states = new Map<string, RuntimeState>()
	for (const [key, state] of Object.entries(validated.states)) {
		states.set(key, {
			final: state.type === 'final',
			transitions: new Map(Object.entries(state.on ?? {})),
		})
	}
	return { initial: validated.initial, states }
}
