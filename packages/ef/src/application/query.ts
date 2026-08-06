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
import type { ResourceFieldName, SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
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
 * `trace`, `impact`, `resolve-current`), applied on every artifact-scoped
 * edge-fact this module tracks: `edgeLossArtifactIds` (shape/vocabulary loss
 * that can hide an edge) AND `semanticEdgeLossArtifactIds` (an edge that is
 * present but semantically invalid -- `EF-REL-004` incompatible source/target,
 * `EF-REL-008` `derived-from` cycle membership; sixth-round Finding 6) --
 * never `relationExtensionLossArtifactIds` (`EF-REL-015`-only loss): a graph
 * query's edges are always exactly `(source, type, target)`, and `EF-REL-015`
 * never removes or alters that pair, so an extension-only discard cannot hide
 * or corrupt an edge for any of these four kinds
 * (`snapshot-validation.ts`'s `edgeLossArtifactIds` field docs).
 *
 * Whether an edge-invalid Artifact can affect THIS traversal depends on the
 * traversal's direction (10-query-and-trace.md "incoming" reads are derived
 * from every Artifact's outgoing `relations` array, so a discarded/invalid
 * entry ANYWHERE could hide or corrupt an edge pointing into the result; an
 * "outgoing"-only traversal only ever walks the outgoing array of an
 * Artifact whose array it actually expanded, so an Artifact whose array the
 * traversal never read cannot affect it -- Finding 8):
 *
 * - `incoming`-dependent reads (`relations`/`trace` with direction
 *   `incoming`/`both`, and `impact`, whose traversal direction is always
 *   incoming; `EF-QRY-009`/`008` guard `resolve-current`'s own algorithm,
 *   which is outgoing-only) stay gated project-wide, mirroring
 *   `graphTrustworthyFailure`'s reach: `edgeTrustGlobalFailure` below.
 * - Purely outgoing traversals (`relations`/`trace` with direction
 *   `outgoing`, and `resolve-current`) are scoped to exactly the Artifact IDs
 *   whose own outgoing array the traversal actually consulted:
 *   `edgeTrustLocalFailure` below.
 *
 * `lookup`/`list`/`search` are gated instead by the narrower, per-Artifact
 * `projectionLossArtifactIds` check at their own call sites, since those
 * kinds project an Artifact's raw (unsanitized) envelope rather than
 * traversing the sanitized graph.
 */
function edgeTrustGlobalFailure(context: QueryContext, kind: QueryKind): QueryResult | undefined {
	const { edgeLossArtifactIds, semanticEdgeLossArtifactIds } = context.validation
	if (edgeLossArtifactIds.size === 0 && semanticEdgeLossArtifactIds.size === 0)
		return undefined
	return failure(kind, 'EF-QRY-013', 'An Artifact\'s declared relations could not be completely sanitized, or were semantically invalid, elsewhere in the graph, so the requested relation graph would not be trustworthy.')
}

/**
 * Scoped counterpart of `edgeTrustGlobalFailure` for a purely outgoing
 * traversal (Finding 8), applied to exactly the Artifact IDs whose own
 * outgoing `relations` array the traversal actually read while building its
 * result -- NOT every Artifact merely adjacent to (or pointing into) the
 * result. `max_depth: 0` is contractually roots-only with no edges
 * (10-query-and-trace.md), so passing an empty `consumedSourceIds` for that
 * case (as every caller below does) correctly never gates: no Artifact's
 * outgoing array was read at all.
 */
