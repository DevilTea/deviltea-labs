/**
 * `executeQuery` (10-query-and-trace.md): the single read-only entry point
 * for every EF Core v1 query kind, over one already-loaded `ProjectSnapshot`
 * (./snapshot) plus its `SnapshotValidationResult` (./snapshot-validation)
 * indexes.
 *
 * Every handler validates its own request shape first (`EF-QRY-001/002/004
 * /005/006`, "before graph traversal"), then required-ID existence
 * (`EF-QRY-014`), then performs the kind-specific graph work, which can still
 * fail locally with a graph-invalid code (`EF-QRY-007/008/009`) or, for
 * history, an unavailable-history code (`EF-QRY-010`). `EF-QRY-011`
 * (stale/corrupt cache ignored) and `EF-QRY-012` (unsupported normalization/
 * index version) are registered codes this module never emits: it has no
 * cache or persisted index of its own, so neither condition can occur.
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { GitRepository } from '../git/repository'
import type { ArtifactSummaryProjection } from './query-projection'
import type {
	Direction,
	HistoryData,
	HistoryQueryRequest,
	ImpactData,
	ImpactQueryRequest,
	ListData,
	ListQueryRequest,
	LookupData,
	LookupQueryRequest,
	QueryKind,
	QueryRequest,
	QueryResult,
	RelationEdgeData,
	RelationsData,
	RelationsQueryRequest,
	ResolveCurrentData,
	ResolveCurrentQueryRequest,
	SearchData,
	SearchQueryRequest,
	TraceData,
	TraceQueryRequest,
} from './query-types'
import type { ProjectSnapshot, SnapshotArtifactFile } from './snapshot'
import type { SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
import { severityOf } from '../domain/diagnostic-codes'
import { ARTIFACT_TYPES, compareBytewise, RELATION_TYPES, STATUSES } from '../domain/model'
import { prepareSearchTerms } from './case-folding'
import {
	buildNodeSummaries,
	buildSupersessionFacts,
	dedupeSortIds,
	directRelations,
	impactGraph,
	mergeResolveCurrentResults,
	resolveCurrentForQuery,
	traceGraph,
} from './query-graph'
import { computeHistory } from './query-history'
import { buildArtifactFull, buildArtifactSummary } from './query-projection'
import { executeSearch } from './query-search'

export { canonicalArtifactPath } from './query-projection'
export type { ArtifactFullProjection, ArtifactSummaryProjection } from './query-projection'
export type {
	DepthNodeData,
	Direction,
	HistoryCommitData,
	HistoryData,
	HistoryEffectData,
	HistoryQueryRequest,
	ImpactData,
	ImpactQueryRequest,
	ListData,
	ListQueryRequest,
	LookupData,
	LookupQueryRequest,
	QueryKind,
	QueryRequest,
	QueryResult,
	RelationEdgeData,
	RelationsData,
	RelationsQueryRequest,
	ResolveCurrentData,
	ResolveCurrentQueryRequest,
	SearchData,
	SearchMatchData,
	SearchQueryRequest,
	SearchResultEntryData,
	TraceData,
	TraceQueryRequest,
} from './query-types'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HistoryQueryContext {
	git: GitRepository
	/** The operation-start captured OID the configured `integration_ref` resolved to (10-query-and-trace.md "Query snapshot"). */
	integrationRefOid: string
}

