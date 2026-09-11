/**
 * `ef/query-result@1` request and result shapes (10-query-and-trace.md).
 *
 * Request types are this module's own invention (10-query-and-trace.md
 * specifies *output* JSON shapes normatively; it leaves request transport to
 * 13-cli-contract.md, which the CLI layer -- not this one -- parses into
 * these shapes). Filter/option fields are kept as plain strings/booleans
 * rather than narrowed enum unions so this module's own validation
 * (`EF-QRY-002`, "Filter validation checks enum values ... before graph
 * traversal") has something meaningful to reject.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactFullProjection, ArtifactSummaryProjection } from './query-projection'

export type QueryKind = 'lookup' | 'list' | 'search' | 'relations' | 'trace' | 'impact' | 'history' | 'resolve-current'

export type Direction = 'outgoing' | 'incoming' | 'both'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface LookupQueryRequest {
	kind: 'lookup'
	id: string
	/** Defaults to `'full'` (10-query-and-trace.md "Projection vocabulary": "Exact lookup MAY request either projection and defaults to full."). */
	projection?: string
}

export interface ListQueryRequest {
	kind: 'list'
	/** OR within the array. */
	type?: readonly string[]
	/** OR within the array. */
	status?: readonly string[]
	schema?: string
	/** OR within the array (`tags_any`). */
	tagsAny?: readonly string[]
	/** AND within the array (`tags_all`). */
	tagsAll?: readonly string[]
	relationType?: string
	relationTarget?: string
	resourceType?: string
	resourceRole?: string
	resourceNormative?: boolean
	offset?: number
	limit?: number | null
}

export interface SearchQueryRequest {
	kind: 'search'
	terms: readonly string[]
	caseSensitive?: boolean
	offset?: number
	limit?: number | null
}

export interface RelationsQueryRequest {
	kind: 'relations'
	id: string
	/** Defaults to `'both'`. */
	direction?: string
	/** Empty or omitted means every relation type. */
	types?: readonly string[]
}

export interface TraceQueryRequest {
	kind: 'trace'
	roots: readonly string[]
	types: readonly string[]
	direction: string
	maxDepth: number
}

export interface ImpactQueryRequest {
	kind: 'impact'
	roots: readonly string[]
	maxDepth: number
	includeReferences?: boolean
	includeNonCurrent?: boolean
	resolveCurrent?: boolean
}

export interface HistoryQueryRequest {
	kind: 'history'
	id: string
}

export interface ResolveCurrentQueryRequest {
	kind: 'resolve-current'
	id: string
}

export type QueryRequest
	= | LookupQueryRequest
		| ListQueryRequest
		| SearchQueryRequest
		| RelationsQueryRequest
		| TraceQueryRequest
		| ImpactQueryRequest
		| HistoryQueryRequest
		| ResolveCurrentQueryRequest

// ---------------------------------------------------------------------------
// Shared result fragments
// ---------------------------------------------------------------------------

/** Canonical stored relation edge shape shared by relations/trace/impact/resolve-current (10-query-and-trace.md). */
export interface RelationEdgeData {
	source: string
	type: string
	target: string
}

/** An Artifact summary annotated with its shortest BFS depth (trace/impact "Graph nodes use Artifact summary plus shortest depth"). */
export interface DepthNodeData {
	artifact: ArtifactSummaryProjection
	depth: number
}

// ---------------------------------------------------------------------------
// Per-kind data payloads
// ---------------------------------------------------------------------------

export interface LookupData {
	found: boolean
	artifact: ArtifactSummaryProjection | ArtifactFullProjection | null
}

export interface ListData {
	total: number
	offset: number
	limit: number | null
	artifacts: ArtifactSummaryProjection[]
}

export interface SearchMatchData {
	field: 'title' | 'summary' | 'tags' | 'body' | 'resources.location' | 'resources.description'
	section: string | null
	line: number | null
	column: number | null
	text: string
}

export interface SearchResultEntryData {
	artifact: ArtifactSummaryProjection
	matches: SearchMatchData[]
}

export interface SearchData {
	terms: string[]
	case_sensitive: boolean
	total: number
	offset: number
	limit: number | null
	results: SearchResultEntryData[]
}

export interface RelationsData {
	artifact_id: string
	direction: Direction
	types: string[]
	nodes: ArtifactSummaryProjection[]
	edges: RelationEdgeData[]
}

export interface TraceData {
	roots: string[]
	types: string[]
	direction: Direction
	max_depth: number
	nodes: DepthNodeData[]
	edges: RelationEdgeData[]
}

export interface ImpactData {
	roots: string[]
	resolved_roots: string[]
	max_depth: number
	include_references: boolean
	include_non_current: boolean
	resolve_current: boolean
	resolution: { nodes: ArtifactSummaryProjection[], edges: RelationEdgeData[] }
	impact: { nodes: DepthNodeData[], edges: RelationEdgeData[] }
}

export interface HistoryEffectData {
	chg: ArtifactSummaryProjection
	effect: 'introduces' | 'modifies' | 'retires'
	status_before: string | null
	status_after: string
	commit_oid: string
}

export interface HistoryCommitData {
	oid: string
	changed_paths: string[]
}

export interface HistoryData {
	artifact_id: string
	effects: HistoryEffectData[]
	commits: HistoryCommitData[]
}

export interface ResolveCurrentData {
	input_id: string
	current_ids: string[]
	nodes: ArtifactSummaryProjection[]
	edges: RelationEdgeData[]
}

// ---------------------------------------------------------------------------
// The stable envelope (10-query-and-trace.md "Stable Query Result Envelope")
// ---------------------------------------------------------------------------

interface QueryResultEnvelope<K extends QueryKind, D> {
	schema: 'ef/query-result@1'
	kind: K
	complete: boolean
	data: D | null
	diagnostics: Diagnostic[]
}

export type QueryResult
	= | QueryResultEnvelope<'lookup', LookupData>
		| QueryResultEnvelope<'list', ListData>
		| QueryResultEnvelope<'search', SearchData>
		| QueryResultEnvelope<'relations', RelationsData>
		| QueryResultEnvelope<'trace', TraceData>
		| QueryResultEnvelope<'impact', ImpactData>
		| QueryResultEnvelope<'history', HistoryData>
		| QueryResultEnvelope<'resolve-current', ResolveCurrentData>