function edgeTrustLocalFailure(context: QueryContext, kind: QueryKind, consumedSourceIds: ReadonlySet<string>): QueryResult | undefined {
	const { edgeLossArtifactIds, semanticEdgeLossArtifactIds } = context.validation
	for (const id of consumedSourceIds) {
		if (edgeLossArtifactIds.has(id) || semanticEdgeLossArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- whose own declared relations this traversal consulted -- has a relations entry that could not be completely sanitized or was semantically invalid, so this graph would not be trustworthy.`)
	}
	return undefined
}

/**
 * Finding 4: every `relations`/`trace`/`impact`/`resolve-current` node
 * embedded in a result is itself an `ArtifactSummaryProjection`
 * (`buildArtifactSummary`), built from the same raw, unsanitized envelope
 * `lookup`/`list`/`search` project -- so any node whose Artifact is in
 * `projectionLossArtifactIds` makes this result's embedded summary just as
 * untrustworthy as an equivalent `lookup` would be, independent of edge
 * trust. Checked separately from (and in addition to) every edge-trust gate
 * above.
 */
function projectionLossNodeFailure(context: QueryContext, kind: QueryKind, nodeIds: Iterable<string>): QueryResult | undefined {
	for (const id of nodeIds) {
		if (context.validation.projectionLossArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this result's projected node set -- declares structured content that could not be completely loaded, so its projected summary would not be trustworthy.`)
	}
	return undefined
}

/**
 * Finding 6: `resolve-current`'s own algorithm (`domain/supersession.ts`)
 * follows `superseded-by` edges and branches on `status`, but never checks
 * source/target type compatibility itself, so this gates the two facts it
 * silently trusts: `statusInvalidArtifactIds` for every visited node (an
 * unrecognized-or-inapplicable status can otherwise be silently treated as a
 * legitimate `active`/`draft`/`retired` leaf) and
 * `supersessionCrossTypeArtifactIds` for every Artifact whose own
 * `superseded-by` entries were actually traversed (a cross-type replacement,
 * `EF-SUP-003`, can otherwise be silently followed as though it were a
 * genuine supersession). Also folds in the same edge-trust facts
 * `edgeTrustLocalFailure` checks, scoped to exactly the traversed sources
 * (`result.edges`' `source` side) -- resolve-current's traversal is always
 * outgoing-only. Shared between `resolve-current` and `impact`'s
 * `resolve_current` option, which runs the identical algorithm per root.
 */
