import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact, ArtifactKind } from '../domain/model'
import type { ProjectSnapshot } from './snapshot'
import { basename, dirname } from 'node:path'
import { validateBody } from '../domain/body-schemas'
import { aggregateDiagnostics, diagnostic } from '../domain/diagnostics'
import { isUuidV7 } from '../domain/identity'
import { PLURAL_DIRECTORY_BY_KIND } from '../domain/model'

export interface ValidationSummary {
	valid: boolean
	complete: boolean
	diagnostics: Diagnostic[]
	artifactCount: number
	projectCount: number
}

const KIND_BY_DIRECTORY = new Map(Object.entries(PLURAL_DIRECTORY_BY_KIND)
	.map(([kind, directory]) => [`.spec/${directory}`, kind as ArtifactKind]))

function validateArtifactPath(artifact: Artifact, path: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const expectedDirectory = `.spec/${PLURAL_DIRECTORY_BY_KIND[artifact.kind]}`
	if (dirname(path) !== expectedDirectory)
		diagnostics.push(diagnostic('SPEC-PATH-INVALID', `Artifact kind '${artifact.kind}' must be stored under '${expectedDirectory}/'.`, { path }))
	const filename = basename(path, '.md')
	if (!isUuidV7(filename))
		diagnostics.push(diagnostic('SPEC-PATH-INVALID', `Artifact filename '${filename}' must be a UUIDv7.`, { path, field: 'id' }))
	else if (filename !== artifact.id)
		diagnostics.push(diagnostic('SPEC-PATH-INVALID', `Artifact filename '${filename}' does not match envelope id '${artifact.id}'.`, { path, field: 'id' }))
	return diagnostics
}

function validateFilePlacement(path: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const directory = dirname(path)
	const expectedKind = KIND_BY_DIRECTORY.get(directory)
	if (expectedKind === undefined) {
		diagnostics.push(diagnostic('SPEC-PATH-INVALID', `Artifact path '${path}' is not a canonical Spec artifact path.`, { path }))
	}
	else {
		const filename = basename(path, '.md')
		if (!path.endsWith('.md') || !isUuidV7(filename))
			diagnostics.push(diagnostic('SPEC-PATH-INVALID', `Artifact filename '${filename}' must be a UUIDv7 with a .md extension.`, { path, field: 'id' }))
	}
	return diagnostics
}

/** Validate the current workspace's deterministic structure and lifecycle/body rules. */
export function validateSnapshot(snapshot: ProjectSnapshot): ValidationSummary {
	const diagnostics: Diagnostic[] = [...snapshot.diagnostics]
	const ids = new Map<string, string>()
	for (const file of snapshot.files) {
		diagnostics.push(...validateFilePlacement(file.path))
		const id = file.artifact?.id ?? file.candidateId
		if (id !== undefined) {
			const prior = ids.get(id)
			if (prior !== undefined)
				diagnostics.push(diagnostic('SPEC-IDENTITY-DUPLICATE', `Artifact id '${id}' is used by both '${prior}' and '${file.path}'.`, { path: file.path, field: 'id', related: [{ path: prior, message: `First use of id '${id}'.` }] }))
			else
				ids.set(id, file.path)
		}
		if (file.artifact) {
			diagnostics.push(...validateArtifactPath(file.artifact, file.path))
			diagnostics.push(...validateBody(file.artifact.kind, file.artifact.status, file.artifact.body, { path: file.path }))
		}
	}
	const projects = snapshot.artifacts.filter(artifact => artifact.kind === 'project')
	if (projects.length !== 1)
		diagnostics.push(diagnostic('SPEC-PROJECT-COUNT', `Workspace must contain exactly one project Artifact; found ${projects.length}.`, { path: '.spec/projects' }))
	const aggregate = aggregateDiagnostics(diagnostics)
	return {
		valid: aggregate.length === 0,
		complete: snapshot.complete,
		diagnostics: aggregate,
		artifactCount: snapshot.artifacts.length,
		projectCount: projects.length,
	}
}

export function summarizeValidation(result: ValidationSummary): ValidationSummary {
	return result
}
