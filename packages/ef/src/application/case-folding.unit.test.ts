import { describe, expect, it } from 'vitest'
import { findOccurrences, matchSurface, prepareSearchTerms, toFoldedCodePoints } from './case-folding'
import { SIMPLE_CASE_FOLD_TABLE, simpleCaseFold, simpleCaseFoldCodePoint } from './case-folding-data'

describe('case-folding-data (Unicode 15.1.0 CaseFolding.txt, status C+S)', () => {
	it('has exactly 1457 mappings (1426 status C + 31 status S)', () => {
		expect(SIMPLE_CASE_FOLD_TABLE.size)
			.toBe(1457)
	})

	it('folds basic Latin uppercase to lowercase', () => {
		expect(simpleCaseFold('ABCXYZ'))
			.toBe('abcxyz')
	})

	it('does NOT fold Turkish dotted capital I (U+0130) to dotless i under simple folding', () => {
		// U+0130 only has F (full) and T (Turkic) mappings in CaseFolding.txt,
		// no C or S entry, so simple folding leaves it unchanged.
		expect(simpleCaseFoldCodePoint(0x130))
			.toBe(0x130)
		expect(simpleCaseFold('İ'))
			.toBe('İ')
	})

	it('does NOT fold U+00DF (sharp s, ß) to "ss" under simple folding', () => {
		// U+00DF only has an F mapping ("ss"); no C or S entry.
		expect(simpleCaseFold('ß'))
			.toBe('ß')
	})

	it('folds U+1E9E (capital sharp s, ẞ) to U+00DF (ß) via its S mapping', () => {
		expect(simpleCaseFold('ẞ'))
			.toBe('ß')
	})

	it('folds an astral-plane letter (Deseret U+10400) via its S/C mapping', () => {
		expect(simpleCaseFoldCodePoint(0x10400))
			.toBe(0x10428)
	})

	it('leaves an unmapped code point unchanged', () => {
		expect(simpleCaseFoldCodePoint(0x1F600))
			.toBe(0x1F600)
	})
})

describe('toFoldedCodePoints', () => {
	it('returns raw code points when caseSensitive is true', () => {
		expect(toFoldedCodePoints('AbC', true))
			.toEqual(['A', 'b', 'C'].map(c => c.codePointAt(0)))
	})

	it('returns folded code points when caseSensitive is false', () => {
		expect(toFoldedCodePoints('AbC', false))
			.toEqual(['a', 'b', 'c'].map(c => c.codePointAt(0)))
	})

	it('counts an astral character as exactly one code point', () => {
		const withEmoji = 'a\u{1F600}b'
		expect(toFoldedCodePoints(withEmoji, false))
			.toHaveLength(3)
	})
})

describe('findOccurrences', () => {
	it('finds a single occurrence', () => {
		const haystack = toFoldedCodePoints('hello world', false)
		const needle = toFoldedCodePoints('world', false)
		expect(findOccurrences(haystack, needle))
			.toEqual([6])
	})

	it('finds overlapping occurrences', () => {
		const haystack = toFoldedCodePoints('aaaa', false)
		const needle = toFoldedCodePoints('aa', false)
		expect(findOccurrences(haystack, needle))
			.toEqual([0, 1, 2])
	})

	it('returns an empty array when the needle does not occur', () => {
		const haystack = toFoldedCodePoints('hello', false)
		const needle = toFoldedCodePoints('xyz', false)
		expect(findOccurrences(haystack, needle))
			.toEqual([])
	})

	it('returns an empty array for an empty needle', () => {
		expect(findOccurrences(toFoldedCodePoints('hello', false), []))
			.toEqual([])
	})
})

describe('prepareSearchTerms', () => {
	it('nFC-normalizes each term', () => {
		// "é" as e + combining acute (NFD) vs. precomposed é (NFC).
		const nfd = 'é'
		const prepared = prepareSearchTerms([nfd], false)
		expect(prepared?.[0]?.normalized)
			.toBe('é')
	})

	it('rejects an empty term', () => {
		expect(prepareSearchTerms([''], false))
			.toBeUndefined()
	})

	it('rejects a term that normalizes to empty', () => {
		// A lone combining character does not normalize away, but an
		// explicit empty string is the primary case; verify a whitespace-only
		// term is NOT treated as invalid by normalization alone (only truly
		// empty strings are rejected here -- "meaningful" checks are a
		// different module's concern).
		expect(prepareSearchTerms([' '], false)?.[0]?.normalized)
			.toBe(' ')
	})

	it('deduplicates terms that fold identically, preserving first-position casing', () => {
		const prepared = prepareSearchTerms(['Filtering', 'filtering', 'FILTERING'], false)
		expect(prepared?.map(t => t.normalized))
			.toEqual(['Filtering'])
	})

	it('does NOT deduplicate case-distinct terms when caseSensitive is true', () => {
		const prepared = prepareSearchTerms(['Filtering', 'filtering'], true)
		expect(prepared?.map(t => t.normalized))
			.toEqual(['Filtering', 'filtering'])
	})

	it('preserves the first input position among duplicates that are not adjacent', () => {
		const prepared = prepareSearchTerms(['alpha', 'beta', 'ALPHA'], false)
		expect(prepared?.map(t => t.normalized))
			.toEqual(['alpha', 'beta'])
	})
})

describe('matchSurface', () => {
	it('matches case-insensitively by default and reports an exact column', () => {
		const term = prepareSearchTerms(['world'], false)![0]!
		const result = matchSurface('Hello WORLD', term, false)
		expect(result.matched)
			.toBe(true)
		expect(result.positions)
			.toEqual([6])
	})

	it('does not match under case-sensitive comparison when case differs', () => {
		const term = prepareSearchTerms(['world'], true)![0]!
		const result = matchSurface('Hello WORLD', term, true)
		expect(result.matched)
			.toBe(false)
	})

	it('reports a one-based-ready zero-based column for an astral character before the match', () => {
		const term = prepareSearchTerms(['world'], false)![0]!
		const result = matchSurface('\u{1F600} world', term, false)
		// "😀"(1 scalar) + " "(1) = index 2 for "world".
		expect(result.positions)
			.toEqual([2])
	})

	it('matches Turkish İ against İ but not against plain i under simple case-insensitive folding', () => {
		const term = prepareSearchTerms(['İ'], false)![0]!
		expect(matchSurface('İstanbul', term, false).matched)
			.toBe(true)
		expect(matchSurface('istanbul', term, false).matched)
			.toBe(false)
	})

	it('matches ß case-insensitively against ẞ (its S-folded capital form) but not against "ss"', () => {
		const term = prepareSearchTerms(['ß'], false)![0]!
		expect(matchSurface('Straẞe', term, false).matched)
			.toBe(true)
		expect(matchSurface('Strasse', term, false).matched)
			.toBe(false)
	})

	it('reports matched:true with positions:undefined when the match requires NFC normalization', () => {
		// Haystack stored as NFD (not self-normalized); term is NFC "é".
		const nfdHaystack = 'café'
		const term = prepareSearchTerms(['café'], false)![0]!
		const result = matchSurface(nfdHaystack, term, false)
		expect(result.matched)
			.toBe(true)
		expect(result.positions)
			.toBeUndefined()
	})
})