export interface QueryContext {
	snapshot: ProjectSnapshot
	validation: SnapshotValidationResult
	/** Required only for `kind: 'history'`; every other kind ignores it. */
	history?: HistoryQueryContext
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function queryDiagnostic(code: DiagnosticCode, message: string): Diagnostic {
	return { code, severity: severityOf(code), message, related: [] }
}

function failure(kind: QueryKind, code: DiagnosticCode, message: string): QueryResult {
	return {
		schema: 'ef/query-result@1',
		kind,
		complete: false,
		data: null,
		diagnostics: [queryDiagnostic(code, message)],
	} as QueryResult
}

/**
 * The `EF-QRY-013` incomplete-query envelope for an incomplete working-tree
 * initialization discovered before authoritative files could be loaded
 * (10-query-and-trace.md "Invalid Graph and Partial Results": "Query
 * operations report it as EF-QRY-013 ... rather than emitting the
 * validation-owned EF-VAL-012."). The CLI layer calls this directly -- before
 * even attempting to build a `QueryContext` -- when project discovery
 * reports an incomplete initialization.
 */
export function incompleteInitializationQueryResult(kind: QueryKind): QueryResult {
	return failure(kind, 'EF-QRY-013', 'An incomplete working-tree initialization was discovered before authoritative files could be loaded.')
}

/**
 * The shared `EF-QRY-013` prerequisite gate every handler below applies right
 * after its own request-shape validation and before touching `byId` or
 * performing any graph work (10-query-and-trace.md "Invalid Graph and Partial
 * Results"). `context.validation.graphTrustworthy` is `false` whenever a
 * parse/identity/layout condition means `byId` and its dependent indexes
 * cannot be trusted as complete (`snapshot-validation.ts`): an Artifact file
 * failed to decode, an ID is ambiguous, or a layout entry could itself be an
 * unparsed Artifact. In that case EVERY query kind -- including exact lookup,
 * whose "not found" is otherwise a normal complete result -- returns
 * `complete: false`, `data: null` here, rather than risking a `list`/`search`
 * result silently missing an undecoded Artifact, or a `lookup` reporting a
 * merely-ambiguous ID as an ordinary not-found.
 *
 * This is intentionally broader than the localized "graph invalid" detection
 * `./query-graph.ts` performs for a traversal that actually reaches a
 * dangling target (`EF-QRY-007`/`008`): those stay scoped to the specific
 * query that touches the bad edge, and are unaffected by (and still fire
 * independently of) this prerequisite check.
 */
function graphTrustworthyFailure(context: QueryContext, kind: QueryKind): QueryResult | undefined {
	if (context.validation.graphTrustworthy)
		return undefined
	return failure(kind, 'EF-QRY-013', 'The Artifact graph could not be completely and unambiguously loaded, so the query result would not be trustworthy.')
}

/**
 * Additional `EF-QRY-013` prerequisite gate for the four graph-traversal
 * query kinds (`relations`, `trace`, `impact`, `resolve-current`), applied
 * right alongside `graphTrustworthyFailure` above (Finding A,
 * `snapshot-validation.ts`'s `discardedRelationData` field docs).
 * `context.validation.discardedRelationData` is `true` when ANY Artifact's
 * raw relations array had at least one entry excluded while
 * `validateRelationEntries` sanitized it into the subset these four kinds
 * traverse (`incomingRelations`/`byId[].relations`/`chgEffects`). Because
 * that sanitized subset is built project-wide, a discarded entry on any
 * Artifact -- not only the one a given traversal starts from -- could be a
 * missing edge the traversal should have seen, so this gates every one of
 * these kinds regardless of which Artifact they touch, mirroring
 * `graphTrustworthyFailure`'s project-wide reach but scoped to relation-entry
 * sanitization specifically. `lookup`/`list`/`search` are gated instead by
 * the narrower, per-Artifact `artifactsWithDiscardedRelationData` check at
 * their own call sites below, since those kinds project an Artifact's raw
 * (unsanitized) relations rather than traversing the sanitized graph.
 */
function relationDataTrustworthyFailure(context: QueryContext, kind: QueryKind): QueryResult | undefined {
	if (!context.validation.discardedRelationData)
		return undefined
	return failure(kind, 'EF-QRY-013', 'An Artifact\'s declared relations could not be completely sanitized elsewhere in the graph, so the requested relation graph would not be trustworthy.')
}

const DIRECTIONS: ReadonlySet<string> = new Set(['outgoing', 'incoming', 'both'])
const RELATION_TYPE_SET: ReadonlySet<string> = new Set(RELATION_TYPES)
const CORE_IMPACT_TYPES = ['derived-from', 'addresses', 'governed-by'] as const

function isValidOffset(offset: number): boolean {
	return Number.isInteger(offset) && offset >= 0
}

function isValidLimit(limit: number | null): boolean {
	return limit === null || (Number.isInteger(limit) && limit > 0)
}

function dedupePreserveOrder(items: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const item of items) {
		if (seen.has(item))
			continue
		seen.add(item)
		out.push(item)
	}
	return out
}

