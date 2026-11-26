import type { Diagnostic } from './diagnostics'
import { errorDiagnostic } from './diagnostics'

export interface CompiledState {
	readonly final: boolean
	readonly transitions: ReadonlyMap<string, string>
}

export interface CompiledGraph {
	readonly initial: string
	readonly states: ReadonlyMap<string, CompiledState>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Copy data, not behavior. Preserve every enumerable own string key (including
 * __proto__) and optional undefined values. Reject non-JSON objects, accessors,
 * cycles, symbols and other non-data values instead of trusting a shallow freeze.
 */
function snapshot(value: unknown, path: string[], ancestors: Set<object>, diagnostics: Diagnostic[]): unknown {
	if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
		return value
	const invalid = () => {
		diagnostics.push(errorDiagnostic('INVALID_DATA', path, 'Expected plain, acyclic JSON-compatible data.'))
		return undefined
	}
	if (typeof value !== 'object' || ancestors.has(value))
		return invalid()
	const array = Array.isArray(value)
	const prototype: unknown = Object.getPrototypeOf(value)
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
		return invalid()
	if (Object.getOwnPropertySymbols(value)
		.some(key => Object.prototype.propertyIsEnumerable.call(value, key))) {
		return invalid()
	}

	ancestors.add(value)
	const entries: [string, unknown][] = []
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!
		const childPath = [...path, key]
		if (!Object.hasOwn(descriptor, 'value')) {
			diagnostics.push(errorDiagnostic('INVALID_DATA', childPath, 'Accessor properties are not definition data.'))
			continue
		}
		entries.push([key, snapshot(descriptor.value, childPath, ancestors, diagnostics)])
	}
	ancestors.delete(value)
	if (array) {
		// Dense arrays only; extra enumerable properties are not JSON array data.
		if (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
			return invalid()
		return Object.freeze(entries.map(([, item]) => item))
	}
	return Object.freeze(Object.fromEntries(entries))
}

export function compileDefinition(input: unknown): { data: unknown, diagnostics: Diagnostic[], graph?: CompiledGraph } {
	const diagnostics: Diagnostic[] = []
	const issue = (code: Diagnostic['code'], path: string[], message: string) => diagnostics.push(errorDiagnostic(code, path, message))
	let data: unknown
	try {
		data = snapshot(input, [], new Set(), diagnostics)
	}
	catch {
		issue('INVALID_DATA', [], 'Definition data could not be inspected.')
	}
	if (diagnostics.length)
		return { data: input, diagnostics }

	if (!isRecord(data)) {
		issue('INVALID_CONFIG', [], 'Invalid machine configuration.')
		return { data: input, diagnostics }
	}
	const id = own(data, 'id')
	const initial = own(data, 'initial')
	const rawStates = own(data, 'states')
	if (id !== undefined && typeof id !== 'string')
		issue('INVALID_ID', ['id'], 'Machine id must be a string.')
	if (typeof initial !== 'string')
		issue('INVALID_INITIAL', ['initial'], 'Initial state must be a string.')
	if (!isRecord(rawStates)) {
		issue('INVALID_STATES', ['states'], 'States must be an object.')
		return { data: input, diagnostics }
	}

	const states = new Map<string, CompiledState>()
	for (const [key, state] of Object.entries(rawStates)) {
		const path = ['states', key]
		if (!isRecord(state)) {
			issue('INVALID_STATE', path, `Invalid state: ${key}.`)
			continue
		}
		const type = own(state, 'type')
		const on = own(state, 'on')
		if (type !== undefined && type !== 'final')
			issue('INVALID_STATE_TYPE', [...path, 'type'], `Invalid state type: ${key}.`)
		const final = type === 'final'
		const transitions = new Map<string, string>()
		if (on !== undefined) {
			if (!isRecord(on)) {
				issue('INVALID_TRANSITIONS', [...path, 'on'], `Invalid transitions for state: ${key}.`)
			}
			else {
				const edges = Object.entries(on)
				if (final && edges.length > 0)
					issue('FINAL_STATE_HAS_TRANSITIONS', [...path, 'on'], `Final state cannot have transitions: ${key}.`)
				for (const [event, target] of edges) {
					const edgePath = [...path, 'on', event]
					if (typeof target !== 'string') {
						issue('INVALID_TRANSITION_TARGET', edgePath, `Transition target must be a string: ${key} -> ${event}.`)
						continue
					}
					if (!Object.hasOwn(rawStates, target))
						issue('UNKNOWN_TRANSITION_TARGET', edgePath, `Unknown transition target: ${target}.`)
					transitions.set(event, target)
				}
			}
		}
		states.set(key, { final, transitions })
	}
	if (typeof initial === 'string' && !Object.hasOwn(rawStates, initial))
		issue('UNKNOWN_INITIAL_STATE', ['initial'], `Unknown initial state: ${initial}.`)
	if (diagnostics.length || typeof initial !== 'string')
		return { data: input, diagnostics }
	return { data, diagnostics, graph: { initial, states } }
}
