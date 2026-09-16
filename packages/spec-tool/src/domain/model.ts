/** The persisted Spec-native vocabulary. */

export const ARTIFACT_KINDS = [
	'project',
	'prd',
	'story',
	'use-case',
	'feature',
	'requirement',
	'decision',
	'policy',
	'change',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const STATUSES = ['draft', 'active', 'superseded', 'retired', 'completed'] as const
export type Status = (typeof STATUSES)[number]

export const SPEC_CONFIG_SCHEMA = 'spec/config@1' as const

export const SCHEMA_BY_KIND: Record<ArtifactKind, `spec/${ArtifactKind}@1`> = {
	'project': 'spec/project@1',
	'prd': 'spec/prd@1',
	'story': 'spec/story@1',
	'use-case': 'spec/use-case@1',
	'feature': 'spec/feature@1',
	'requirement': 'spec/requirement@1',
	'decision': 'spec/decision@1',
	'policy': 'spec/policy@1',
	'change': 'spec/change@1',
}

export const PLURAL_DIRECTORY_BY_KIND: Record<ArtifactKind, string> = {
	'project': 'projects',
	'prd': 'prds',
	'story': 'stories',
	'use-case': 'use-cases',
	'feature': 'features',
	'requirement': 'requirements',
	'decision': 'decisions',
	'policy': 'policies',
	'change': 'changes',
}

export const CANONICAL_DIR_BY_KIND: Record<ArtifactKind, string> = Object.fromEntries(
	Object.entries(PLURAL_DIRECTORY_BY_KIND)
		.map(([kind, directory]) => [kind, `.spec/${directory}`]),
) as Record<ArtifactKind, string>

export const ALLOWED_STATUSES: Record<ArtifactKind, readonly Status[]> = {
	'project': ['active'],
	'prd': ['draft', 'active', 'superseded', 'retired'],
	'story': ['draft', 'active', 'superseded', 'retired'],
	'use-case': ['draft', 'active', 'superseded', 'retired'],
	'feature': ['draft', 'active', 'superseded', 'retired'],
	'requirement': ['draft', 'active', 'superseded', 'retired'],
	'decision': ['draft', 'active', 'superseded', 'retired'],
	'policy': ['draft', 'active', 'superseded', 'retired'],
	'change': ['draft', 'completed', 'retired'],
}

export const REQUIRED_SECTIONS: Record<ArtifactKind, readonly string[]> = {
	'project': ['Vision', 'Scope', 'Non-goals', 'Context', 'Terminology'],
	'prd': ['Problem', 'User Need', 'Desired Outcome', 'Success Criteria', 'Non-goals'],
	'story': ['Actor', 'Goal', 'Value'],
	'use-case': ['Preconditions', 'Main Flow', 'Alternate & Failure Flows', 'Observable Outcomes'],
	'feature': ['Capability', 'Semantics', 'Rules', 'Edge Cases'],
	'requirement': ['Contract', 'Rationale', 'Verification'],
	'decision': ['Context', 'Decision', 'Alternatives', 'Consequences'],
	'policy': ['Policy', 'Scope', 'Rationale', 'Compliance'],
	'change': ['Rationale', 'Sources', 'Changes', 'Verification'],
}

export interface RelationEntry {
	type: string
	target: string
}

export interface ResourceDescriptor {
	location: string
	role: string
	mediaType: string
	description: string
}

/** The exact common stored envelope. Do not add summary, tags, or extensions. */
export interface ArtifactEnvelope {
	schema: string
	kind: ArtifactKind
	id: string
	title: string
	status: Status
	relations: RelationEntry[]
	resources: ResourceDescriptor[]
}

export interface Artifact extends ArtifactEnvelope {
	body: string
	path?: string
}

export interface Config {
	schema: typeof SPEC_CONFIG_SCHEMA
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
	return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

export function isStatus(value: unknown): value is Status {
	return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

export function schemaForKind(kind: ArtifactKind): string {
	return SCHEMA_BY_KIND[kind]
}

export function directoryForKind(kind: ArtifactKind): string {
	return PLURAL_DIRECTORY_BY_KIND[kind]
}
