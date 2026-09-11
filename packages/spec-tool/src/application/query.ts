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
import type { CoreFieldName, ResourceFieldName, SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
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
	/**
	 * The ref NAME `integrationRefOid` was resolved from (e.g.
	 * `refs/heads/main`), threaded into `computeHistory`'s
	 * `expectedIntegrationRef` (11-filesystem-and-config.md, Finding 11) so
	 * the walked history's boundary commit is required to declare exactly
	 * this ref, not merely some `.engineering/ef.yaml`-declared ref chosen
	 * after the fact. Required (not optional) here: this is the one call site
	 * that has the ref name available, so there is no reason to leave the
	 * check dormant.
	 */
	integrationRef: string
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
 *
 * `typeSet` is the exact set of relation types THIS traversal actually reads
 * (seventh-round Finding 9, extending sixth-round Finding 9's per-type
 * narrowing from `edgeTrustLocalFailure` to this global gate too): a typed
 * loss elsewhere in the graph only gates when its recorded relation type(s)
 * actually intersect `typeSet` -- a `governed-by`-only semantic loss on some
 * unrelated Artifact must not block an incoming traversal restricted to
 * `derived-from`, for example. A truly UNTYPED loss (`edgeLossUntypedArtifactIds`,
 * or a semantic-loss diagnostic this module defensively could not attribute a
 * type to) still gates unconditionally, regardless of `typeSet`: an
 * `incoming`/`both` read is derived from every Artifact's outgoing array, and
 * an untyped loss cannot be ruled out as affecting any of them.
 */
function edgeTrustGlobalFailure(context: QueryContext, kind: QueryKind, typeSet: ReadonlySet<string>): QueryResult | undefined {
	const { edgeLossUntypedArtifactIds, edgeLossRelationTypesBySourceId, semanticEdgeLossArtifactIds, semanticEdgeLossRelationTypesBySourceId } = context.validation

	if (edgeLossUntypedArtifactIds.size > 0)
		return failure(kind, 'EF-QRY-013', 'An Artifact\'s declared relations could not be completely sanitized elsewhere in the graph, so the requested relation graph would not be trustworthy.')

	for (const [id, types] of edgeLossRelationTypesBySourceId) {
		if ([...types].some(type => typeSet.has(type)))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' has a relations entry of a type this traversal reads that could not be completely sanitized elsewhere in the graph, so the requested relation graph would not be trustworthy.`)
	}

	for (const id of semanticEdgeLossArtifactIds) {
		const typedSemanticLoss = semanticEdgeLossRelationTypesBySourceId.get(id)
		// Every `semanticEdgeLossArtifactIds` cause is typed in practice
		// (`snapshot-validation.ts`'s field doc); this untyped fallback stays
		// conservative defensively rather than silently narrowing a fact this
		// module cannot actually attribute a type to.
		if (!typedSemanticLoss || [...typedSemanticLoss].some(type => typeSet.has(type)))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' has a semantically invalid relation of a type this traversal reads elsewhere in the graph, so the requested relation graph would not be trustworthy.`)
	}

	return undefined
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
 *
 * `typeSet` is the exact set of relation types THIS traversal actually reads
 * (Finding 9): a source's loss only gates when it is untyped/conservative
 * (`edgeLossUntypedArtifactIds`, or a semantic-loss diagnostic this module
 * defensively could not attribute a type to -- neither is expected to arise
 * without a typed counterpart in practice) or when its recorded lossy
 * relation type(s) actually intersect `typeSet`. A known-invalid entry of a
 * type this traversal never reads (a bad `references` entry on a source
 * whose traversal is restricted to `derived-from`, for example) can never
 * have been read or returned by this specific traversal, so it must not
 * block it.
 */
function edgeTrustLocalFailure(context: QueryContext, kind: QueryKind, consumedSourceIds: ReadonlySet<string>, typeSet: ReadonlySet<string>): QueryResult | undefined {
	const { edgeLossUntypedArtifactIds, edgeLossRelationTypesBySourceId, semanticEdgeLossArtifactIds, semanticEdgeLossRelationTypesBySourceId } = context.validation
	for (const id of consumedSourceIds) {
		if (edgeLossUntypedArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- whose own declared relations this traversal consulted -- has a relations entry that could not be completely sanitized, so this graph would not be trustworthy.`)

		const typedEdgeLoss = edgeLossRelationTypesBySourceId.get(id)
		if (typedEdgeLoss && [...typedEdgeLoss].some(type => typeSet.has(type)))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- whose own declared relations this traversal consulted -- has a relations entry of a type this traversal reads that could not be completely sanitized, so this graph would not be trustworthy.`)

		if (semanticEdgeLossArtifactIds.has(id)) {
			const typedSemanticLoss = semanticEdgeLossRelationTypesBySourceId.get(id)
			// Every `semanticEdgeLossArtifactIds` cause is typed in practice
			// (`snapshot-validation.ts`'s field doc); this untyped fallback stays
			// conservative defensively rather than silently narrowing a fact this
			// module cannot actually attribute a type to.
			if (!typedSemanticLoss || [...typedSemanticLoss].some(type => typeSet.has(type)))
				return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- whose own declared relations this traversal consulted -- has a semantically invalid relation of a type this traversal reads, so this graph would not be trustworthy.`)
		}
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
 * Seventh-round Finding 6: 10-query-and-trace.md fixes a projected
 * Artifact's `path` as ITS canonical, project-relative path, but
 * `buildArtifactSummary`/`buildArtifactFull` project the actual discovered
 * path verbatim (Finding A: raw, unsanitized projection). An Artifact in
 * `pathTrustLossArtifactIds` (an `EF-ID-005` filename mismatch, an `EF-ID-014`
 * wrong-canonical-directory finding, or an artifact-path `EF-FS-006`;
 * `snapshot-validation.ts`'s field doc) therefore has an explicitly
 * non-canonical projected `path` -- tracked SEPARATELY from
 * `projectionLossArtifactIds` (the untrustworthy fact here is specifically
 * the `path` field, not the envelope content those causes corrupt), but
 * gated the exact same per-node way: only a result that would actually
 * project this specific Artifact (a `lookup`/`list`/`search` result, or a
 * graph traversal's node set) is untrustworthy, never an unrelated result.
 */
function pathTrustNodeFailure(context: QueryContext, kind: QueryKind, nodeIds: Iterable<string>): QueryResult | undefined {
	for (const id of nodeIds) {
		if (context.validation.pathTrustLossArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this result's projected node set -- has a non-canonical file path, so its projected 'path' field would not be trustworthy.`)
	}
	return undefined
}

/** The only relation type `resolve-current`'s traversal ever reads or returns (05-supersession.md "Current-resolution algorithm"), used to scope `edgeTrustLocalFailure`'s per-type intersection (Finding 9) to exactly that one type. */
const SUPERSEDED_BY_TYPE_SET: ReadonlySet<string> = new Set(['superseded-by'])

/**
 * `resolve-current`'s own algorithm (`domain/supersession.ts`) follows
 * `superseded-by` edges and branches on `status`, but never checks
 * source/target type compatibility, replacement-set completeness, or cycle
 * validity itself, so this gates every fact it silently trusts:
 *
 * - `statusInvalidArtifactIds` for every visited node (an
 *   unrecognized-or-inapplicable status can otherwise be silently treated as
 *   a legitimate `active`/`draft`/`retired` leaf).
 * - `supersessionFactInvalidArtifactIds` for every visited node (Finding 6:
 *   `EF-SUP-001`/`002`/`003`/`005` -- an empty replacement set, an illegal
 *   `superseded-by` declaration on a non-superseded node, a cross-type
 *   replacement, or a supersession cycle can each be reached WITHOUT
 *   following any edge that reveals it: an `EF-SUP-001` source resolves to an
 *   empty set exactly as though it were a legitimately retired leaf
 *   (05-supersession "Retired replacement leaves"), and an `EF-SUP-002`
 *   source is never even read past its `active`/`draft`/`retired` status
 *   branch -- so both checks apply to every node `result.nodeIds` actually
 *   visited, INCLUDING the exact input ID with zero edges, not only the
 *   source side of a followed edge).
 * - The same edge-trust facts `edgeTrustLocalFailure` checks (Finding 9),
 *   scoped to exactly the traversed sources (`result.edges`' `source` side)
 *   and to the one relation type resolve-current's traversal ever reads
 *   (`SUPERSEDED_BY_TYPE_SET`) -- resolve-current's traversal is always
 *   outgoing-only.
 *
 * Shared between `resolve-current` and `impact`'s `resolve_current` option,
 * which runs the identical algorithm per root.
 */
function resolveCurrentTrustFailure(context: QueryContext, kind: QueryKind, result: { nodeIds: readonly string[], edges: readonly RelationEdgeData[] }): QueryResult | undefined {
	const { statusInvalidArtifactIds, supersessionFactInvalidArtifactIds } = context.validation

	for (const id of result.nodeIds) {
		if (statusInvalidArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this current-resolution result -- has an invalid lifecycle status, so this result would not be trustworthy.`)
		if (supersessionFactInvalidArtifactIds.has(id))
			return failure(kind, 'EF-QRY-013', `Artifact '${id}' -- part of this current-resolution result -- declares an invalid supersession fact (no direct replacement, an illegal 'superseded-by' declaration, a cross-type replacement, or a supersession cycle), so this result would not be trustworthy.`)
	}

	const consumedSourceIds = new Set(result.edges.map(edge => edge.source))
	return edgeTrustLocalFailure(context, kind, consumedSourceIds, SUPERSEDED_BY_TYPE_SET)
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

	// Finding 6 (seventh-round): this record's own discovered `path` is
	// explicitly non-canonical (`pathTrustNodeFailure`'s doc); the spec fixes
	// a projected `path` as canonical, so this lookup cannot report
	// `complete: true` while projecting it.
	if (context.validation.pathTrustLossArtifactIds.has(record.id))
		return failure('lookup', 'EF-QRY-013', `Artifact '${record.id}' has a non-canonical file path, so its projected 'path' field would not be trustworthy.`)

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
 * Exactly which of `list`'s three named Resource filter fields (`type`,
 * `role`, `normative`) THIS request actually supplies (sixth-round Finding
 * 8): a fixed union of all three -- what a prior round used unconditionally
 * -- would let a malformed `normative` field gate a request that only
 * supplies `resource_type` (or vice versa), even though such a request never
 * reads `normative` at all. Each of the three fields decodes independently
 * (`domain/resources.ts#validateResourceDescriptors`), so only the fields
 * THIS request's own options actually name may participate in its
 * `resourceFieldLossById` intersection.
 */
function requestedResourceFilterFields(request: Pick<ListQueryRequest, 'resourceType' | 'resourceRole' | 'resourceNormative'>): ReadonlySet<ResourceFieldName> {
	const fields = new Set<ResourceFieldName>()
	if (request.resourceType !== undefined)
		fields.add('type')
	if (request.resourceRole !== undefined)
		fields.add('role')
	if (request.resourceNormative !== undefined)
		fields.add('normative')
	return fields
}

/** Resource fields full-text search actually reads (`query-search.ts`'s `buildSurfaces`; Finding 9): unlike `list`'s per-request field set above, EVERY search request reads both fields unconditionally, regardless of the terms requested, so this fixed set is not a Finding 8 concern. */
const SEARCH_RESOURCE_SURFACE_FIELDS: ReadonlySet<ResourceFieldName> = new Set(['location', 'description'])

/**
 * Core envelope fields full-text search actually reads (`query-search.ts`'s
 * `buildSurfaces`: `title`/`summary`/`tags`, unconditionally for every
 * Artifact, plus `resources` for its `location`/`description` sub-fields --
 * eighth-round Finding 8), for intersecting against `envelopeFieldLossById`.
 * `id`/`type`/`status`/`schema`/`relations` are never read by search, so a
 * duplicate key confined to one of those can never gate search membership
 * (unlike the prior rounds' field-unscoped `envelopeWideLossArtifactIds`,
 * which gated search for ANY core field's duplicate).
 */
const SEARCH_CONSUMED_CORE_FIELDS: ReadonlySet<CoreFieldName> = new Set(['title', 'summary', 'tags', 'resources'])

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
 * - `schema`: distrusted only when `record` has a `schema` entry in
 *   `envelopeFieldLossById` (eighth-round Finding 8) -- a duplicate
 *   `schema` key. Prior rounds fell back to the coarser
 *   `envelopeWideLossArtifactIds` bucket here (fires for ANY core field's
 *   duplicate, not just `schema`'s own), which conservatively distrusted
 *   `schema` even for a record whose only loss was on some unrelated field
 *   like `title`.
 *
 * A duplicate key confined to `relations`/`resources`/`tags` (or a
 * non-graph-relevant field like `title`/`summary`) can never corrupt
 * `type`/`status`/`schema` (`envelopeFieldLossById`'s own per-field
 * attribution, eighth-round Finding 8), so it must not conservatively taint
 * any of these three checks.
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
		if (validation.envelopeFieldLossById.get(record.id)
			?.has('schema')) {
			return true
		}
		if (envelope.schema !== request.schema)
			return false
	}
	return true
}

/**
 * Exactly which core envelope fields (`snapshot-validation.ts`'s
 * `CoreFieldName`) this `list` request's filters/pagination semantics
 * actually read (eighth-round Finding 8), for intersecting against
 * `envelopeFieldLossById`: `type`/`status`/`schema` when their respective
 * filter is present, `tags` for `tagsAny`/`tagsAll`, `relations` for
 * `relationType`/`relationTarget`, `resources` for `resourceType`/
 * `resourceRole`/`resourceNormative`. `id`/`title`/`summary` are never
 * consumed by any `list` filter, so a duplicate key confined to one of
 * those can never appear in the returned set here.
 */
function listConsumedCoreFields(options: { hasTypeFilter: boolean, hasStatusFilter: boolean, hasSchemaFilter: boolean, hasTagsFilter: boolean, hasRelationFilter: boolean, hasResourceFilter: boolean }): ReadonlySet<CoreFieldName> {
	const fields = new Set<CoreFieldName>()
	if (options.hasTypeFilter)
		fields.add('type')
	if (options.hasStatusFilter)
		fields.add('status')
	if (options.hasSchemaFilter)
		fields.add('schema')
	if (options.hasTagsFilter)
		fields.add('tags')
	if (options.hasRelationFilter)
		fields.add('relations')
	if (options.hasResourceFilter)
		fields.add('resources')
	return fields
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
 *
 * Eighth-round Finding 8: `envelopeFieldLossById` (a duplicate core key,
 * attributed to the EXACT core field it names) is intersected against
 * `listConsumedCoreFields` -- the fields THIS request's own filters actually
 * read -- rather than the prior rounds' `envelopeWideLossArtifactIds`
 * (field-unscoped, fires for ANY core field's duplicate) being added as an
 * over-inclusive candidate set whenever the request applies any filter AT
 * ALL. A duplicate `title` key, for instance, can no longer gate an
 * unrelated `--type` list request: `title` is never one of
 * `listConsumedCoreFields`' members, so it never intersects regardless of
 * which filters are present. A request with NO filters matches every
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
	const consumedCoreFields = listConsumedCoreFields({ hasTypeFilter, hasStatusFilter, hasSchemaFilter, hasTagsFilter, hasRelationFilter, hasResourceFilter })
	for (const [id, fields] of validation.envelopeFieldLossById) {
		if ([...fields].some(field => consumedCoreFields.has(field)))
			candidates.add(id)
	}
	if (hasTagsFilter) {
		for (const id of validation.tagLossArtifactIds) candidates.add(id)
	}
	if (hasRelationFilter) {
		for (const id of validation.edgeLossArtifactIds) candidates.add(id)
	}
	if (hasResourceFilter) {
		// Finding 8: built from exactly the resource filter options THIS
		// request supplies, not a fixed union of every field `list` could ever
		// filter on.
		const consumedResourceFields = requestedResourceFilterFields(request)
		for (const id of validation.resourceFieldLossById.keys()) {
			if (hasRelevantResourceFieldLoss(validation, id, consumedResourceFields))
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

	// Finding 6 (seventh-round): same per-returned-Artifact scoping as above,
	// for an Artifact whose own `path` field is explicitly non-canonical
	// (`pathTrustNodeFailure`'s doc) -- path trust does not affect
	// filter/pagination membership, only the projected result.
	if (paged.some(record => context.validation.pathTrustLossArtifactIds.has(record.id)))
		return failure('list', 'EF-QRY-013', 'One or more returned Artifacts have a non-canonical file path, so this result\'s projected \'path\' field(s) would not be trustworthy.')

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
	// terms requested) to decide matching/total, so a lost tag or a Resource
	// field loss that actually touches `location`/`description` on ANY
	// Artifact could have hidden or altered a match -- unlike `list`, there is
	// no unsearched envelope-wide surface to scope THOSE two signals to. A
	// Resource field loss confined to `type`/`role`/`normative`/`media_type`
	// (none of which search reads) is excluded (`resourceFieldLossById`,
	// Finding 9), and relation loss is excluded entirely: search never reads
	// `relations` at all, so it cannot affect matching here (an affected
	// Artifact that still ends up in the returned page is caught by the
	// per-page check below instead).
	//
	// Eighth-round Finding 8: a duplicate core key (`envelopeFieldLossById`)
	// only gates search membership when it names one of
	// `SEARCH_CONSUMED_CORE_FIELDS` -- `title`/`summary`/`tags`/`resources`,
	// the exact surfaces `buildSurfaces` reads -- rather than the prior
	// rounds' field-unscoped `envelopeWideLossArtifactIds`, which gated every
	// search for ANY core field's duplicate, including `id`/`type`/`status`/
	// `schema`/`relations`, none of which search ever reads.
	//
	// Seventh-round Finding 7: search reads every Artifact's best-effort
	// decoded body text (`bodyTextFor`/`executeSearch`'s own body surface,
	// unconditionally, for every Artifact) in addition to its
	// title/summary/tags/resource surfaces above -- an invalid UTF-8 byte
	// anywhere in an Artifact's raw file bytes (`byteDecodingLossArtifactIds`,
	// frontmatter OR body) replaces at least one character with U+FFFD in
	// whichever surface it falls in. When that replacement falls inside the
	// exact token a request searches for, the corrupted Artifact never
	// matches and so never reaches `data.results` at all -- the per-result
	// `projectionLossArtifactIds` check below can only ever see an Artifact
	// that WAS returned, so it can never catch this loss. Unlike `list`
	// (which never reads the body at all), there is no unsearched surface to
	// scope this to: every search reads every Artifact's body by definition,
	// so this is a whole-request membership risk exactly like tag/
	// core-field loss above.
	const searchMembershipRisk = new Set<string>([
		...context.validation.tagLossArtifactIds,
		...context.validation.byteDecodingLossArtifactIds,
		...[...context.validation.envelopeFieldLossById.entries()]
			.filter(([, fields]) => [...fields].some(field => SEARCH_CONSUMED_CORE_FIELDS.has(field)))
			.map(([id]) => id),
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

	// Finding 6 (seventh-round): same per-returned-Artifact scoping, for an
	// Artifact whose own `path` field is explicitly non-canonical
	// (`pathTrustNodeFailure`'s doc).
	if (data.results.some(entry => context.validation.pathTrustLossArtifactIds.has(entry.artifact.id)))
		return failure('search', 'EF-QRY-013', 'One or more returned Artifacts have a non-canonical file path, so this result\'s projected \'path\' field(s) would not be trustworthy.')

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

	const typeSet = new Set<string>(requestedTypes.length > 0 ? requestedTypes : RELATION_TYPES)

	// Finding C: 'incoming'/'both' reads incoming edges, derived project-wide
	// from every Artifact's outgoing array, so it stays globally gated. Purely
	// 'outgoing' is scoped below (Finding 8) to exactly the one outgoing array
	// this traversal reads: the requested Artifact's own. Seventh-round
	// Finding 9: the global gate is itself narrowed to `typeSet`, the exact
	// relation types this request reads.
	if (direction === 'incoming' || direction === 'both') {
		const untrustworthyRelationData = edgeTrustGlobalFailure(context, 'relations', typeSet)
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

	if (!context.validation.byId.has(request.id))
		return failure('relations', 'EF-QRY-014', `Artifact '${request.id}' does not exist.`)

	const result = directRelations(request.id, direction as Direction, typeSet, context.validation.byId, context.validation.incomingRelations)
	if (!result)
		return failure('relations', 'EF-QRY-007', 'The requested relation graph is invalid.')

	// Finding 8: `directRelations` reads ONLY `request.id`'s own outgoing
	// array for an 'outgoing' (or 'both') direction -- never a neighbor's --
	// so that is the only consumed source, independent of `result.nodeIds`
	// (which also includes every neighbor ID, whose own arrays are never
	// read here).
	if (direction === 'outgoing') {
		const untrustworthyRelationData = edgeTrustLocalFailure(context, 'relations', new Set([request.id]), typeSet)
		if (untrustworthyRelationData)
			return untrustworthyRelationData
	}

	// Finding 4: every embedded node is itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'relations', result.nodeIds)
	if (projectionFailure)
		return projectionFailure

	// Finding 6 (seventh-round): same per-node scoping, for a node whose own
	// `path` field is explicitly non-canonical.
	const pathTrustFailure = pathTrustNodeFailure(context, 'relations', result.nodeIds)
	if (pathTrustFailure)
		return pathTrustFailure

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

	const typeSet = new Set(request.types)

	// Finding C: same 'incoming'/'both' vs 'outgoing' split as `handleRelations`.
	// Seventh-round Finding 9: the global gate is itself narrowed to
	// `typeSet`, the exact relation types this trace reads.
	if (request.direction === 'incoming' || request.direction === 'both') {
		const untrustworthyTraceRelationData = edgeTrustGlobalFailure(context, 'trace', typeSet)
		if (untrustworthyTraceRelationData)
			return untrustworthyTraceRelationData
	}

	const missing = request.roots.filter(id => !context.validation.byId.has(id))
	if (missing.length > 0) {
		return failure('trace', 'EF-QRY-014', `Artifact ID(s) not found: ${dedupeSortIds(missing)
			.join(', ')}.`)
	}
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
		const untrustworthyTraceRelationData = edgeTrustLocalFailure(context, 'trace', consumedSourceIds, typeSet)
		if (untrustworthyTraceRelationData)
			return untrustworthyTraceRelationData
	}

	// Finding 4: every embedded node is itself a summary projection.
	const projectionFailure = projectionLossNodeFailure(context, 'trace', result.depths.keys())
	if (projectionFailure)
		return projectionFailure

	// Finding 6 (seventh-round): same per-node scoping, for a node whose own
	// `path` field is explicitly non-canonical.
	const pathTrustFailure = pathTrustNodeFailure(context, 'trace', result.depths.keys())
	if (pathTrustFailure)
		return pathTrustFailure

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

	const includeReferences = request.includeReferences ?? false
	const typeSet = new Set<string>(CORE_IMPACT_TYPES)
	if (includeReferences)
		typeSet.add('references')

	// Finding C: impact traversal direction is always incoming
	// (10-query-and-trace.md "Traversal direction is incoming"), so it stays
	// globally gated regardless of request options. Seventh-round Finding 9:
	// the global gate is itself narrowed to `typeSet`, the exact relation
	// types this impact traversal reads.
	const untrustworthyImpactRelationData = edgeTrustGlobalFailure(context, 'impact', typeSet)
	if (untrustworthyImpactRelationData)
		return untrustworthyImpactRelationData

	const missing = request.roots.filter(id => !context.validation.byId.has(id))
	if (missing.length > 0) {
		return failure('impact', 'EF-QRY-014', `Artifact ID(s) not found: ${dedupeSortIds(missing)
			.join(', ')}.`)
	}

	const includeNonCurrent = request.includeNonCurrent ?? false
	const resolveCurrentFlag = request.resolveCurrent ?? false

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
	const impactNodeIds = [...resolution.nodes.map(n => n.id), ...traversal.includedIds]
	const projectionFailure = projectionLossNodeFailure(context, 'impact', impactNodeIds)
	if (projectionFailure)
		return projectionFailure

	// Seventh-round Finding 6: same per-node scoping, for a node whose own
	// `path` field is explicitly non-canonical.
	const pathTrustFailure = pathTrustNodeFailure(context, 'impact', impactNodeIds)
	if (pathTrustFailure)
		return pathTrustFailure

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

	// Seventh-round Finding 6: same per-node scoping, for a node whose own
	// `path` field is explicitly non-canonical.
	const pathTrustFailure = pathTrustNodeFailure(context, 'resolve-current', outcome.result.nodeIds)
	if (pathTrustFailure)
		return pathTrustFailure

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

	const outcome = await computeHistory(context.history.git, context.history.integrationRefOid, request.id, record.type, context.validation.byId, context.history.integrationRef)
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
