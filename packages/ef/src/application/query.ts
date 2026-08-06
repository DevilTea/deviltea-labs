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
 * `EF-QRY-013` gate for the four graph-traversal query kinds (`relations`,
 * `trace`, `impact`, `resolve-current`), applied only on `edgeLossArtifactIds`
 * (Finding C) -- never on `relationExtensionLossArtifactIds`
 * (`EF-REL-015`-only loss): a graph query's edges are always exactly
 * `(source, type, target)`, and `EF-REL-015` never removes that pair, so an
 * extension-only discard cannot hide a missing edge from any of these four
 * kinds (`snapshot-validation.ts`'s `edgeLossArtifactIds` field docs).
 *
 * Whether an edge-lossy Artifact can affect THIS traversal depends on the
 * traversal's direction (10-query-and-trace.md "incoming" reads are derived
 * from every Artifact's outgoing `relations` array, so a discarded entry
 * ANYWHERE could hide an edge pointing into the result; an "outgoing"-only
 * traversal only ever walks a visited Artifact's own outgoing array, so a
 * discarded entry on an Artifact the traversal never reaches cannot affect
 * it):
 *
 * - `incoming`-dependent reads (`relations`/`trace` with direction
 *   `incoming`/`both`, and `impact`, whose traversal direction is always
 *   incoming; `EF-QRY-009`/`008` guard `resolve-current`'s own algorithm,
 *   which is outgoing-only) stay gated project-wide, mirroring
 *   `graphTrustworthyFailure`'s reach: `edgeLossGlobalFailure` below.
 * - Purely outgoing traversals (`relations`/`trace` with direction
 *   `outgoing`, and `resolve-current`) are scoped to the traversal's own
 *   result: `edgeLossLocalFailure` below, called AFTER the traversal
 *   succeeds so the visited-node set is known.
 *
 * `lookup`/`list`/`search` are gated instead by the narrower, per-Artifact
 * `projectionLossArtifactIds` check at their own call sites, since those
 * kinds project an Artifact's raw (unsanitized) envelope rather than
 * traversing the sanitized graph.
 */
function edgeLossGlobalFailure(context: QueryContext, kind: QueryKind): QueryResult | undefined {
	if (context.validation.edgeLossArtifactIds.size === 0)
		return undefined
	return failure(kind, 'EF-QRY-013', 'An Artifact\'s declared relations could not be completely sanitized elsewhere in the graph, so the requested relation graph would not be trustworthy.')
}

/**
 * Scoped counterpart of `edgeLossGlobalFailure` for a purely outgoing
 * traversal, applied to its already-computed `visited` node set (Finding C:
 * "at minimum, a clean Artifact's direct outgoing relations must not be
 * blocked by an unrelated invalid entry"). Blocks only when an edge-lossy
 * Artifact is itself part of this traversal's result, or sits immediately
 * adjacent to it via a known-valid (already-sanitized) relation in either
 * direction -- the conservative closure under which a hidden edge on that
 * Artifact could plausibly have altered this specific traversal, without
 * gating every unrelated traversal elsewhere in the project.
 */
