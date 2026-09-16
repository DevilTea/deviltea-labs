import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact, ArtifactKind, Status } from '../domain/model'
import { aggregateDiagnostics, diagnostic } from '../domain/diagnostics'
import { isArtifactKind, isStatus } from '../domain/model'
import { compareBytewise } from '../domain/text'
import { canonicalArtifactPath } from '../repository/layout'
import { validateRelationGraph } from './mutations'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

export interface QueryResult<T> {
	ok: boolean
	value?: T
	diagnostics: Diagnostic[]
}

export interface SearchFilters {
	kind?: string
	status?: string
}

export type SearchMatchedField = 'title' | 'body'

export interface SearchMatch {
	artifact: Artifact
	matchedFields: SearchMatchedField[]
}

export type TraceDirection = 'up' | 'down' | 'both'

export interface TraceEdge {
	source: string
	type: 'refines'
	target: string
}

export interface TraceValue {
	artifactId: string
	direction: TraceDirection
	artifacts: Artifact[]
	relations: TraceEdge[]
}

interface QueryContext {
	artifacts: Artifact[]
	byId: Map<string, Artifact>
}

function failure<T>(diagnostics: Diagnostic[]): QueryResult<T> {
	return { ok: false, diagnostics: aggregateDiagnostics(diagnostics) }
}

function success<T>(value: T): QueryResult<T> {
	return { ok: true, value, diagnostics: [] }
}

function artifactPath(artifact: Artifact): string {
	return artifact.path ?? canonicalArtifactPath(artifact.kind, artifact.id)
}

function sortArtifacts(artifacts: Iterable<Artifact>): Artifact[] {
	return [...artifacts].sort((left, right) => compareBytewise(artifactPath(left), artifactPath(right)))
}

async function loadQueryContext(root: string): Promise<QueryResult<QueryContext>> {
	const loaded = await loadSnapshotFromWorkingTree(root)
	const validation = validateSnapshot(loaded.snapshot)
	const diagnostics = aggregateDiagnostics([
		...validation.diagnostics,
		...validateRelationGraph(loaded.snapshot.artifacts),
	])
	if (diagnostics.length > 0 || !validation.complete)
		return failure(diagnostics.length > 0 ? diagnostics : [diagnostic('SPEC-IO-ERROR', 'The Spec workspace could not be read completely.', { path: '.spec' })])
	const artifacts = sortArtifacts(loaded.snapshot.artifacts)
	return success({ artifacts, byId: new Map(artifacts.map(artifact => [artifact.id, artifact])) })
}

export async function searchArtifacts(root: string, query: string, filters: SearchFilters = {}): Promise<QueryResult<SearchMatch[]>> {
	const diagnostics: Diagnostic[] = []
	if (query.trim() === '')
		diagnostics.push(diagnostic('SPEC-CLI-INVALID', 'Search text must not be empty.', { field: 'text' }))
	if (filters.kind !== undefined && !isArtifactKind(filters.kind))
		diagnostics.push(diagnostic('SPEC-CLI-INVALID', `Unknown artifact kind '${filters.kind}'.`, { field: 'kind' }))
	if (filters.status !== undefined && !isStatus(filters.status))
		diagnostics.push(diagnostic('SPEC-CLI-INVALID', `Unknown artifact status '${filters.status}'.`, { field: 'status' }))
	if (diagnostics.length > 0)
		return failure(diagnostics)

	const context = await loadQueryContext(root)
	if (!context.ok || !context.value)
		return failure(context.diagnostics)
	const needle = query.toLowerCase()
	const kind = filters.kind as ArtifactKind | undefined
	const status = filters.status as Status | undefined
	const matches = context.value.artifacts.flatMap((artifact): SearchMatch[] => {
		if ((kind !== undefined && artifact.kind !== kind) || (status !== undefined && artifact.status !== status))
			return []
		const matchedFields: SearchMatchedField[] = []
		if (artifact.title.toLowerCase()
			.includes(needle)) {
			matchedFields.push('title')
		}
		if (artifact.body.toLowerCase()
			.includes(needle)) {
			matchedFields.push('body')
		}
		return matchedFields.length > 0 ? [{ artifact, matchedFields }] : []
	})
	return success(matches)
}

export async function traceRefines(root: string, artifactId: string, directionValue: string = 'both'): Promise<QueryResult<TraceValue>> {
	if (!['up', 'down', 'both'].includes(directionValue))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown trace direction '${directionValue}'.`, { field: 'direction' })])
	const direction = directionValue as TraceDirection
	const context = await loadQueryContext(root)
	if (!context.ok || !context.value)
		return failure(context.diagnostics)
	if (!context.value.byId.has(artifactId))
		return failure([diagnostic('SPEC-ARTIFACT-NOT-FOUND', `Artifact '${artifactId}' was not found.`, { artifactId })])

	const visited = new Set<string>()
	const pending = [artifactId]
	const edges = new Map<string, TraceEdge>()
	while (pending.length > 0) {
		const currentId = pending.shift()!
		if (visited.has(currentId))
			continue
		visited.add(currentId)
		const current = context.value.byId.get(currentId)!

		if (direction === 'up' || direction === 'both') {
			for (const relation of current.relations) {
				if (relation.type !== 'refines')
					continue
				const edge = { source: current.id, type: 'refines' as const, target: relation.target }
				edges.set(`${edge.source}\u0000${edge.target}`, edge)
				if (!visited.has(edge.target))
					pending.push(edge.target)
			}
		}

		if (direction === 'down' || direction === 'both') {
			for (const source of context.value.artifacts) {
				if (!source.relations.some(relation => relation.type === 'refines' && relation.target === current.id))
					continue
				const edge = { source: source.id, type: 'refines' as const, target: current.id }
				edges.set(`${edge.source}\u0000${edge.target}`, edge)
				if (!visited.has(source.id))
					pending.push(source.id)
			}
		}
	}

	const artifacts = sortArtifacts([...visited].map(id => context.value!.byId.get(id)!))
	const relations = [...edges.values()].sort((left, right) => compareBytewise(left.source, right.source) || compareBytewise(left.target, right.target))
	return success({ artifactId, direction, artifacts, relations })
}
