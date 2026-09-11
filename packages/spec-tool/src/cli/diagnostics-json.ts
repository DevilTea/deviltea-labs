/**
 * Diagnostic -> wire-format JSON conversion (09-validation.md "Diagnostic
 * object").
 *
 * `domain/diagnostics.ts`'s `Diagnostic`/`RelatedLocation` types use camelCase
 * (`artifactId`) for internal convenience; every stable JSON envelope
 * (`ef/validation-result@1`, `ef/mutation-result@1`, `ef/query-result@1`) uses
 * the documented snake_case wire field `artifact_id`. This is the single
 * place that conversion happens, so every command builds its envelope from
 * the same mapping.
 *
 * Optional fields are omitted (not `null`) by relying on `JSON.stringify`
 * dropping `undefined`-valued keys, matching the diagnostic examples in
 * 09-validation.md, which never show `null` for an absent optional field.
 * `commit_oid` (wire form of `Diagnostic.commitOid`) follows the same
 * omit-when-absent rule and is populated only for range-scope diagnostics
 * (09-validation.md "Diagnostic object"); it never appears on a related
 * location.
 */

import type { Diagnostic, RelatedLocation, SourceLocation } from '../domain/diagnostics'

export interface JsonSourceLocation {
	line: number
	column: number
}

export interface JsonRelatedLocation {
	path?: string
	artifact_id?: string
	location?: JsonSourceLocation
	field?: string
	section?: string
	message: string
}

export interface JsonDiagnostic {
	code: string
	severity: 'error' | 'warning' | 'info'
	message: string
	path?: string
	artifact_id?: string
	location?: JsonSourceLocation
	field?: string
	section?: string
	commit_oid?: string
	related: JsonRelatedLocation[]
}

function locationToJson(location: SourceLocation | undefined): JsonSourceLocation | undefined {
	if (!location)
		return undefined
	return { line: location.line, column: location.column }
}

function relatedToJson(related: RelatedLocation): JsonRelatedLocation {
	return {
		path: related.path,
		artifact_id: related.artifactId,
		location: locationToJson(related.location),
		field: related.field,
		section: related.section,
		message: related.message,
	}
}

/** Convert one `Diagnostic` to its exact `ef/validation-result@1`/`ef/mutation-result@1` wire shape. */
export function diagnosticToJson(diagnostic: Diagnostic): JsonDiagnostic {
	return {
		code: diagnostic.code,
		severity: diagnostic.severity,
		message: diagnostic.message,
		path: diagnostic.path,
		artifact_id: diagnostic.artifactId,
		location: locationToJson(diagnostic.location),
		field: diagnostic.field,
		section: diagnostic.section,
		commit_oid: diagnostic.commitOid,
		related: diagnostic.related.map(relatedToJson),
	}
}

/** Convert a complete diagnostic array to its wire shape, preserving order. */
export function diagnosticsToJson(diagnostics: readonly Diagnostic[]): JsonDiagnostic[] {
	return diagnostics.map(diagnosticToJson)
}
