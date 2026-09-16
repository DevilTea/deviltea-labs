import { compareBytewise } from './text'

export type Severity = 'error' | 'warning' | 'info'

export interface SourceLocation {
	line: number
	column: number
}

export interface RelatedLocation {
	path?: string
	field?: string
	section?: string
	message: string
}

export interface Diagnostic {
	code: string
	severity: Severity
	message: string
	path?: string
	artifactId?: string
	field?: string
	section?: string
	location?: SourceLocation
	related: RelatedLocation[]
}

export function diagnostic(
	code: string,
	message: string,
	options: Omit<Diagnostic, 'code' | 'severity' | 'message' | 'related'> & { severity?: Severity, related?: RelatedLocation[] } = {},
): Diagnostic {
	return {
		code,
		severity: options.severity ?? 'error',
		message,
		path: options.path,
		artifactId: options.artifactId,
		field: options.field,
		section: options.section,
		location: options.location,
		related: options.related ?? [],
	}
}

function compareOptional(a: string | number | undefined, b: string | number | undefined): number {
	if (a === undefined && b === undefined)
		return 0
	if (a === undefined)
		return 1
	if (b === undefined)
		return -1
	if (typeof a === 'number' && typeof b === 'number')
		return a - b
	return compareBytewise(String(a), String(b))
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const severityOrder: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
	return [...diagnostics].sort((a, b) =>
		severityOrder[a.severity] - severityOrder[b.severity]
		|| compareOptional(a.path, b.path)
		|| compareOptional(a.location?.line, b.location?.line)
		|| compareOptional(a.location?.column, b.location?.column)
		|| compareOptional(a.field, b.field)
		|| compareOptional(a.section, b.section)
		|| compareBytewise(a.code, b.code)
		|| compareBytewise(a.message, b.message))
}

export function aggregateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>()
	const unique: Diagnostic[] = []
	for (const item of diagnostics) {
		const key = JSON.stringify([
			item.code,
			item.path ?? null,
			item.field ?? null,
			item.section ?? null,
			item.location ?? null,
			item.message,
		])
		if (seen.has(key))
			continue
		seen.add(key)
		unique.push({ ...item, related: [...item.related] })
	}
	return sortDiagnostics(unique)
}
