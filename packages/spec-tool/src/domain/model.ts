/**
 * Core EF domain model shared by every module.
 *
 * These types and tables are the single in-code source of the EF Core v1
 * vocabulary defined by docs/ef-core (01-envelope, 02-identity, 03-lifecycle,
 * 04-relations, 06-resources). Validators consume them; they never redefine
 * them locally.
 */

export const ARTIFACT_TYPES = ['project', 'prd', 'requirement', 'decision', 'policy', 'change'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export const STATUSES = ['draft', 'active', 'superseded', 'retired', 'completed'] as const
export type Status = (typeof STATUSES)[number]

export const SEMANTIC_RELATION_TYPES = ['derived-from', 'addresses', 'governed-by', 'superseded-by', 'references'] as const
export const EFFECT_RELATION_TYPES = ['introduces', 'modifies', 'retires'] as const
export const RELATION_TYPES = [...SEMANTIC_RELATION_TYPES, ...EFFECT_RELATION_TYPES] as const
export type RelationType = (typeof RELATION_TYPES)[number]
export type EffectRelationType = (typeof EFFECT_RELATION_TYPES)[number]

export const RESOURCE_TYPES = ['openapi', 'json-schema', 'diagram', 'example', 'benchmark', 'prototype', 'screenshot', 'reference', 'data', 'asset', 'other'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const RESOURCE_ROLES = ['contract', 'evidence', 'explanation', 'example', 'reference', 'prototype', 'asset'] as const
export type ResourceRole = (typeof RESOURCE_ROLES)[number]

/** `schema` field value per Artifact type (01-artifact-envelope). */
export const SCHEMA_BY_TYPE: Record<ArtifactType, string> = {
	project: 'ef/project@1',
	prd: 'ef/prd@1',
	requirement: 'ef/requirement@1',
	decision: 'ef/decision@1',
	policy: 'ef/policy@1',
	change: 'ef/change@1',
}

/** ID prefix per numbered Artifact type; PROJECT uses the exact ID `PROJECT` (02-identity). */
export const ID_PREFIX_BY_TYPE: Record<Exclude<ArtifactType, 'project'>, string> = {
	prd: 'PRD',
	requirement: 'REQ',
	decision: 'ADR',
	policy: 'POL',
	change: 'CHG',
}

/** Allowed statuses per Artifact type (03-lifecycle). */
export const ALLOWED_STATUSES: Record<ArtifactType, readonly Status[]> = {
	project: ['active'],
	prd: ['draft', 'active', 'superseded', 'retired'],
	requirement: ['draft', 'active', 'superseded', 'retired'],
	decision: ['draft', 'active', 'superseded', 'retired'],
	policy: ['draft', 'active', 'superseded', 'retired'],
	change: ['draft', 'completed', 'retired'],
}

/** Legal lifecycle transitions per Artifact type (03-lifecycle). */
export const ALLOWED_TRANSITIONS: Record<ArtifactType, readonly (readonly [Status, Status])[]> = {
	project: [],
	prd: [['draft', 'active'], ['draft', 'retired'], ['active', 'superseded'], ['active', 'retired']],
	requirement: [['draft', 'active'], ['draft', 'retired'], ['active', 'superseded'], ['active', 'retired']],
	decision: [['draft', 'active'], ['draft', 'retired'], ['active', 'superseded'], ['active', 'retired']],
	policy: [['draft', 'active'], ['draft', 'retired'], ['active', 'superseded'], ['active', 'retired']],
	change: [['draft', 'completed'], ['draft', 'retired']],
}

export const TERMINAL_STATUSES: readonly Status[] = ['superseded', 'retired', 'completed']

/**
 * Relation source/target compatibility (04-relations). `superseded-by`
 * additionally requires source and target types to be equal.
 */
export const RELATION_COMPATIBILITY: Record<RelationType, { sources: readonly ArtifactType[], targets: readonly ArtifactType[] }> = {
	'derived-from': { sources: ['prd', 'requirement', 'policy'], targets: ['prd', 'requirement', 'policy'] },
	'addresses': { sources: ['decision'], targets: ['requirement'] },
	'governed-by': { sources: ['prd', 'requirement', 'decision', 'change'], targets: ['policy'] },
	'superseded-by': { sources: ['prd', 'requirement', 'decision', 'policy'], targets: ['prd', 'requirement', 'decision', 'policy'] },
	'references': { sources: [...ARTIFACT_TYPES], targets: [...ARTIFACT_TYPES] },
	'introduces': { sources: ['change'], targets: ['prd', 'requirement', 'decision', 'policy'] },
	'modifies': { sources: ['change'], targets: ['project', 'prd', 'requirement', 'decision', 'policy'] },
	'retires': { sources: ['change'], targets: ['prd', 'requirement', 'decision', 'policy'] },
}

/** Per-source-type `derived-from` target restriction (04-relations). */
export const DERIVED_FROM_TARGETS: Record<'prd' | 'requirement' | 'policy', readonly ArtifactType[]> = {
	prd: ['prd'],
	requirement: ['prd', 'requirement'],
	policy: ['requirement', 'policy'],
}

export interface RelationEntry {
	type: RelationType
	target: string
	/** `x-*` extension fields in stored order. */
	extensions: Record<string, unknown>
}

export interface ResourceDescriptor {
	type: string
	location: string
	role: string
	mediaType: string
	normative: boolean
	description: string
	extensions: Record<string, unknown>
}

/** The nine-field artifact envelope after successful decoding (01-artifact-envelope). */
export interface Envelope {
	schema: string
	type: ArtifactType
	id: string
	title: string
	status: Status
	summary: string
	tags: string[]
	relations: RelationEntry[]
	resources: ResourceDescriptor[]
	/** Top-level `x-*` extension fields in stored order. */
	extensions: Record<string, unknown>
}

/** Canonical envelope field order (01-artifact-envelope). */
export const ENVELOPE_FIELD_ORDER = ['schema', 'type', 'id', 'title', 'status', 'summary', 'tags', 'relations', 'resources'] as const

/** Canonical project-relative directory per Artifact type (11-filesystem-and-config). */
export const CANONICAL_DIR_BY_TYPE: Record<ArtifactType, string> = {
	project: '.engineering',
	prd: '.engineering/prd',
	requirement: '.engineering/req',
	decision: '.engineering/adr',
	policy: '.engineering/pol',
	change: '.engineering/chg',
}

const utf8Encoder = new TextEncoder()

/** Compare two strings by UTF-8 byte order (bytewise lexicographic). */
export function compareBytewise(a: string, b: string): number {
	const ab = utf8Encoder.encode(a)
	const bb = utf8Encoder.encode(b)
	const length = Math.min(ab.length, bb.length)
	for (let i = 0; i < length; i++) {
		const diff = ab[i]! - bb[i]!
		if (diff !== 0)
			return diff
	}
	return ab.length - bb.length
}
