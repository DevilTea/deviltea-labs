import type { Severity } from './diagnostics'

export const DIAGNOSTIC_CODES = {
	'SPEC-CONFIG-INVALID': 'error',
	'SPEC-LAYOUT-INVALID': 'error',
	'SPEC-ARTIFACT-PARSE': 'error',
	'SPEC-ENVELOPE-INVALID': 'error',
	'SPEC-SCHEMA-INVALID': 'error',
	'SPEC-IDENTITY-INVALID': 'error',
	'SPEC-IDENTITY-DUPLICATE': 'error',
	'SPEC-PATH-INVALID': 'error',
	'SPEC-STATUS-INVALID': 'error',
	'SPEC-BODY-INCOMPLETE': 'error',
	'SPEC-RELATION-INVALID': 'error',
	'SPEC-RESOURCE-INVALID': 'error',
	'SPEC-PROJECT-COUNT': 'error',
	'SPEC-IO-ERROR': 'error',
	'SPEC-CLI-INVALID': 'error',
	'SPEC-CLI-INTERNAL': 'error',
	'SPEC-VERSION': 'error',
} as const satisfies Record<string, Severity>

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES

export function severityOf(code: DiagnosticCode): Severity {
	return DIAGNOSTIC_CODES[code]
}
