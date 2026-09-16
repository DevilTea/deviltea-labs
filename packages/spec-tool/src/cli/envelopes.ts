import type { MutationResult, RelationView, ResourceReadValue } from '../application/mutations'
import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact, ResourceDescriptor } from '../domain/model'

export interface InitResultJson {
	schema: 'spec/init-result@1'
	ok: boolean
	applied: boolean
	root?: string
	project?: Pick<Artifact, 'schema' | 'kind' | 'id' | 'title' | 'status'>
	diagnostics: Diagnostic[]
}

export interface ValidationResultJson {
	schema: 'spec/validation-result@1'
	valid: boolean
	complete: boolean
	artifactCount: number
	projectCount: number
	diagnostics: Diagnostic[]
}

export interface ArtifactResultJson {
	schema: 'spec/artifact-result@1'
	action: 'create' | 'get' | 'update'
	ok: boolean
	applied: boolean
	artifact?: Artifact
	diagnostics: Diagnostic[]
}

export interface ArtifactDeleteResultJson {
	schema: 'spec/artifact-delete-result@1'
	ok: boolean
	applied: boolean
	deleted?: { id: string, path: string }
	diagnostics: Diagnostic[]
}

export interface ArtifactListResultJson {
	schema: 'spec/artifact-list-result@1'
	ok: boolean
	applied: boolean
	artifacts: Artifact[]
	diagnostics: Diagnostic[]
}

export interface RelationResultJson {
	schema: 'spec/relation-result@1'
	ok: boolean
	applied: boolean
	relation?: RelationView
	replacement?: Artifact
	replaced?: Artifact
	diagnostics: Diagnostic[]
}

export interface RelationListResultJson {
	schema: 'spec/relation-list-result@1'
	ok: boolean
	applied: boolean
	relations: RelationView[]
	diagnostics: Diagnostic[]
}

export interface LifecycleResultJson {
	schema: 'spec/lifecycle-result@1'
	ok: boolean
	applied: boolean
	artifact?: Artifact
	replacement?: Artifact
	replaced?: Artifact
	diagnostics: Diagnostic[]
}

export interface ResourceResultJson {
	schema: 'spec/resource-result@1'
	ok: boolean
	applied: boolean
	resource?: ResourceDescriptor
	diagnostics: Diagnostic[]
}

export interface ResourceListResultJson {
	schema: 'spec/resource-list-result@1'
	ok: boolean
	applied: boolean
	resources: Array<{ artifactId: string, resource: ResourceDescriptor }>
	diagnostics: Diagnostic[]
}

export interface ResourceReadResultJson {
	schema: 'spec/resource-read-result@1'
	ok: boolean
	applied: boolean
	artifactId?: string
	resource?: ResourceDescriptor
	content?: string
	encoding?: 'utf8'
	bytes?: number
	diagnostics: Diagnostic[]
}

export function initResultJson(result: Omit<InitResultJson, 'schema'>): InitResultJson {
	return { schema: 'spec/init-result@1', ...result }
}

export function validationResultJson(result: Omit<ValidationResultJson, 'schema'>): ValidationResultJson {
	return { schema: 'spec/validation-result@1', ...result }
}

export function artifactResultJson(action: ArtifactResultJson['action'], result: MutationResult<Artifact>): ArtifactResultJson {
	return { schema: 'spec/artifact-result@1', action, ok: result.ok, applied: result.applied, artifact: result.value, diagnostics: result.diagnostics }
}

export function artifactDeleteResultJson(result: MutationResult<{ id: string, path: string }>): ArtifactDeleteResultJson {
	return { schema: 'spec/artifact-delete-result@1', ok: result.ok, applied: result.applied, deleted: result.value, diagnostics: result.diagnostics }
}

export function artifactListResultJson(result: MutationResult<Artifact[]>): ArtifactListResultJson {
	return { schema: 'spec/artifact-list-result@1', ok: result.ok, applied: result.applied, artifacts: result.value ?? [], diagnostics: result.diagnostics }
}

export function relationResultJson(result: MutationResult<RelationView | { replacement: Artifact, replaced: Artifact }>): RelationResultJson {
	const value = result.value
	return {
		schema: 'spec/relation-result@1',
		ok: result.ok,
		applied: result.applied,
		relation: value && 'source' in value ? value : undefined,
		replacement: value && 'replacement' in value ? value.replacement : undefined,
		replaced: value && 'replaced' in value ? value.replaced : undefined,
		diagnostics: result.diagnostics,
	}
}

export function relationListResultJson(result: MutationResult<RelationView[]>): RelationListResultJson {
	return { schema: 'spec/relation-list-result@1', ok: result.ok, applied: result.applied, relations: result.value ?? [], diagnostics: result.diagnostics }
}

export function lifecycleResultJson(result: MutationResult<Artifact | { replacement: Artifact, replaced: Artifact }>): LifecycleResultJson {
	const value = result.value
	return {
		schema: 'spec/lifecycle-result@1',
		ok: result.ok,
		applied: result.applied,
		artifact: value && 'kind' in value ? value : undefined,
		replacement: value && 'replacement' in value ? value.replacement : undefined,
		replaced: value && 'replaced' in value ? value.replaced : undefined,
		diagnostics: result.diagnostics,
	}
}

export function resourceResultJson(result: MutationResult<ResourceDescriptor>): ResourceResultJson {
	return { schema: 'spec/resource-result@1', ok: result.ok, applied: result.applied, resource: result.value, diagnostics: result.diagnostics }
}

export function resourceListResultJson(result: MutationResult<Array<{ artifactId: string, resource: ResourceDescriptor }>>): ResourceListResultJson {
	return { schema: 'spec/resource-list-result@1', ok: result.ok, applied: result.applied, resources: result.value ?? [], diagnostics: result.diagnostics }
}

export function resourceReadResultJson(result: MutationResult<ResourceReadValue>): ResourceReadResultJson {
	return {
		schema: 'spec/resource-read-result@1',
		ok: result.ok,
		applied: result.applied,
		artifactId: result.value?.artifactId,
		resource: result.value?.resource,
		content: result.value?.content,
		encoding: result.value?.encoding,
		bytes: result.value?.bytes,
		diagnostics: result.diagnostics,
	}
}
