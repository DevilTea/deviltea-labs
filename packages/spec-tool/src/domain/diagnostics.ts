/**
 * EF diagnostic contract (09-validation, diagnostic-registry).
 *
 * Ownership, deduplication, and deterministic ordering are centralized here;
 * individual validators only construct diagnostics.
 */

import { compareBytewise } from './model'

export type Severity = 'error' | 'warning' | 'info'

/** One-based line and one-based Unicode-scalar column. */
export interface SourceLocation {
	line: number
	column: number
}

export interface RelatedLocation {
	path?: string
	artifactId?: string
	location?: SourceLocation
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
	location?: SourceLocation
	field?: string
	section?: string
	/**
	 * Full commit OID attributing this finding to one commit of a validated
	 * range (09-validation.md "Range scope", "Diagnostic object"). Present only
	 * in range scope, and only for a finding evaluated at one commit's EF state
	 * or at one commit's incoming boundary -- a boundary finding attaches to
	 * that boundary's later (AFTER) commit. A range-level finding that belongs
	 * to no single commit (ancestry, captured-ref-state, shallow-history, or
	 * EF-inert-range) omits it, as does every other scope.
	 */
	commitOid?: string
	related: RelatedLocation[]
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Missing value sorts after present value (09-validation deterministic ordering). */
function compareOptional<T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number): number {
	if (a === undefined && b === undefined)
		return 0
	if (a === undefined)
		return 1
	if (b === undefined)
		return -1
	return cmp(a, b)
}

function compareLocationFields(a: { path?: string, artifactId?: string, location?: SourceLocation, field?: string, section?: string }, b: typeof a): number {
	return compareOptional(a.path, b.path, compareBytewise)
		|| compareOptional(a.location?.line, b.location?.line, (x, y) => x - y)
		|| compareOptional(a.location?.column, b.location?.column, (x, y) => x - y)
		|| compareOptional(a.artifactId, b.artifactId, compareBytewise)
		|| compareOptional(a.field, b.field, compareBytewise)
		|| compareOptional(a.section, b.section, compareBytewise)
}

/**
 * Sort diagnostics by severity, path, line, column, code, field/section, then
 * (range scope only) `commitOid` as a final, purely deterministic tiebreaker
 * (09-validation.md "Deterministic ordering": "`commitOid` is the final
 * tiebreaker rather than a grouping key, so no output that omits it is
 * reordered."). Parallel execution must not affect this final order.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	return [...diagnostics].sort((a, b) =>
		SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
		|| compareOptional(a.path, b.path, compareBytewise)
		|| compareOptional(a.location?.line, b.location?.line, (x, y) => x - y)
		|| compareOptional(a.location?.column, b.location?.column, (x, y) => x - y)
		|| compareBytewise(a.code, b.code)
		|| compareOptional(a.field, b.field, compareBytewise)
		|| compareOptional(a.section, b.section, compareBytewise)
		|| compareOptional(a.commitOid, b.commitOid, compareBytewise))
}

/** Sort related locations by path, line, column, artifact ID, field, section. */
export function sortRelated(related: readonly RelatedLocation[]): RelatedLocation[] {
	return [...related].sort(compareLocationFields)
}

function locationIdentity(l: { path?: string, artifactId?: string, location?: SourceLocation, field?: string, section?: string }): string {
	return JSON.stringify([l.path ?? null, l.artifactId ?? null, l.location ?? null, l.field ?? null, l.section ?? null])
}

/**
 * Deduplicate by code, `commitOid`, and complete structured primary and
 * related locations, excluding human message text (09-validation.md
 * "Diagnostic Contract": "`commit_oid` participates in that identity because
 * two genuinely distinct defects evaluated at two different boundaries of one
 * validated range can share a code and a path; without commit attribution
 * they would silently collapse into one finding."). Outside range scope every
 * diagnostic's `commitOid` is `undefined`, so this identity is unchanged from
 * before that field existed.
 */
export function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>()
	const out: Diagnostic[] = []
	for (const d of diagnostics) {
		const identity = JSON.stringify([d.code, d.commitOid ?? null, locationIdentity(d), sortRelated(d.related)
			.map(locationIdentity)])
		if (seen.has(identity))
			continue
		seen.add(identity)
		out.push(d)
	}
	return out
}

/** Canonical aggregation: dedupe related sets, dedupe diagnostics, sort deterministically. */
export function aggregateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const withSortedRelated = diagnostics.map((d) => {
		const unique = new Map(d.related.map(r => [locationIdentity(r), r] as const))
		return { ...d, related: sortRelated([...unique.values()]) }
	})
	return sortDiagnostics(dedupeDiagnostics(withSortedRelated))
}
