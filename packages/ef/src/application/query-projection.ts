/**
 * Artifact projection construction (10-query-and-trace.md "Projections").
 *
 * `buildArtifactSummary`/`buildArtifactFull` turn an already-decoded
 * `Envelope` (./domain/model, ./domain/envelope) plus its canonical path into
 * the exact `ef/query-result@1` core-key object every query kind embeds.
 * Deliberately built from the *raw decoded* envelope (not the
 * relation-graph-filtered subset `snapshot-validation.ts` keeps for indexing)
 * so a discoverable Artifact's projected `relations`/`resources` always
 * mirror its authoritative file content byte-for-byte in meaning, per
 * "Queries MUST NOT repair, format, mutate ... authoritative content."
 */

import type { ArtifactType, Envelope, RelationEntry, ResourceDescriptor } from '../domain/model'
import { CANONICAL_DIR_BY_TYPE, compareBytewise } from '../domain/model'

/** Canonical project-relative path for an Artifact identified by `(type, id)` (02-identity, 11-filesystem-and-config). */
export function canonicalArtifactPath(type: ArtifactType, id: string): string {
	const directory = CANONICAL_DIR_BY_TYPE[type]
	return type === 'project' ? `${directory}/PROJECT.md` : `${directory}/${id}.md`
}

/** Sort extension keys canonically (bytewise), mirroring the envelope/relation/resource canonical-ordering rules. */
function sortedExtensions(extensions: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const key of Object.keys(extensions)
		.sort(compareBytewise))
		result[key] = extensions[key]
	return result
}

/** One projected relation entry: `{type, target, ...x-* extensions}` (04-relations canonical field shape). */
function projectRelation(relation: RelationEntry): Record<string, unknown> {
	return { type: relation.type, target: relation.target, ...sortedExtensions(relation.extensions) }
}

/** One projected Resource descriptor: wire field names (`media_type`, not `mediaType`), plus `x-*` extensions (06-resources canonical field shape). */
function projectResource(resource: ResourceDescriptor): Record<string, unknown> {
	return {
		type: resource.type,
		location: resource.location,
		role: resource.role,
		media_type: resource.mediaType,
		normative: resource.normative,
		description: resource.description,
		...sortedExtensions(resource.extensions),
	}
}

/** The `ef/query-result@1` summary projection core keys, plus any top-level `x-*` extensions (10-query-and-trace.md "Summary projection"). */
export interface ArtifactSummaryProjection {
	schema: string
	type: string
	id: string
	title: string
	status: string
	summary: string
	tags: string[]
	relations: Record<string, unknown>[]
	resources: Record<string, unknown>[]
	path: string
	[extensionField: string]: unknown
}

export interface ArtifactFullProjection extends ArtifactSummaryProjection {
	body: string
}

/** Build the summary projection (10-query-and-trace.md "Summary projection") for one decoded envelope at its canonical path. */
export function buildArtifactSummary(envelope: Envelope, path: string): ArtifactSummaryProjection {
	return {
		schema: envelope.schema,
		type: envelope.type,
		id: envelope.id,
		title: envelope.title,
		status: envelope.status,
		summary: envelope.summary,
		tags: [...envelope.tags],
		relations: envelope.relations.map(projectRelation),
		resources: envelope.resources.map(projectResource),
		path,
		...sortedExtensions(envelope.extensions),
	}
}

/** Build the full projection (10-query-and-trace.md "Full projection"): the summary projection plus the raw post-frontmatter Markdown `body`. */
export function buildArtifactFull(envelope: Envelope, path: string, body: string): ArtifactFullProjection {
	return { ...buildArtifactSummary(envelope, path), body }
}