function findArtifactFile(snapshot: ProjectSnapshot, path: string): SnapshotArtifactFile | undefined {
	return snapshot.artifacts.find(artifact => artifact.path === path)
}

function bodyTextFor(snapshot: ProjectSnapshot, path: string): string {
	const file = findArtifactFile(snapshot, path)
	return file?.frontmatter.ok ? file.frontmatter.bodyText : ''
}

function nodeSummariesByDepth(depths: ReadonlyMap<string, number>, byId: ReadonlyMap<string, SnapshotArtifactRecord>, ids?: ReadonlySet<string>): { artifact: ArtifactSummaryProjection, depth: number }[] {
	const entries = [...depths.entries()].filter(([id]) => !ids || ids.has(id))
	entries.sort((a, b) => a[1] - b[1] || compareBytewise(a[0], b[0]))
	return entries.map(([id, depth]) => {
		const record = byId.get(id)!
		return { artifact: buildArtifactSummary(record.envelope, record.path), depth }
	})
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

function handleLookup(context: QueryContext, request: LookupQueryRequest): QueryResult {
	if (request.id.length === 0)
		return failure('lookup', 'EF-QRY-001', 'Lookup requires a non-empty Artifact ID.')

	const projection = request.projection ?? 'full'
	if (projection !== 'summary' && projection !== 'full')
		return failure('lookup', 'EF-QRY-004', `Unsupported lookup projection '${projection}'.`)

	const untrustworthy = graphTrustworthyFailure(context, 'lookup')
	if (untrustworthy)
		return untrustworthy

	const record = context.validation.byId.get(request.id)
	if (!record) {
		return {
			schema: 'ef/query-result@1',
			kind: 'lookup',
			complete: true,
			data: { found: false, artifact: null },
			diagnostics: [queryDiagnostic('EF-QRY-003', `Artifact '${request.id}' was not found.`)],
		}
	}

	// Finding A: this projection is built from `record.envelope.relations` --
	// the raw decoded relations, not the sanitized graph-index subset -- so a
	// shape-invalid entry (`EF-REL-002`) discarded during sanitization is ALSO
	// missing from it (an envelope can only decode a relation entry that is
	// itself a YAML mapping). Reporting `complete: true` while projecting
	// this specific Artifact would silently omit that content.
	if (context.validation.artifactsWithDiscardedRelationData.has(record.id))
		return failure('lookup', 'EF-QRY-013', `Artifact '${record.id}' declares a relations entry that could not be completely loaded, so its projected result would not be trustworthy.`)

	const artifact = projection === 'full'
		? buildArtifactFull(record.envelope, record.path, bodyTextFor(context.snapshot, record.path))
		: buildArtifactSummary(record.envelope, record.path)

	return {
		schema: 'ef/query-result@1',
		kind: 'lookup',
		complete: true,
		data: { found: true, artifact },
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function validateListFilters(request: ListQueryRequest): Diagnostic | undefined {
	for (const type of request.type ?? []) {
		if (!(ARTIFACT_TYPES as readonly string[]).includes(type))
			return queryDiagnostic('EF-QRY-002', `Unknown Artifact type '${type}'.`)
	}
	for (const status of request.status ?? []) {
		if (!(STATUSES as readonly string[]).includes(status))
			return queryDiagnostic('EF-QRY-002', `Unknown status '${status}'.`)
	}
	if (request.relationType !== undefined && !RELATION_TYPE_SET.has(request.relationType))
		return queryDiagnostic('EF-QRY-002', `Unknown relation type '${request.relationType}'.`)
	const offset = request.offset ?? 0
	if (!isValidOffset(offset))
		return queryDiagnostic('EF-QRY-002', '\'offset\' must be a non-negative integer.')
	const limit = request.limit ?? null
	if (!isValidLimit(limit))
		return queryDiagnostic('EF-QRY-002', '\'limit\' must be a positive integer or null.')
	return undefined
}

function matchesListFilters(record: SnapshotArtifactRecord, request: ListQueryRequest): boolean {
	const envelope = record.envelope

	if (request.type && request.type.length > 0 && !request.type.includes(envelope.type))
		return false
	if (request.status && request.status.length > 0 && !request.status.includes(envelope.status))
		return false
	if (request.schema !== undefined && envelope.schema !== request.schema)
		return false
	if (request.tagsAny && request.tagsAny.length > 0 && !request.tagsAny.some(tag => envelope.tags.includes(tag)))
		return false
	if (request.tagsAll && request.tagsAll.length > 0 && !request.tagsAll.every(tag => envelope.tags.includes(tag)))
		return false

	if (request.relationType !== undefined || request.relationTarget !== undefined) {
		const matches = envelope.relations.some(relation =>
			(request.relationType === undefined || relation.type === request.relationType)
			&& (request.relationTarget === undefined || relation.target === request.relationTarget))
		if (!matches)
			return false
	}

	if (request.resourceType !== undefined || request.resourceRole !== undefined || request.resourceNormative !== undefined) {
		const matches = envelope.resources.some(resource =>
			(request.resourceType === undefined || resource.type === request.resourceType)
			&& (request.resourceRole === undefined || resource.role === request.resourceRole)
			&& (request.resourceNormative === undefined || resource.normative === request.resourceNormative))
		if (!matches)
			return false
	}

	return true
}

function handleList(context: QueryContext, request: ListQueryRequest): QueryResult {
	const filterError = validateListFilters(request)
	if (filterError)
		return { schema: 'ef/query-result@1', kind: 'list', complete: false, data: null, diagnostics: [filterError] }

	const untrustworthy = graphTrustworthyFailure(context, 'list')
	if (untrustworthy)
		return untrustworthy

	const offset = request.offset ?? 0
	const limit = request.limit ?? null

	const matching = [...context.validation.byId.values()].filter(record => matchesListFilters(record, request))
	matching.sort((a, b) => compareBytewise(a.id, b.id))

	const total = matching.length
	const paged = limit === null ? matching.slice(offset) : matching.slice(offset, offset + limit)

	// Finding A: only gate when an actually-returned Artifact's projection
	// would silently omit sanitized-away relation content (see the matching
	// check in `handleLookup`); an affected Artifact excluded by filters or
	// pagination does not appear in this result, so it cannot make this
	// result's `complete: true` claim false.
	if (paged.some(record => context.validation.artifactsWithDiscardedRelationData.has(record.id)))
		return failure('list', 'EF-QRY-013', 'One or more returned Artifacts declare a relations entry that could not be completely loaded, so this result would not be trustworthy.')

	return {
		schema: 'ef/query-result@1',
		kind: 'list',
		complete: true,
		data: { total, offset, limit, artifacts: paged.map(record => buildArtifactSummary(record.envelope, record.path)) },
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function handleSearch(context: QueryContext, request: SearchQueryRequest): QueryResult {
	if (request.terms.length === 0)
		return failure('search', 'EF-QRY-001', 'Search requires at least one term.')

	const offset = request.offset ?? 0
	if (!isValidOffset(offset))
		return failure('search', 'EF-QRY-002', '\'offset\' must be a non-negative integer.')
	const limit = request.limit ?? null
	if (!isValidLimit(limit))
		return failure('search', 'EF-QRY-002', '\'limit\' must be a positive integer or null.')

	const caseSensitive = request.caseSensitive ?? false
	const prepared = prepareSearchTerms(request.terms, caseSensitive)
	if (!prepared)
		return failure('search', 'EF-QRY-002', 'A search term is empty before or after normalization.')

	const untrustworthy = graphTrustworthyFailure(context, 'search')
	if (untrustworthy)
		return untrustworthy

	const data = executeSearch(context.snapshot, context.validation, prepared, caseSensitive, offset, limit)

	// Finding A: same per-artifact reasoning as `handleList` -- only gate when
	// an actually-returned result's projected Artifact is affected.
	if (data.results.some(entry => context.validation.artifactsWithDiscardedRelationData.has(entry.artifact.id)))
		return failure('search', 'EF-QRY-013', 'One or more returned Artifacts declare a relations entry that could not be completely loaded, so this result would not be trustworthy.')

	return { schema: 'ef/query-result@1', kind: 'search', complete: true, data, diagnostics: [] }
}

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------

function handleRelations(context: QueryContext, request: RelationsQueryRequest): QueryResult {
	if (request.id.length === 0)
		return failure('relations', 'EF-QRY-001', 'Direct relations lookup requires a non-empty Artifact ID.')

	const direction = request.direction ?? 'both'
	if (!DIRECTIONS.has(direction))
		return failure('relations', 'EF-QRY-006', `Unknown direction '${direction}'.`)

	const requestedTypes = request.types ?? []
	for (const type of requestedTypes) {
		if (!RELATION_TYPE_SET.has(type))
			return failure('relations', 'EF-QRY-002', `Unknown relation type '${type}'.`)
	}

	const untrustworthy = graphTrustworthyFailure(context, 'relations')
	if (untrustworthy)
		return untrustworthy

	const untrustworthyRelationData = relationDataTrustworthyFailure(context, 'relations')
	if (untrustworthyRelationData)
		return untrustworthyRelationData

	if (!context.validation.byId.has(request.id))
		return failure('relations', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const typeSet = new Set<string>(requestedTypes.length > 0 ? requestedTypes : RELATION_TYPES)
	const result = directRelations(request.id, direction as Direction, typeSet, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('relations', 'EF-QRY-007', 'The requested relation graph is invalid.')

	return {
		schema: 'ef/query-result@1',
		kind: 'relations',
		complete: true,
		data: {
			artifact_id: request.id,
			direction: direction as Direction,
			types: dedupePreserveOrder(requestedTypes),
			nodes: buildNodeSummaries(result.nodeIds, context.validation.byId),
			edges: result.edges,
		},
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

function handleTrace(context: QueryContext, request: TraceQueryRequest): QueryResult {
	if (request.roots.length === 0)
		return failure('trace', 'EF-QRY-001', 'Trace requires at least one root Artifact ID.')
	if (request.types.length === 0)
		return failure('trace', 'EF-QRY-005', 'Trace requires a non-empty relation type set.')
	if (!DIRECTIONS.has(request.direction))
		return failure('trace', 'EF-QRY-006', `Unknown direction '${request.direction}'.`)
	if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0)
		return failure('trace', 'EF-QRY-006', '\'max_depth\' must be a non-negative integer.')
	for (const type of request.types) {
		if (!RELATION_TYPE_SET.has(type))
			return failure('trace', 'EF-QRY-002', `Unknown relation type '${type}'.`)
	}

	const untrustworthyTrace = graphTrustworthyFailure(context, 'trace')
	if (untrustworthyTrace)
		return untrustworthyTrace

	const untrustworthyTraceRelationData = relationDataTrustworthyFailure(context, 'trace')
	if (untrustworthyTraceRelationData)
		return untrustworthyTraceRelationData

	const missing = request.roots.filter(id => !context.validation.byId.has(id))
	if (missing.length > 0) {
		return failure('trace', 'EF-QRY-014', `Artifact ID(s) not found: ${dedupeSortIds(missing)
			.join(', ')}.`)
	}

	const typeSet = new Set(request.types)
	const result = traceGraph(request.roots, request.direction as Direction, typeSet, request.maxDepth, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('trace', 'EF-QRY-007', 'The requested relation graph is invalid.')

	return {
		schema: 'ef/query-result@1',
		kind: 'trace',
		complete: true,
		data: {
			roots: dedupeSortIds(request.roots),
			types: dedupePreserveOrder(request.types),
			direction: request.direction as Direction,
			max_depth: request.maxDepth,
			nodes: nodeSummariesByDepth(result.depths, context.validation.byId),
			edges: result.edges,
		},
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

function handleImpact(context: QueryContext, request: ImpactQueryRequest): QueryResult {
	if (request.roots.length === 0)
		return failure('impact', 'EF-QRY-001', 'Impact requires at least one root Artifact ID.')
	if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0)
		return failure('impact', 'EF-QRY-006', '\'max_depth\' must be a non-negative integer.')

	const untrustworthyImpact = graphTrustworthyFailure(context, 'impact')
	if (untrustworthyImpact)
		return untrustworthyImpact

	const untrustworthyImpactRelationData = relationDataTrustworthyFailure(context, 'impact')
	if (untrustworthyImpactRelationData)
		return untrustworthyImpactRelationData

	const missing = request.roots.filter(id => !context.validation.byId.has(id))
	if (missing.length > 0) {
		return failure('impact', 'EF-QRY-014', `Artifact ID(s) not found: ${dedupeSortIds(missing)
			.join(', ')}.`)
	}

	const includeReferences = request.includeReferences ?? false
	const includeNonCurrent = request.includeNonCurrent ?? false
	const resolveCurrentFlag = request.resolveCurrent ?? false

	const typeSet = new Set<string>(CORE_IMPACT_TYPES)
	if (includeReferences)
		typeSet.add('references')

	let resolvedRoots: string[]
	let resolution: { nodes: ArtifactSummaryProjection[], edges: RelationEdgeData[] }

	if (resolveCurrentFlag) {
		const facts = buildSupersessionFacts(context.validation.byId)
		const perRoot = []
		for (const root of dedupeSortIds(request.roots)) {
			const outcome = resolveCurrentForQuery(root, facts)
			if (!outcome.ok) {
				const code: DiagnosticCode = outcome.reason === 'unsupported-type' ? 'EF-QRY-009' : 'EF-QRY-008'
				return failure('impact', code, `Current resolution for '${root}' failed (${outcome.reason}).`)
			}
			perRoot.push(outcome.result)
		}
		const merged = mergeResolveCurrentResults(perRoot)
		resolvedRoots = merged.currentIds
		resolution = { nodes: buildNodeSummaries(merged.nodeIds, context.validation.byId), edges: merged.edges }
	}
	else {
		resolvedRoots = dedupeSortIds(request.roots)
		resolution = { nodes: [], edges: [] }
	}

	const traversal = impactGraph(resolvedRoots, typeSet, request.maxDepth, includeNonCurrent, context.validation.byId, context.validation.incomingRelations)
	if (!traversal)
		return failure('impact', 'EF-QRY-007', 'The requested relation graph is invalid.')

	return {
		schema: 'ef/query-result@1',
		kind: 'impact',
		complete: true,
		data: {
			roots: dedupeSortIds(request.roots),
			resolved_roots: resolvedRoots,
			max_depth: request.maxDepth,
			include_references: includeReferences,
			include_non_current: includeNonCurrent,
			resolve_current: resolveCurrentFlag,
			resolution,
			impact: { nodes: nodeSummariesByDepth(traversal.depths, context.validation.byId, traversal.includedIds), edges: traversal.edges },
		},
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// resolve-current
// ---------------------------------------------------------------------------

function handleResolveCurrent(context: QueryContext, request: ResolveCurrentQueryRequest): QueryResult {
	if (request.id.length === 0)
		return failure('resolve-current', 'EF-QRY-001', 'Current resolution requires a non-empty Artifact ID.')

	const untrustworthy = graphTrustworthyFailure(context, 'resolve-current')
	if (untrustworthy)
		return untrustworthy

	const untrustworthyRelationData = relationDataTrustworthyFailure(context, 'resolve-current')
	if (untrustworthyRelationData)
		return untrustworthyRelationData

	if (!context.validation.byId.has(request.id))
		return failure('resolve-current', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const facts = buildSupersessionFacts(context.validation.byId)
	const outcome = resolveCurrentForQuery(request.id, facts)
	if (!outcome.ok) {
		const code: DiagnosticCode = outcome.reason === 'unsupported-type' ? 'EF-QRY-009' : 'EF-QRY-008'
		return failure('resolve-current', code, `Current resolution for '${request.id}' failed (${outcome.reason}).`)
	}

	return {
		schema: 'ef/query-result@1',
		kind: 'resolve-current',
		complete: true,
		data: {
			input_id: request.id,
			current_ids: outcome.result.currentIds,
			nodes: buildNodeSummaries(outcome.result.nodeIds, context.validation.byId),
			edges: outcome.result.edges,
		},
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function handleHistory(context: QueryContext, request: HistoryQueryRequest): Promise<QueryResult> {
	if (request.id.length === 0)
		return failure('history', 'EF-QRY-001', 'History lookup requires a non-empty Artifact ID.')

	const untrustworthy = graphTrustworthyFailure(context, 'history')
	if (untrustworthy)
		return untrustworthy

	const record = context.validation.byId.get(request.id)
	if (!record)
		return failure('history', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	if (!context.history)
		return failure('history', 'EF-QRY-010', 'Required history context is unavailable.')

	const outcome = await computeHistory(context.history.git, context.history.integrationRefOid, request.id, record.type, context.validation.byId)
	// `EF-QRY-010` ("Requested history context is unavailable",
	// diagnostic-registry.md) covers the required Git history itself being
	// inaccessible; `EF-QRY-013` ("Query cannot produce a complete
	// trustworthy result", diagnostic-registry.md) covers a path/blob the
	// walk touched that cannot be trusted (see `computeHistory`'s
	// `ComputeHistoryResult` docs for the exact split).
	if (outcome.kind === 'history-unavailable')
		return failure('history', 'EF-QRY-010', 'Required Git integration history could not be completely materialized.')
	if (outcome.kind === 'untrusted-data') {
		return failure('history', 'EF-QRY-013', 'A path or historical record needed to compute this Artifact\'s history could not be completely and trustworthily read.')
	}

	return {
		schema: 'ef/query-result@1',
		kind: 'history',
		complete: true,
		data: { artifact_id: request.id, effects: outcome.effects, commits: outcome.commits },
		diagnostics: [],
	}
}

// ---------------------------------------------------------------------------
// executeQuery
// ---------------------------------------------------------------------------

interface ResultEnvelope<K extends QueryKind, D> {
	schema: 'ef/query-result@1'
	kind: K
	complete: boolean
	data: D | null
	diagnostics: Diagnostic[]
}

// Overloads let a call site whose request literal narrows to one specific
// `kind` (the overwhelmingly common usage) get back the matching narrowed
// result type instead of the full `QueryResult` union, without callers
// having to manually discriminate on `result.kind` first.
export function executeQuery(context: QueryContext, request: LookupQueryRequest): Promise<ResultEnvelope<'lookup', LookupData>>
export function executeQuery(context: QueryContext, request: ListQueryRequest): Promise<ResultEnvelope<'list', ListData>>
export function executeQuery(context: QueryContext, request: SearchQueryRequest): Promise<ResultEnvelope<'search', SearchData>>
export function executeQuery(context: QueryContext, request: RelationsQueryRequest): Promise<ResultEnvelope<'relations', RelationsData>>
export function executeQuery(context: QueryContext, request: TraceQueryRequest): Promise<ResultEnvelope<'trace', TraceData>>
export function executeQuery(context: QueryContext, request: ImpactQueryRequest): Promise<ResultEnvelope<'impact', ImpactData>>
export function executeQuery(context: QueryContext, request: ResolveCurrentQueryRequest): Promise<ResultEnvelope<'resolve-current', ResolveCurrentData>>
export function executeQuery(context: QueryContext, request: HistoryQueryRequest): Promise<ResultEnvelope<'history', HistoryData>>
export function executeQuery(context: QueryContext, request: QueryRequest): Promise<QueryResult>
export async function executeQuery(context: QueryContext, request: QueryRequest): Promise<QueryResult> {
	switch (request.kind) {
		case 'lookup':
			return handleLookup(context, request)
		case 'list':
			return handleList(context, request)
		case 'search':
			return handleSearch(context, request)
		case 'relations':
			return handleRelations(context, request)
		case 'trace':
			return handleTrace(context, request)
		case 'impact':
			return handleImpact(context, request)
		case 'resolve-current':
			return handleResolveCurrent(context, request)
		case 'history':
			return handleHistory(context, request)
	}
}
