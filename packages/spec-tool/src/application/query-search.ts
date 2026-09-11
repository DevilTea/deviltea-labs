/**
 * Full-text search execution (10-query-and-trace.md "Full-text Search").
 *
 * Operates over the already-loaded `ProjectSnapshot` (for raw post-
 * frontmatter body source lines, which `SnapshotValidationResult` does not
 * retain) and `SnapshotValidationResult` (for the decoded envelope of every
 * successfully identified Artifact). Term preparation (NFC, fold, dedupe,
 * empty-term rejection) and offset/limit validation happen in the caller
 * (./query.ts, `EF-QRY-002`); this module assumes `terms` is already valid
 * and non-empty.
 */

import type { Envelope } from '../domain/model'
import type { PreparedSearchTerm } from './case-folding'
import type { ArtifactSummaryProjection } from './query-projection'
import type { SearchData, SearchMatchData } from './query-types'
import type { ProjectSnapshot, SnapshotArtifactFile } from './snapshot'
import type { SnapshotValidationResult } from './snapshot-validation'
import { compareBytewise } from '../domain/model'
import { matchSurface } from './case-folding'
import { buildArtifactSummary } from './query-projection'

type SearchField = SearchMatchData['field']

const FIELD_PRIORITY: readonly SearchField[] = ['title', 'summary', 'tags', 'body', 'resources.location', 'resources.description']

interface SurfaceCandidate {
	field: SearchField
	/** Sort key within the field group: array index for tags/resources, absolute line number for body, `0` for the single-valued title/summary. */
	order: number
	section: string | null
	line: number | null
	original: string
}

/** Split raw Markdown source into logical lines, tolerating any line-ending style (10-query-and-trace.md "Body search uses the authoritative UTF-8 Markdown source after frontmatter, line by line."). */
function splitSourceLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/)
}

/** Best-effort plain-text extraction from an mdast node (heading text for `section` attribution only; never used for diagnostics). */
function extractPlainText(node: unknown): string {
	if (node && typeof node === 'object') {
		const candidate = node as { value?: unknown, children?: unknown[] }
		if (typeof candidate.value === 'string')
			return candidate.value
		if (Array.isArray(candidate.children)) {
			return candidate.children.map(extractPlainText)
				.join('')
		}
	}
	return ''
}

/** Map each absolute body line number (up to and including `lastLine`) to its enclosing H2 section title, or omit it (section = null) when the line precedes the first H2 heading. */
function buildLineSectionMap(file: SnapshotArtifactFile, lastLine: number): Map<number, string> {
	const map = new Map<number, string>()
	if (!file.sections)
		return map

	const headingLines = file.sections.sections.map(section => section.headingLine)
	for (let i = 0; i < file.sections.sections.length; i++) {
		const start = headingLines[i]!
		const end = i + 1 < headingLines.length ? headingLines[i + 1]! - 1 : lastLine
		const title = extractPlainText(file.sections.sections[i]!.heading)
			.trim()
		for (let line = start; line <= end; line++)
			map.set(line, title)
	}
	return map
}

function buildSurfaces(envelope: Envelope, file: SnapshotArtifactFile | undefined): SurfaceCandidate[] {
	const surfaces: SurfaceCandidate[] = []

	surfaces.push({ field: 'title', order: 0, section: null, line: null, original: envelope.title })
	surfaces.push({ field: 'summary', order: 0, section: null, line: null, original: envelope.summary })

	envelope.tags.forEach((tag, index) => {
		surfaces.push({ field: 'tags', order: index, section: null, line: null, original: tag })
	})

	envelope.resources.forEach((resource, index) => {
		surfaces.push({ field: 'resources.location', order: index, section: null, line: null, original: resource.location })
		surfaces.push({ field: 'resources.description', order: index, section: null, line: null, original: resource.description })
	})

	if (file?.frontmatter.ok) {
		const bodyStartLine = file.frontmatter.bodyStartLine
		const lines = splitSourceLines(file.frontmatter.bodyText)
		const sectionOf = buildLineSectionMap(file, bodyStartLine + lines.length - 1)
		lines.forEach((lineText, index) => {
			const absoluteLine = bodyStartLine + index
			surfaces.push({ field: 'body', order: absoluteLine, section: sectionOf.get(absoluteLine) ?? null, line: absoluteLine, original: lineText })
		})
	}

	return surfaces
}

