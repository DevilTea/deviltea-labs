/**
 * Full-text search normalization and literal substring matching
 * (10-query-and-trace.md "Full-text Search" - "Normalization", "Search
 * ordering and matches").
 *
 * All matching happens over Unicode *scalar values* (code points), never
 * UTF-16 code units, so a one-based column always counts astral characters
 * (surrogate pairs) as one column -- the same convention
 * `parsing/markdown.ts` uses for diagnostic locations (09-validation.md
 * "Unicode-scalar column convention").
 */

import { simpleCaseFoldCodePoint } from './case-folding-data'

/** Convert `text` to an array of Unicode scalar values, optionally simple-case-folding each one (./case-folding-data). */
export function toFoldedCodePoints(text: string, caseSensitive: boolean): number[] {
	const codePoints: number[] = []
	for (const ch of text) {
		const codePoint = ch.codePointAt(0)!
		codePoints.push(caseSensitive ? codePoint : simpleCaseFoldCodePoint(codePoint))
	}
	return codePoints
}

/**
 * Every zero-based start index in `haystack` where `needle` occurs
 * (overlapping occurrences included; only the minimum is ever needed by a
 * caller, but returning all of them keeps this function a simple, honestly
 * named primitive).
 */
function matchesAt(haystack: readonly number[], needle: readonly number[], start: number): boolean {
	for (let j = 0; j < needle.length; j++) {
		if (haystack[start + j] !== needle[j])
			return false
	}
	return true
}

export function findOccurrences(haystack: readonly number[], needle: readonly number[]): number[] {
	const positions: number[] = []
	if (needle.length === 0 || needle.length > haystack.length)
		return positions

	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (matchesAt(haystack, needle, i))
			positions.push(i)
	}
	return positions
}

/** One query term after preparation: its NFC-normalized text (the value reported in the result `terms` array) and its folded scalar-value sequence used for matching. */
export interface PreparedSearchTerm {
	normalized: string
	foldedCodePoints: number[]
}

/**
 * Prepare a raw `terms` request array (10-query-and-trace.md
 * "Normalization"): NFC-normalize each term, reject an empty term (before or
 * after normalization), and deduplicate terms that become identical under the
 * selected case-sensitive or case-insensitive comparison while preserving the
 * first input position. Returns `undefined` when any term is empty (a
 * distinct, caller-checked invalid condition), not an empty array.
 */
export function prepareSearchTerms(rawTerms: readonly string[], caseSensitive: boolean): PreparedSearchTerm[] | undefined {
	const prepared: PreparedSearchTerm[] = []
	const seenKeys = new Set<string>()

	for (const raw of rawTerms) {
		if (raw.length === 0)
			return undefined
		const normalized = raw.normalize('NFC')
		if (normalized.length === 0)
			return undefined

		const foldedCodePoints = toFoldedCodePoints(normalized, caseSensitive)
		const key = foldedCodePoints.join(',')
		if (seenKeys.has(key))
			continue
		seenKeys.add(key)
		prepared.push({ normalized, foldedCodePoints })
	}

	return prepared
}

/**
 * Result of matching one prepared term against one original (not yet
 * normalized) searchable surface value. `positions` is the set of zero-based
 * Unicode-scalar start indices *in the original text* where the term
 * occurred; it is `undefined` when the text required NFC normalization to
 * produce a match (i.e. `text.normalize('NFC') !== text`), in which case the
 * match is real (`matched: true`) but no stable original-source position can
 * be cheaply and exactly reported back -- see the accompanying report's
 * "column" ambiguity note. Well-formed authoritative content (already in NFC)
 * always takes the exact, position-reporting path.
 */
export interface SurfaceMatch {
	matched: boolean
	positions: number[] | undefined
}

export function matchSurface(original: string, term: PreparedSearchTerm, caseSensitive: boolean): SurfaceMatch {
	const nfc = original.normalize('NFC')

	if (nfc === original) {
		const folded = toFoldedCodePoints(original, caseSensitive)
		const positions = findOccurrences(folded, term.foldedCodePoints)
		return { matched: positions.length > 0, positions }
	}

	const folded = toFoldedCodePoints(nfc, caseSensitive)
	const positions = findOccurrences(folded, term.foldedCodePoints)
	return { matched: positions.length > 0, positions: undefined }
}
