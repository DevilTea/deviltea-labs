export type DiagnosticCode
	= | 'INVALID_DATA'
		| 'INVALID_CONFIG'
		| 'INVALID_ID'
		| 'INVALID_INITIAL'
		| 'INVALID_STATES'
		| 'INVALID_STATE'
		| 'INVALID_STATE_TYPE'
		| 'INVALID_TRANSITIONS'
		| 'INVALID_TRANSITION_TARGET'
		| 'UNKNOWN_INITIAL_STATE'
		| 'UNKNOWN_TRANSITION_TARGET'
		| 'FINAL_STATE_HAS_TRANSITIONS'

export interface Diagnostic {
	readonly code: DiagnosticCode
	readonly severity: 'error' | 'warning'
	readonly message: string
	readonly path: readonly string[]
}

export function errorDiagnostic(code: DiagnosticCode, path: string[], message: string): Diagnostic {
	return Object.freeze({ code, severity: 'error', path: Object.freeze(path), message })
}