interface MatchedSurface {
	candidate: SurfaceCandidate
	/** One-based Unicode-scalar column, only ever set for `field: 'body'`; `null` when no exact-position match contributed (see `./case-folding`'s `SurfaceMatch` doc). */
	column: number | null
}

function buildMatchRecords(matched: readonly MatchedSurface[]): SearchMatchData[] {
	const byField = new Map<SearchField, MatchedSurface[]>()
	for (const entry of matched) {
		const list = byField.get(entry.candidate.field) ?? []
		list.push(entry)
		byField.set(entry.candidate.field, list)
	}

	const result: SearchMatchData[] = []
	for (const field of FIELD_PRIORITY) {
		const list = (byField.get(field) ?? []).sort((a, b) => a.candidate.order - b.candidate.order)
		for (const { candidate, column } of list) {
			result.push({
				field,
				section: field === 'body' ? candidate.section : null,
				line: field === 'body' ? candidate.line : null,
				column: field === 'body' ? column : null,
				text: candidate.original,
			})
		}
	}
	return result
}

/**
 * Run one already-validated search over every successfully identified
 * Artifact in `validation`. `terms` MUST be non-empty and already prepared
 * (`./case-folding` `prepareSearchTerms`).
 */
export function executeSearch(
	snapshot: ProjectSnapshot,
	validation: SnapshotValidationResult,
	terms: readonly PreparedSearchTerm[],
	caseSensitive: boolean,
	offset: number,
	limit: number | null,
): SearchData {
	const fileByPath = new Map(snapshot.artifacts.map(artifact => [artifact.path, artifact] as const))

	interface Qualifying { id: string, artifact: ArtifactSummaryProjection, matches: SearchMatchData[] }
	const qualifying: Qualifying[] = []

	for (const record of validation.byId.values()) {
		const file = fileByPath.get(record.path)
		const surfaces = buildSurfaces(record.envelope, file)

		const termMatchedSomewhere = Array.from({ length: terms.length })
			.fill(false)
		const matchedSurfaces: MatchedSurface[] = []

		for (const candidate of surfaces) {
			let minExactPosition: number | undefined
			let matchedAny = false

			for (let t = 0; t < terms.length; t++) {
				const term = terms[t]!
				const surfaceMatch = matchSurface(candidate.original, term, caseSensitive)
				if (!surfaceMatch.matched)
					continue

				matchedAny = true
				termMatchedSomewhere[t] = true

				if (surfaceMatch.positions !== undefined && surfaceMatch.positions.length > 0) {
					const localMin = Math.min(...surfaceMatch.positions)
					if (minExactPosition === undefined || localMin < minExactPosition)
						minExactPosition = localMin
				}
			}

			if (matchedAny) {
				const column = candidate.field === 'body' && minExactPosition !== undefined ? minExactPosition + 1 : null
				matchedSurfaces.push({ candidate, column })
			}
		}

		if (!termMatchedSomewhere.every(Boolean))
			continue

		qualifying.push({
			id: record.id,
			artifact: buildArtifactSummary(record.envelope, record.path),
			matches: buildMatchRecords(matchedSurfaces),
		})
	}

	qualifying.sort((a, b) => compareBytewise(a.id, b.id))
	const total = qualifying.length
	const paged = limit === null ? qualifying.slice(offset) : qualifying.slice(offset, offset + limit)

	return {
		terms: terms.map(term => term.normalized),
		case_sensitive: caseSensitive,
		total,
		offset,
		limit,
		results: paged.map(entry => ({ artifact: entry.artifact, matches: entry.matches })),
	}
}
