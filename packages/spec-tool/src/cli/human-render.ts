import type { ArtifactDeleteResultJson, ArtifactListResultJson, ArtifactResultJson, InitResultJson, LifecycleResultJson, RelationListResultJson, RelationResultJson, ResourceListResultJson, ResourceReadResultJson, ResourceResultJson, SearchResultJson, TraceResultJson, ValidationResultJson } from './envelopes'

export function renderInit(result: InitResultJson): string {
	if (!result.ok) {
		return `${result.diagnostics.map(item => `${item.code}: ${item.message}`)
			.join('\n')}\n`
	}
	return `Initialized .spec/ workspace at ${result.root}.\nProject ${result.project?.id}: ${result.project?.title}\n`
}

export function renderValidation(result: ValidationResultJson): string {
	const lines = [`Spec validation: ${result.valid ? 'valid' : 'invalid'}`, `Artifacts: ${result.artifactCount}`, `Projects: ${result.projectCount}`]
	for (const item of result.diagnostics)
		lines.push(`${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`)
	return `${lines.join('\n')}\n`
}

function diagnosticsText(diagnostics: { code: string, message: string }[]): string {
	return diagnostics.map(item => `${item.code}: ${item.message}`)
		.join('\n')
}

function renderArtifact(artifact: ArtifactResultJson['artifact']): string[] {
	if (!artifact)
		return []
	return [
		`Artifact ${artifact.id}`,
		`Kind: ${artifact.kind}`,
		`Status: ${artifact.status}`,
		`Title: ${artifact.title}`,
		`Path: ${artifact.path ?? ''}`,
		'',
		artifact.body,
	]
}

export function renderArtifactResult(result: ArtifactResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.action === 'get' ? '' : `${result.action === 'create' ? 'Created' : 'Updated'} `}${renderArtifact(result.artifact)
		.join('\n')}\n`
}

export function renderArtifactDelete(result: ArtifactDeleteResultJson): string {
	return result.ok
		? `Deleted Artifact ${result.deleted?.id} (${result.deleted?.path})\n`
		: `${diagnosticsText(result.diagnostics)}\n`
}

export function renderArtifactList(result: ArtifactListResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.artifacts.map(artifact => `${artifact.id}\t${artifact.kind}\t${artifact.status}\t${artifact.title}`)
		.join('\n')}${result.artifacts.length > 0 ? '\n' : ''}`
}

export function renderRelationResult(result: RelationResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	if (result.relation)
		return `${result.relation.source}\t${result.relation.type}\t${result.relation.target}\n`
	return `Superseded ${result.replaced?.id}; replacement ${result.replacement?.id}\n`
}

export function renderRelationList(result: RelationListResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.relations.map(relation => `${relation.source}\t${relation.type}\t${relation.target}`)
		.join('\n')}${result.relations.length > 0 ? '\n' : ''}`
}

export function renderLifecycleResult(result: LifecycleResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	if (result.artifact)
		return `Artifact ${result.artifact.id} is now ${result.artifact.status}.\n`
	return `Artifact ${result.replaced?.id} is superseded by ${result.replacement?.id}.\n`
}

export function renderResourceResult(result: ResourceResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.resource?.location}\t${result.resource?.role}\t${result.resource?.mediaType}\n`
}

export function renderResourceList(result: ResourceListResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.resources.map(item => `${item.artifactId}\t${item.resource.location}\t${item.resource.role}\t${item.resource.mediaType}`)
		.join('\n')}${result.resources.length > 0 ? '\n' : ''}`
}

export function renderResourceRead(result: ResourceReadResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return result.content ?? ''
}

export function renderSearchResult(result: SearchResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	return `${result.matches.map(match => `${match.artifact.id}\t${match.artifact.kind}\t${match.artifact.status}\t${match.matchedFields.join(',')}\t${match.artifact.title}`)
		.join('\n')}${result.matches.length > 0 ? '\n' : ''}`
}

export function renderTraceResult(result: TraceResultJson): string {
	if (!result.ok)
		return `${diagnosticsText(result.diagnostics)}\n`
	const lines = [`Trace ${result.artifactId} (${result.direction})`, 'Artifacts:']
	for (const artifact of result.artifacts)
		lines.push(`${artifact.id}\t${artifact.kind}\t${artifact.status}\t${artifact.title}`)
	lines.push('Relations:')
	for (const relation of result.relations)
		lines.push(`${relation.source}\t${relation.type}\t${relation.target}`)
	return `${lines.join('\n')}\n`
}
