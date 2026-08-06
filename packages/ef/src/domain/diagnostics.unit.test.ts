import type { Diagnostic, RelatedLocation } from './diagnostics'
import { describe, expect, it } from 'vitest'
import {
	aggregateDiagnostics,
	dedupeDiagnostics,
	sortDiagnostics,
	sortRelated,
} from './diagnostics'

function diagnostic(overrides: Partial<Diagnostic> & Pick<Diagnostic, 'code' | 'severity' | 'message'>): Diagnostic {
	return { related: [], ...overrides }
}

function related(overrides: Partial<RelatedLocation> & Pick<RelatedLocation, 'message'>): RelatedLocation {
	return overrides
}

describe('sortDiagnostics', () => {
	it('orders by severity first: error, then warning, then info', () => {
		const info = diagnostic({ code: 'EF-X-001', severity: 'info', message: 'info' })
		const warning = diagnostic({ code: 'EF-X-001', severity: 'warning', message: 'warning' })
		const error = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'error' })
		expect(sortDiagnostics([info, warning, error]))
			.toEqual([error, warning, info])
	})

	it('breaks a severity tie by path (bytewise), and a missing path sorts after any present path', () => {
		const withoutPath = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm' })
		const zeta = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'zeta.md' })
		const alpha = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'alpha.md' })
		expect(sortDiagnostics([withoutPath, zeta, alpha]))
			.toEqual([alpha, zeta, withoutPath])
	})

	it('breaks a path tie by location line then column, and a missing location sorts after a present one', () => {
		const noLocation = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md' })
		const line5col9 = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md', location: { line: 5, column: 9 } })
		const line5col2 = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md', location: { line: 5, column: 2 } })
		const line1 = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md', location: { line: 1, column: 99 } })
		expect(sortDiagnostics([noLocation, line5col9, line5col2, line1]))
			.toEqual([line1, line5col2, line5col9, noLocation])
	})

	it('breaks a location tie by code (bytewise)', () => {
		const b = diagnostic({ code: 'EF-X-002', severity: 'error', message: 'm', path: 'a.md', location: { line: 1, column: 1 } })
		const a = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md', location: { line: 1, column: 1 } })
		expect(sortDiagnostics([b, a]))
			.toEqual([a, b])
	})

	it('breaks a code tie by field, then by section, each with missing sorting after present', () => {
		const neitherFieldNorSection = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm' })
		const fieldB = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', field: 'b' })
		const fieldASectionZ = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', field: 'a', section: 'Zeta' })
		const fieldASectionA = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', field: 'a', section: 'Alpha' })
		expect(sortDiagnostics([neitherFieldNorSection, fieldB, fieldASectionZ, fieldASectionA]))
			.toEqual([fieldASectionA, fieldASectionZ, fieldB, neitherFieldNorSection])
	})

	it('returns a new array and does not mutate the input order', () => {
		const b = diagnostic({ code: 'EF-X-002', severity: 'error', message: 'm' })
		const a = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm' })
		const input = [b, a]
		const result = sortDiagnostics(input)
		expect(result).not.toBe(input)
		expect(input)
			.toEqual([b, a])
		expect(result)
			.toEqual([a, b])
	})
})

describe('sortRelated', () => {
	it('orders by path (bytewise) when path is the deciding field', () => {
		const zeta = related({ message: 'm', path: 'zeta.md' })
		const alpha = related({ message: 'm', path: 'alpha.md' })
		expect(sortRelated([zeta, alpha]))
			.toEqual([alpha, zeta])
	})

	it('a missing artifact ID sorts after a present one when path and location tie', () => {
		const withoutArtifactId = related({ message: 'm', path: 'a.md' })
		const withArtifactId = related({ message: 'm', path: 'a.md', artifactId: 'REQ-001' })
		expect(sortRelated([withoutArtifactId, withArtifactId]))
			.toEqual([withArtifactId, withoutArtifactId])
	})

	it('falls all the way through to section comparison when path, location, artifact ID, and field all tie (all missing on both sides)', () => {
		const zeta = related({ message: 'later message', section: 'Zeta Section' })
		const alpha = related({ message: 'earlier message', section: 'Alpha Section' })
		expect(sortRelated([zeta, alpha]))
			.toEqual([alpha, zeta])
	})
})

describe('dedupeDiagnostics', () => {
	it('keeps the first occurrence and drops a later diagnostic with identical code and structured locations, ignoring message text', () => {
		const first = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'first message', path: 'a.md', location: { line: 1, column: 1 } })
		const secondSameIdentityDifferentMessage = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'a completely different message', path: 'a.md', location: { line: 1, column: 1 } })
		expect(dedupeDiagnostics([first, secondSameIdentityDifferentMessage]))
			.toEqual([first])
	})

	it('treats related sets as identical regardless of their order', () => {
		const relatedA = related({ message: 'a', path: 'x.md' })
		const relatedB = related({ message: 'b', path: 'y.md' })
		const first = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', related: [relatedA, relatedB] })
		const duplicateWithReversedRelated = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', related: [relatedB, relatedA] })
		expect(dedupeDiagnostics([first, duplicateWithReversedRelated]))
			.toEqual([first])
	})

	it('keeps diagnostics with different codes even when every other field is identical', () => {
		const codeOne = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', path: 'a.md' })
		const codeTwo = diagnostic({ code: 'EF-X-002', severity: 'error', message: 'm', path: 'a.md' })
		expect(dedupeDiagnostics([codeOne, codeTwo]))
			.toEqual([codeOne, codeTwo])
	})

	it('keeps diagnostics that differ only by field or only by section', () => {
		const fieldA = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', field: 'a' })
		const fieldB = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', field: 'b' })
		const sectionA = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', section: 'A' })
		const sectionB = diagnostic({ code: 'EF-X-001', severity: 'error', message: 'm', section: 'B' })
		expect(dedupeDiagnostics([fieldA, fieldB, sectionA, sectionB]))
			.toEqual([fieldA, fieldB, sectionA, sectionB])
	})
})

describe('aggregateDiagnostics', () => {
	it('dedupes related locations within a diagnostic, dedupes duplicate diagnostics, and sorts the final result deterministically', () => {
		const relatedX = related({ message: 'first seen at x', path: 'x.md' })
		const relatedXDuplicate = related({ message: 'seen again at x (later message wins)', path: 'x.md' })
		const relatedY = related({ message: 'y', path: 'y.md' })

		const warningWithDuplicateRelated = diagnostic({
			code: 'EF-X-002',
			severity: 'warning',
			message: 'warning message',
			path: 'a.md',
			related: [relatedX, relatedY, relatedXDuplicate],
		})
		const errorDiagnostic = diagnostic({
			code: 'EF-X-001',
			severity: 'error',
			message: 'error message',
			path: 'a.md',
		})
		const errorDuplicate = diagnostic({
			code: 'EF-X-001',
			severity: 'error',
			message: 'a different message for the very same identity',
			path: 'a.md',
		})

		const result = aggregateDiagnostics([warningWithDuplicateRelated, errorDiagnostic, errorDuplicate])

		expect(result)
			.toEqual([
				errorDiagnostic,
				{
					...warningWithDuplicateRelated,
					related: [relatedXDuplicate, relatedY],
				},
			])
	})

	it('returns an empty array for empty input', () => {
		expect(aggregateDiagnostics([]))
			.toEqual([])
	})
})