function edgeLossLocalFailure(context: QueryContext, kind: QueryKind, visited: ReadonlySet<string>): QueryResult | undefined {
	const { edgeLossArtifactIds, byId, incomingRelations } = context.validation
	for (const id of edgeLossArtifactIds) {
		if (visited.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this traversal's result -- declares a relations entry that could not be completely sanitized, so this graph would not be trustworthy.`)
		if (byId.get(id)?.relations.some(relation => visited.has(relation.target)))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- adjacent to this traversal's result -- declares a relations entry that could not be completely sanitized, so this graph would not be trustworthy.`)
		if ((incomingRelations.get(id) ?? []).some(edge => visited.has(edge.from)))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- adjacent to this traversal's result -- declares a relations entry that could not be completely sanitized, so this graph would not be trustworthy.`)
	}
	return undefined
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

	// Finding A: this projection is built from the raw decoded envelope, not
	// the sanitized graph-index subset -- so any of `projectionLossArtifactIds`'
	// causes (a shape-invalid relation entry, a scalar/malformed Resource
	// entry, a dropped non-string tag, a duplicate core key, ...) is ALSO
	// missing or corrupted in it. Reporting `complete: true` while projecting
	// this specific Artifact would silently present incomplete/altered content
	// as authoritative.
	if (context.validation.projectionLossArtifactIds.has(record.id))
		return failure('lookup', 'EF-QRY-013', `Artifact '${record.id}' declares structured content that could not be completely loaded, so its projected result would not be trustworthy.`)

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

/**
 * Finding B: `matching`/`total` are computed from EVERY Artifact before
 * pagination, so an Artifact whose loss could have changed its own
 * membership determination must be trusted before pagination runs, not only
 * once the returned page is known -- otherwise an affected match sitting
 * outside the requested page silently escapes the check `handleList`
 * previously ran only over `paged`.
 *
 * Scoped per filter surface actually requested (not a whole-project gate):
 * relation loss (`edgeLossArtifactIds` + `relationExtensionLossArtifactIds`)
 * only matters when the request filters by `relationType`/`relationTarget`;
 * Resource loss (`resourceLossArtifactIds`) only when it filters by
 * `resourceType`/`resourceRole`/`resourceNormative`; tag loss
 * (`tagLossArtifactIds`) only when it filters by `tagsAny`/`tagsAll` -- a
 * loss on a surface the request never reads provably cannot have changed
 * this result. `envelopeWideLossArtifactIds` (a duplicate core key or a
 * dropped unknown top-level field) can corrupt ANY core field, including
 * `type`/`status`/`schema`, so it is in scope whenever the request applies
 * any filter at all. A request with NO filters matches every Artifact
 * unconditionally, so no loss anywhere could have changed membership/total;
 * an own-loss Artifact that ends up on the returned page is still caught by
 * the existing per-page check below.
 */
function listMembershipRiskArtifactIds(validation: SnapshotValidationResult, request: ListQueryRequest): ReadonlySet<string> {
	const hasTypeFilter = (request.type?.length ?? 0) > 0
	const hasStatusFilter = (request.status?.length ?? 0) > 0
	const hasSchemaFilter = request.schema !== undefined
	const hasTagsFilter = (request.tagsAny?.length ?? 0) > 0 || (request.tagsAll?.length ?? 0) > 0
	const hasRelationFilter = request.relationType !== undefined || request.relationTarget !== undefined
	const hasResourceFilter = request.resourceType !== undefined || request.resourceRole !== undefined || request.resourceNormative !== undefined
	const hasAnyFilter = hasTypeFilter || hasStatusFilter || hasSchemaFilter || hasTagsFilter || hasRelationFilter || hasResourceFilter

	const ids = new Set<string>()
	if (!hasAnyFilter)
		return ids
	for (const id of validation.envelopeWideLossArtifactIds) ids.add(id)
	if (hasTagsFilter) {
		for (const id of validation.tagLossArtifactIds) ids.add(id)
	}
	if (hasRelationFilter) {
		for (const id of validation.edgeLossArtifactIds) ids.add(id)
		for (const id of validation.relationExtensionLossArtifactIds) ids.add(id)
	}
	if (hasResourceFilter) {
		for (const id of validation.resourceLossArtifactIds) ids.add(id)
	}
	return ids
}

function handleList(context: QueryContext, request: ListQueryRequest): QueryResult {
	const filterError = validateListFilters(request)
	if (filterError)
		return { schema: 'ef/query-result@1', kind: 'list', complete: false, data: null, diagnostics: [filterError] }

	const untrustworthy = graphTrustworthyFailure(context, 'list')
	if (untrustworthy)
		return untrustworthy

	// Finding B: established before `matching`/pagination are computed, over
	// every Artifact in `byId` -- not only the returned page.
	if (listMembershipRiskArtifactIds(context.validation, request).size > 0)
		return failure('list', 'EF-QRY-013', 'One or more Artifacts declare structured content that could not be completely loaded on a surface this request filters, so this result\'s membership or total would not be trustworthy.')

	const offset = request.offset ?? 0
	const limit = request.limit ?? null

	const matching = [...context.validation.byId.values()].filter(record => matchesListFilters(record, request))
	matching.sort((a, b) => compareBytewise(a.id, b.id))

	const total = matching.length
	const paged = limit === null ? matching.slice(offset) : matching.slice(offset, offset + limit)

	// Finding A: only gate when an actually-returned Artifact's own projection
	// would silently omit or corrupt content (see the matching check in
	// `handleLookup`); an affected Artifact excluded by filters or pagination
	// does not appear in this result, and the membership-risk check above
	// already covers whether its loss could have changed who does.
	if (paged.some(record => context.validation.projectionLossArtifactIds.has(record.id)))
		return failure('list', 'EF-QRY-013', 'One or more returned Artifacts declare structured content that could not be completely loaded, so this result would not be trustworthy.')

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

	// Finding B: full-text search always reads `title`/`summary`/`tags`/
	// `resources.location`/`resources.description` for EVERY Artifact
	// (`query-search.ts`'s `buildSurfaces`, unconditionally, regardless of the
	// terms requested) to decide matching/total, so a lost tag, a lost/
	// coerced Resource field, or an envelope-wide loss (duplicate core key /
	// dropped unknown field, which can corrupt `title`/`summary` too) on ANY
	// Artifact could have hidden or altered a match -- unlike `list`, there is
	// no unsearched surface to scope this to. Relation loss is excluded:
	// search never reads `relations` at all, so it cannot affect matching
	// here (an affected Artifact that still ends up in the returned page is
	// caught by the per-page check below instead).
	const searchMembershipRisk = new Set<string>([
		...context.validation.tagLossArtifactIds,
		...context.validation.resourceLossArtifactIds,
		...context.validation.envelopeWideLossArtifactIds,
	])
	if (searchMembershipRisk.size > 0)
		return failure('search', 'EF-QRY-013', 'One or more Artifacts declare structured content that could not be completely loaded on a surface full-text search reads, so this result\'s matching or total would not be trustworthy.')

	const data = executeSearch(context.snapshot, context.validation, prepared, caseSensitive, offset, limit)

	// Finding A: only gate when an actually-returned result's projected
	// Artifact is affected by ANY loss (including relation loss, which does
	// not affect search matching but does still affect the projected output).
	if (data.results.some(entry => context.validation.projectionLossArtifactIds.has(entry.artifact.id)))
		return failure('search', 'EF-QRY-013', 'One or more returned Artifacts declare structured content that could not be completely loaded, so this result would not be trustworthy.')

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

	// Finding C: 'incoming'/'both' reads incoming edges, derived project-wide
	// from every Artifact's outgoing array, so it stays globally gated. Purely
	// 'outgoing' is scoped to this traversal's own result below, once known.
	if (direction === 'incoming' || direction === 'both') {
		const untrustworthyRelationData = edgeLossGlobalFailure(context, 'relations')
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

	if (!context.validation.byId.has(request.id))
		return failure('relations', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const typeSet = new Set<string>(requestedTypes.length > 0 ? requestedTypes : RELATION_TYPES)
	const result = directRelations(request.id, direction as Direction, typeSet, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('relations', 'EF-QRY-007', 'The requested relation graph is invalid.')

	if (direction === 'outgoing') {
		const untrustworthyRelationData = edgeLossLocalFailure(context, 'relations', new Set(result.nodeIds))
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

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

	// Finding C: same 'incoming'/'both' vs 'outgoing' split as `handleRelations`.
	if (request.direction === 'incoming' || request.direction === 'both') {
		const untrustworthyTraceRelationData = edgeLossGlobalFailure(context, 'trace')
		if (untrustworthyTraceRelationData)
			return untrustworthyTraceRelationData
	}

	const missing = request.roots.filter(id => !context.validation.byId.has(id))
	if (missing.length > 0) {
		return failure('trace', 'EF-QRY-014', `Artifact ID(s) not found: ${dedupeSortIds(missing)
			.join(', ')}.`)
	}

	const typeSet = new Set(request.types)
	const result = traceGraph(request.roots, request.direction as Direction, typeSet, request.maxDepth, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('trace', 'EF-QRY-007', 'The requested relation graph is invalid.')

	if (request.direction === 'outgoing') {
		const untrustworthyTraceRelationData = edgeLossLocalFailure(context, 'trace', new Set(result.depths.keys()))
		if (untrustworthyTraceRelationData)
			return untrustworthyTraceRelationData
	}

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

	// Finding C: impact traversal direction is always incoming
	// (10-query-and-trace.md "Traversal direction is incoming"), so it stays
	// globally gated regardless of request options.
	const untrustworthyImpactRelationData = edgeLossGlobalFailure(context, 'impact')
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

	if (!context.validation.byId.has(request.id))
		return failure('resolve-current', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const facts = buildSupersessionFacts(context.validation.byId)
	const outcome = resolveCurrentForQuery(request.id, facts)
	if (!outcome.ok) {
		const code: DiagnosticCode = outcome.reason === 'unsupported-type' ? 'EF-QRY-009' : 'EF-QRY-008'
		return failure('resolve-current', code, `Current resolution for '${request.id}' failed (${outcome.reason}).`)
	}

	// Finding C: current resolution follows `superseded-by` edges strictly
	// outgoing from the input ID (05-supersession "Current-resolution
	// algorithm"), so it is scoped to this result's own node set, the same as
	// an outgoing-only `relations`/`trace` traversal.
	const untrustworthyRelationData = edgeLossLocalFailure(context, 'resolve-current', new Set(outcome.result.nodeIds))
	if (untrustworthyRelationData)
		return untrustworthyRelationData

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