function resolveCurrentTrustFailure(context: QueryContext, kind: QueryKind, result: { nodeIds: readonly string[], edges: readonly RelationEdgeData[] }): QueryResult | undefined {
	const { statusInvalidArtifactIds, supersessionCrossTypeArtifactIds, edgeLossArtifactIds, semanticEdgeLossArtifactIds } = context.validation

	for (const id of result.nodeIds) {
		if (statusInvalidArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this current-resolution result -- has an invalid lifecycle status, so this result would not be trustworthy.`)
	}

	const consumedSourceIds = new Set(result.edges.map(edge => edge.source))
	for (const source of consumedSourceIds) {
		if (supersessionCrossTypeArtifactIds.has(source))
			return failure(kind, 'EF-QRY-013', `Artifact '${source}' -- part of this current-resolution result -- declares a 'superseded-by' replacement of a different Artifact type, so this result would not be trustworthy.`)
		if (edgeLossArtifactIds.has(source) || semanticEdgeLossArtifactIds.has(source))
			return failure(kind, 'EF-QRY-013', `Artifact '${source}' -- whose own declared relations this current-resolution result consulted -- has a relations entry that could not be completely sanitized or was semantically invalid, so this result would not be trustworthy.`)
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

/** Resource fields `list`'s own filter options actually read (Finding 9). */
const LIST_RESOURCE_FILTER_FIELDS: ReadonlySet<ResourceFieldName> = new Set(['type', 'role', 'normative'])
/** Resource fields full-text search actually reads (`query-search.ts`'s `buildSurfaces`; Finding 9). */
const SEARCH_RESOURCE_SURFACE_FIELDS: ReadonlySet<ResourceFieldName> = new Set(['location', 'description'])

/**
 * Whether `record`'s Resource field loss (`resourceFieldLossById`) intersects
 * `consumedFields` -- the exact named Resource fields the caller's request
 * surface actually reads. Ninth-round Finding 9: an `EF-RES-001` on
 * `normative`/`type`/`role` alone must not gate a request that only reads
 * `location`/`description` (or vice versa), since the two field groups decode
 * independently of each other.
 */
function hasRelevantResourceFieldLoss(validation: SnapshotValidationResult, id: string, consumedFields: ReadonlySet<ResourceFieldName>): boolean {
	const lost = validation.resourceFieldLossById.get(id)
	if (!lost)
		return false
	for (const field of lost) {
		if (consumedFields.has(field))
			return true
	}
	return false
}

/**
 * Whether `record` could still possibly match `request` based ONLY on its
 * trustworthy (non-lossy) `type`/`status`/`schema` fields -- i.e. whether a
 * fully-trusted predicate already excludes it, independent of any lossy
 * field. Ninth-round Finding 9: a candidate a trustworthy filter already
 * excludes cannot have its list/search membership changed by loss on some
 * OTHER field, so it must not be added to a membership-risk set at all.
 *
 * Each of the three fields is distrusted independently, using the MOST
 * PRECISE signal available for it (duplicate-key trust-scope adjudication):
 *
 * - `type`: distrusted only when `record` is in
 *   `envelopeStructuralLossArtifactIds` (a duplicate `id`/`type` key). That
 *   already blocks `graphTrustworthy` project-wide before any caller reaches
 *   this function, so this branch is unreachable in practice -- kept for
 *   correctness independent of call order rather than relying on that
 *   invariant.
 * - `status`: distrusted whenever `record` is in `statusInvalidArtifactIds`
 *   -- an actual `EF-LIFE-001`/`002` invalid status, or a duplicate `status`
 *   key -- either way `envelope.status`, while a genuine
 *   first-occurrence-selected decode, is not reliably this file's ONLY
 *   declared status.
 * - `schema`: no field-precise tracking exists for a duplicated/dropped
 *   `schema` key the way `type`/`status` now have, so this filter alone
 *   still falls back to the broader `envelopeWideLossArtifactIds` signal (a
 *   duplicate key ANYWHERE in the frontmatter, or a dropped unrecognized
 *   top-level field) when a `schema` filter is actually requested.
 *
 * A duplicate key confined to `relations`/`resources`/`tags` (or a
 * non-graph-relevant field like `title`/`summary`) can never corrupt
 * `type`/`status`/`schema`, so it must not conservatively taint any of these
 * three checks -- unlike the coarser whole-Artifact
 * `envelopeWideLossArtifactIds` bucket, which is unconditioned on field and
 * so is reserved for the one filter (`schema`) that has no narrower bucket
 * of its own.
 */
function couldPossiblyMatchTrustedFilters(validation: SnapshotValidationResult, record: SnapshotArtifactRecord, request: Pick<ListQueryRequest, 'type' | 'status' | 'schema'>): boolean {
	if (validation.envelopeStructuralLossArtifactIds.has(record.id))
		return true
	const envelope = record.envelope
	if (request.type && request.type.length > 0 && !request.type.includes(envelope.type))
		return false
	if (request.status && request.status.length > 0) {
		if (validation.statusInvalidArtifactIds.has(record.id))
			return true
		if (!request.status.includes(envelope.status))
			return false
	}
	if (request.schema !== undefined) {
		if (validation.envelopeWideLossArtifactIds.has(record.id))
			return true
		if (envelope.schema !== request.schema)
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
 * relation SHAPE loss (`edgeLossArtifactIds`) only matters when the request
 * filters by `relationType`/`relationTarget` -- extension-only loss
 * (`relationExtensionLossArtifactIds`, `EF-REL-015`) is deliberately EXCLUDED
 * even then: it can never alter a `(type, target)` pair, so it cannot change
 * `relationType`/`relationTarget` membership at all (Finding 9). Resource
 * field loss only matters when it affects a field the request's
 * `resourceType`/`resourceRole`/`resourceNormative` filters actually read
 * (`resourceFieldLossById`, Finding 9 -- not the whole-Artifact
 * `resourceLossArtifactIds` bucket). Tag loss (`tagLossArtifactIds`) only
 * matters when the request filters by `tagsAny`/`tagsAll` -- a loss on a
 * surface the request never reads provably cannot have changed this result.
 * `envelopeWideLossArtifactIds` (a duplicate core key ANYWHERE in the
 * frontmatter, or a dropped unknown top-level field) is added as an
 * over-inclusive CANDIDATE set whenever the request applies any filter at
 * all -- it is narrowed back down immediately below by
 * `couldPossiblyMatchTrustedFilters`, which (duplicate-key trust-scope
 * adjudication) distrusts `type`/`status` only via their own precise buckets
 * (`envelopeStructuralLossArtifactIds`/`statusInvalidArtifactIds`), not this
 * coarser one; a duplicate confined to `relations`/`resources`/`tags`/
 * `title`/`summary` cannot have changed a `type`/`status` filter's
 * membership determination at all. A request with NO filters matches every
 * Artifact unconditionally, so no loss anywhere could have changed
 * membership/total; an own-loss Artifact that ends up on the returned page
 * is still caught by the existing per-page check below.
 *
 * Finally (Finding 9), every candidate is filtered through
 * `couldPossiblyMatchTrustedFilters`: a candidate already excluded by a
 * fully-trusted `type`/`status`/`schema` predicate cannot have its
 * membership changed by loss on some OTHER field, so it is dropped from the
 * risk set even if one of the surface checks above added it.
 */
function listMembershipRiskArtifactIds(validation: SnapshotValidationResult, request: ListQueryRequest): ReadonlySet<string> {
	const hasTypeFilter = (request.type?.length ?? 0) > 0
	const hasStatusFilter = (request.status?.length ?? 0) > 0
	const hasSchemaFilter = request.schema !== undefined
	const hasTagsFilter = (request.tagsAny?.length ?? 0) > 0 || (request.tagsAll?.length ?? 0) > 0
	const hasRelationFilter = request.relationType !== undefined || request.relationTarget !== undefined
	const hasResourceFilter = request.resourceType !== undefined || request.resourceRole !== undefined || request.resourceNormative !== undefined
	const hasAnyFilter = hasTypeFilter || hasStatusFilter || hasSchemaFilter || hasTagsFilter || hasRelationFilter || hasResourceFilter

	const candidates = new Set<string>()
	if (!hasAnyFilter)
		return candidates
	for (const id of validation.envelopeWideLossArtifactIds) candidates.add(id)
	if (hasTagsFilter) {
		for (const id of validation.tagLossArtifactIds) candidates.add(id)
	}
	if (hasRelationFilter) {
		for (const id of validation.edgeLossArtifactIds) candidates.add(id)
	}
	if (hasResourceFilter) {
		for (const id of validation.resourceFieldLossById.keys()) {
			if (hasRelevantResourceFieldLoss(validation, id, LIST_RESOURCE_FILTER_FIELDS))
				candidates.add(id)
		}
	}

	const ids = new Set<string>()
	for (const id of candidates) {
		const record = validation.byId.get(id)
		if (record && !couldPossiblyMatchTrustedFilters(validation, record, request))
			continue
		ids.add(id)
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

	// Finding B/9: full-text search always reads `title`/`summary`/`tags`/
	// `resources.location`/`resources.description` for EVERY Artifact
	// (`query-search.ts`'s `buildSurfaces`, unconditionally, regardless of the
	// terms requested) to decide matching/total, so a lost tag, a lost/
	// coerced envelope-wide field (duplicate core key / dropped unknown
	// field, which can corrupt `title`/`summary` too), or a Resource field
	// loss that actually touches `location`/`description` on ANY Artifact
	// could have hidden or altered a match -- unlike `list`, there is no
	// unsearched envelope-wide surface to scope this to. A Resource field
	// loss confined to `type`/`role`/`normative`/`media_type` (none of which
	// search reads) is excluded (`resourceFieldLossById`, Finding 9), and
	// relation loss is excluded entirely: search never reads `relations` at
	// all, so it cannot affect matching here (an affected Artifact that still
	// ends up in the returned page is caught by the per-page check below
	// instead).
	const searchMembershipRisk = new Set<string>([
		...context.validation.tagLossArtifactIds,
		...context.validation.envelopeWideLossArtifactIds,
		...[...context.validation.resourceFieldLossById.keys()].filter(id => hasRelevantResourceFieldLoss(context.validation, id, SEARCH_RESOURCE_SURFACE_FIELDS)),
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
	// 'outgoing' is scoped below (Finding 8) to exactly the one outgoing array
	// this traversal reads: the requested Artifact's own.
	if (direction === 'incoming' || direction === 'both') {
		const untrustworthyRelationData = edgeTrustGlobalFailure(context, 'relations')
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

	if (!context.validation.byId.has(request.id))
		return failure('relations', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const typeSet = new Set<string>(requestedTypes.length > 0 ? requestedTypes : RELATION_TYPES)
	const result = directRelations(request.id, direction as Direction, typeSet, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('relations', 'EF-QRY-007', 'The requested relation graph is invalid.')

	// Finding 8: `directRelations` reads ONLY `request.id`'s own outgoing
	// array for an 'outgoing' (or 'both') direction -- never a neighbor's --
	// so that is the only consumed source, independent of `result.nodeIds`
	// (which also includes every neighbor ID, whose own arrays are never
	// read here).
	if (direction === 'outgoing') {
		const untrustworthyRelationData = edgeTrustLocalFailure(context, 'relations', new Set([request.id]))
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

	// Finding 4: every embedded node is itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'relations', result.nodeIds)
	if (projectionFailure)
		return projectionFailure

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
		const untrustworthyTraceRelationData = edgeTrustGlobalFailure(context, 'trace')
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
		// Finding 8: `traceGraph` only expands (reads the outgoing array of) a
		// node whose depth is strictly less than `max_depth`; a node at exactly
		// `max_depth` is a discovered leaf whose own array is never read, and
		// `max_depth: 0` expands nothing at all (roots-only, no edges), so this
		// naturally yields an empty consumed set for that contractual case.
		const consumedSourceIds = new Set([...result.depths]
			.filter(([, depth]) => depth < request.maxDepth)
			.map(([id]) => id))
		const untrustworthyTraceRelationData = edgeTrustLocalFailure(context, 'trace', consumedSourceIds)
		if (untrustworthyTraceRelationData)
			return untrustworthyTraceRelationData
	}

	// Finding 4: every embedded node is itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'trace', result.depths.keys())
	if (projectionFailure)
		return projectionFailure

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
	const untrustworthyImpactRelationData = edgeTrustGlobalFailure(context, 'impact')
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

		// Finding 6: `impact`'s `resolve_current` option runs the identical
		// per-root current-resolution algorithm `resolve-current` does, and
		// consumes the same supersession/status facts.
		const untrustworthyResolution = resolveCurrentTrustFailure(context, 'impact', merged)
		if (untrustworthyResolution)
			return untrustworthyResolution

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

	// Finding 6: `impactGraph` prunes a depth>0 candidate from further
	// expansion/inclusion whenever `record.status !== 'active'` (unless
	// `includeNonCurrent`), silently treating an Artifact with an invalid
	// status (`EF-LIFE-001`/`002`) the same as one legitimately
	// draft/superseded/retired. Gate on exactly the candidates whose status
	// this traversal actually consulted: depth>0 nodes, only when
	// `includeNonCurrent` is `false` (otherwise `impactGraph` never reads
	// `status` at all).
	if (!includeNonCurrent) {
		for (const [id, depth] of traversal.depths) {
			if (depth > 0 && context.validation.statusInvalidArtifactIds.has(id))
				return failure('impact', 'EF-QRY-013', `Artifact '${id}' -- a candidate this impact traversal evaluated for current status -- has an invalid lifecycle status, so this result would not be trustworthy.`)
		}
	}

	// Finding 4: every embedded node -- both the impact traversal's own nodes
	// and (when requested) the resolve_current sub-resolution's nodes -- is
	// itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'impact', [...resolution.nodes.map(n => n.id), ...traversal.includedIds])
	if (projectionFailure)
		return projectionFailure

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

	// Finding C/6/8: current resolution follows `superseded-by` edges strictly
	// outgoing from the input ID (05-supersession "Current-resolution
	// algorithm"), so edge/status/supersession trust is scoped to this
	// result's own traversal, the same as an outgoing-only `relations`/`trace`
	// traversal.
	const untrustworthyRelationData = resolveCurrentTrustFailure(context, 'resolve-current', outcome.result)
	if (untrustworthyRelationData)
		return untrustworthyRelationData

	// Finding 4: every embedded node is itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'resolve-current', outcome.result.nodeIds)
	if (projectionFailure)
		return projectionFailure

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
