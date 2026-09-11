/**
 * CLI-argument -> `QueryRequest` construction (13-cli-contract.md "Query
 * Commands"; 10-query-and-trace.md "Filters", "Structured List").
 *
 * These builders perform only type conversion (string -> number/boolean),
 * never domain validation: an omitted, empty, or malformed value is passed
 * through as the value that makes `../../application/query.ts`'s own
 * existing checks (`EF-QRY-001/002/005/006`) fail exactly as they would for
 * any other invalid request, rather than duplicating that validation here.
 * The one exception is `--resource-normative`, whose value must already be a
 * real `boolean` by the time it reaches `ListQueryRequest` (`query.ts` has no
 * string-to-boolean coercion or validation of its own for this field) --
 * only there does this module construct its own `EF-QRY-002` result.
 */

import type {
	HistoryQueryRequest,
	ImpactQueryRequest,
	ListQueryRequest,
	LookupQueryRequest,
	QueryResult,
	RelationsQueryRequest,
	ResolveCurrentQueryRequest,
	SearchQueryRequest,
	TraceQueryRequest,
} from '../../application/query-types'

function toNumberOrUndefined(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value)
}

function toRequiredNumber(value: string | undefined): number {
	return value === undefined ? Number.NaN : Number(value)
}

export interface RawLookupArgs { id?: string, projection?: string }
export function buildLookupRequest(args: RawLookupArgs): LookupQueryRequest {
	return { kind: 'lookup', id: args.id ?? '', projection: args.projection }
}

export interface RawListArgs {
	type?: readonly string[]
	status?: readonly string[]
	schema?: string
	tagAny?: readonly string[]
	tagAll?: readonly string[]
	relationType?: string
	relationTarget?: string
	resourceType?: string
	resourceRole?: string
	resourceNormative?: string
	offset?: string
	limit?: string
}
export type BuildListRequestResult = { ok: true, request: ListQueryRequest } | { ok: false, result: QueryResult }
export function buildListRequest(args: RawListArgs): BuildListRequestResult {
	let resourceNormative: boolean | undefined
	if (args.resourceNormative !== undefined) {
		if (args.resourceNormative === 'true') {
			resourceNormative = true
		}
		else if (args.resourceNormative === 'false') {
			resourceNormative = false
		}
		else {
			return {
				ok: false,
				result: {
					schema: 'ef/query-result@1',
					kind: 'list',
					complete: false,
					data: null,
					diagnostics: [{ code: 'EF-QRY-002', severity: 'error', message: `'--resource-normative' must be 'true' or 'false', got '${args.resourceNormative}'.`, related: [] }],
				},
			}
		}
	}

	return {
		ok: true,
		request: {
			kind: 'list',
			type: args.type,
			status: args.status,
			schema: args.schema,
			tagsAny: args.tagAny,
			tagsAll: args.tagAll,
			relationType: args.relationType,
			relationTarget: args.relationTarget,
			resourceType: args.resourceType,
			resourceRole: args.resourceRole,
			resourceNormative,
			offset: toNumberOrUndefined(args.offset),
			limit: toNumberOrUndefined(args.limit),
		},
	}
}

export interface RawSearchArgs { terms?: readonly string[], caseSensitive?: boolean, offset?: string, limit?: string }
export function buildSearchRequest(args: RawSearchArgs): SearchQueryRequest {
	return {
		kind: 'search',
		terms: args.terms ?? [],
		caseSensitive: args.caseSensitive,
		offset: toNumberOrUndefined(args.offset),
		limit: toNumberOrUndefined(args.limit),
	}
}

export interface RawRelationsArgs { id?: string, direction?: string, types?: readonly string[] }
export function buildRelationsRequest(args: RawRelationsArgs): RelationsQueryRequest {
	return { kind: 'relations', id: args.id ?? '', direction: args.direction, types: args.types }
}

export interface RawTraceArgs { roots?: readonly string[], types?: readonly string[], direction?: string, maxDepth?: string }
export function buildTraceRequest(args: RawTraceArgs): TraceQueryRequest {
	return {
		kind: 'trace',
		roots: args.roots ?? [],
		types: args.types ?? [],
		direction: args.direction ?? '',
		maxDepth: toRequiredNumber(args.maxDepth),
	}
}

export interface RawImpactArgs {
	roots?: readonly string[]
	maxDepth?: string
	includeReferences?: boolean
	includeNonCurrent?: boolean
	resolveCurrent?: boolean
}
export function buildImpactRequest(args: RawImpactArgs): ImpactQueryRequest {
	return {
		kind: 'impact',
		roots: args.roots ?? [],
		maxDepth: toRequiredNumber(args.maxDepth),
		includeReferences: args.includeReferences,
		includeNonCurrent: args.includeNonCurrent,
		resolveCurrent: args.resolveCurrent,
	}
}

export interface RawHistoryArgs { id?: string }
export function buildHistoryRequest(args: RawHistoryArgs): HistoryQueryRequest {
	return { kind: 'history', id: args.id ?? '' }
}

export interface RawResolveCurrentArgs { id?: string }
export function buildResolveCurrentRequest(args: RawResolveCurrentArgs): ResolveCurrentQueryRequest {
	return { kind: 'resolve-current', id: args.id ?? '' }
}
