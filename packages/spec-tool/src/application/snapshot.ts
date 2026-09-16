import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact, Config } from '../domain/model'
import { readFile } from 'node:fs/promises'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { decodeArtifact } from '../domain/envelope'
import { discoverWorkspaceFiles, readWorkspaceConfig } from '../repository/discovery'
import { validateWorkspaceLayout } from '../repository/workspace'

export interface SnapshotArtifactFile {
	path: string
	absolutePath: string
	artifact: Artifact | null
	candidateId?: string
	candidateKind?: string
	diagnostics: Diagnostic[]
}

export interface ProjectSnapshot {
	root: string
	config: Config | null
	files: SnapshotArtifactFile[]
	artifacts: Artifact[]
	diagnostics: Diagnostic[]
	complete: boolean
}

export interface LoadSnapshotResult {
	ok: boolean
	snapshot: ProjectSnapshot
	diagnostics: Diagnostic[]
	complete: boolean
}

/** Read the current `.spec/` tree. No Git state or `.engineering/` state is consulted. */
export async function loadSnapshotFromWorkingTree(root: string): Promise<LoadSnapshotResult> {
	const layout = await validateWorkspaceLayout(root)
	const configResult = await readWorkspaceConfig(root)
	const discovered = await discoverWorkspaceFiles(root)
	const files: SnapshotArtifactFile[] = []
	const diagnostics: Diagnostic[] = [...layout.diagnostics, ...configResult.diagnostics, ...discovered.diagnostics]

	for (const file of discovered.files) {
		try {
			const source = await readFile(file.absolutePath, 'utf8')
			const decoded = decodeArtifact(source, file.relativePath)
			files.push({
				path: file.relativePath,
				absolutePath: file.absolutePath,
				artifact: decoded.artifact,
				candidateId: decoded.candidateId,
				candidateKind: decoded.candidateKind,
				diagnostics: decoded.diagnostics,
			})
			diagnostics.push(...decoded.diagnostics)
		}
		catch (error) {
			const fileDiagnostics = [{
				code: 'SPEC-IO-ERROR',
				severity: 'error' as const,
				message: `Could not read '${file.relativePath}': ${(error as Error).message}.`,
				path: file.relativePath,
				related: [],
			}]
			files.push({ path: file.relativePath, absolutePath: file.absolutePath, artifact: null, diagnostics: fileDiagnostics })
			diagnostics.push(...fileDiagnostics)
		}
	}

	const artifacts = files.flatMap(file => file.artifact ? [file.artifact] : [])
	const aggregate = aggregateDiagnostics(diagnostics)
	const complete = !aggregate.some(item => item.code === 'SPEC-IO-ERROR')
	const snapshot: ProjectSnapshot = {
		root,
		config: configResult.config,
		files,
		artifacts,
		diagnostics: aggregate,
		complete,
	}
	return { ok: aggregate.length === 0, snapshot, diagnostics: aggregate, complete }
}

export const loadWorkspaceSnapshot = loadSnapshotFromWorkingTree
