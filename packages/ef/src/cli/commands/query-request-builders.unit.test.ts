import { describe, expect, it } from 'vitest'
import {
	buildHistoryRequest,
	buildImpactRequest,
	buildListRequest,
	buildLookupRequest,
	buildRelationsRequest,
	buildResolveCurrentRequest,
	buildSearchRequest,
	buildTraceRequest,
} from './query-request-builders'

describe('buildLookupRequest', () => {
	it('defaults a missing id to an empty string rather than undefined', () => {
		expect(buildLookupRequest({}))
			.toEqual({ kind: 'lookup', id: '', projection: undefined })
	})

	it('passes id and projection through untouched', () => {
		expect(buildLookupRequest({ id: 'REQ-031', projection: 'summary' }))
			.toEqual({ kind: 'lookup', id: 'REQ-031', projection: 'summary' })
	})
})

describe('buildListRequest', () => {
	it('converts offset/limit strings to numbers and leaves them undefined when omitted', () => {
		const result = buildListRequest({ offset: '5', limit: '10' })
		expect(result.ok)
			.toBe(true)
		expect(result.ok && result.request.offset)
			.toBe(5)
		expect(result.ok && result.request.limit)
			.toBe(10)

		const omitted = buildListRequest({})
		expect(omitted.ok && omitted.request.offset)
			.toBeUndefined()
		expect(omitted.ok && omitted.request.limit)
			.toBeUndefined()
	})

	it('converts --resource-normative "true"/"false" to real booleans', () => {
		const trueResult = buildListRequest({ resourceNormative: 'true' })
		expect(trueResult.ok && trueResult.request.resourceNormative)
			.toBe(true)
		const falseResult = buildListRequest({ resourceNormative: 'false' })
		expect(falseResult.ok && falseResult.request.resourceNormative)
			.toBe(false)
	})

	it('rejects an invalid --resource-normative value with an EF-QRY-002 incomplete list result', () => {
		const result = buildListRequest({ resourceNormative: 'maybe' })
		expect(result.ok)
			.toBe(false)
		expect(!result.ok && result.result.complete)
			.toBe(false)
		expect(!result.ok && result.result.diagnostics[0]!.code)
			.toBe('EF-QRY-002')
	})

	it('passes repeatable filter arrays through untouched', () => {
		const result = buildListRequest({ type: ['requirement', 'prd'], tagAny: ['a'], tagAll: ['b', 'c'] })
		expect(result.ok && result.request.type)
			.toEqual(['requirement', 'prd'])
		expect(result.ok && result.request.tagsAny)
			.toEqual(['a'])
		expect(result.ok && result.request.tagsAll)
			.toEqual(['b', 'c'])
	})
})

describe('buildSearchRequest', () => {
	it('defaults terms to an empty array when omitted', () => {
		expect(buildSearchRequest({}).terms)
			.toEqual([])
	})

	it('passes terms and caseSensitive through', () => {
		expect(buildSearchRequest({ terms: ['filtering'], caseSensitive: true }))
			.toEqual({ kind: 'search', terms: ['filtering'], caseSensitive: true, offset: undefined, limit: undefined })
	})
})

describe('buildRelationsRequest', () => {
	it('defaults id to empty string and leaves direction/types undefined when omitted', () => {
		expect(buildRelationsRequest({}))
			.toEqual({ kind: 'relations', id: '', direction: undefined, types: undefined })
	})
})

describe('buildTraceRequest', () => {
	it('defaults roots/types to empty arrays and direction to an empty string, leaving max_depth NaN, when omitted', () => {
		const request = buildTraceRequest({})
		expect(request.roots)
			.toEqual([])
		expect(request.types)
			.toEqual([])
		expect(request.direction)
			.toBe('')
		expect(Number.isNaN(request.maxDepth))
			.toBe(true)
	})

	it('converts a numeric --max-depth string to a number', () => {
		expect(buildTraceRequest({ maxDepth: '4' }).maxDepth)
			.toBe(4)
	})

	it('produces NaN (not a silently accepted 0) for a non-numeric --max-depth', () => {
		expect(Number.isNaN(buildTraceRequest({ maxDepth: 'abc' }).maxDepth))
			.toBe(true)
	})
})

describe('buildImpactRequest', () => {
	it('defaults roots to an empty array and every boolean option to undefined when omitted', () => {
		const request = buildImpactRequest({})
		expect(request.roots)
			.toEqual([])
		expect(request.includeReferences)
			.toBeUndefined()
		expect(request.includeNonCurrent)
			.toBeUndefined()
		expect(request.resolveCurrent)
			.toBeUndefined()
	})
})

describe('buildHistoryRequest / buildResolveCurrentRequest', () => {
	it('default a missing id to an empty string', () => {
		expect(buildHistoryRequest({}))
			.toEqual({ kind: 'history', id: '' })
		expect(buildResolveCurrentRequest({}))
			.toEqual({ kind: 'resolve-current', id: '' })
	})
})
