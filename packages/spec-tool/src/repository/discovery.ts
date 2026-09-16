import type { Diagnostic } from '../domain/diagnostics'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { diagnostic } from '../domain/diagnostics'
import { CONFIG_PATH, decodeConfig } from './config'
import { CANONICAL_DIRECTORY_BY_KIND, RESOURCE_ROOT, SPEC_ROOT } from './layout'

export interface WorkspaceRootResult {
	root?: string
	diagnostics: Diagnostic[]
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory()
	}
	catch {
		return false
	}
}

/** Resolve an explicit project root or find the nearest ancestor containing `.spec`. */
export async function resolveWorkspaceRoot(start: string, explicit?: string): Promise<WorkspaceRootResult> {
	if (explicit !== undefined)
		return { root: resolve(start, explicit), diagnostics: [] }
	let current = resolve(start)
	while (true) {
		if (await isDirectory(join(current, SPEC_ROOT)))
			return { root: current, diagnostics: [] }
		const parent = dirname(current)
		if (parent === current)
			return { diagnostics: [diagnostic('SPEC-LAYOUT-INVALID', `No '${SPEC_ROOT}/' workspace was found from '${start}'.`)] }
		current = parent
	}
}

export interface DiscoveredArtifactFile {
	relativePath: string
	absolutePath: string
}

export interface DiscoverWorkspaceFilesResult {
	files: DiscoveredArtifactFile[]
	diagnostics: Diagnostic[]
}

async function walk(directory: string, root: string, files: DiscoveredArtifactFile[], diagnostics: Diagnostic[]): Promise<void> {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	}
	catch (error) {
		diagnostics.push(diagnostic('SPEC-IO-ERROR', `Could not read '${relative(root, directory)}': ${(error as Error).message}.`, { path: relative(root, directory) || '.' }))
		return
	}
	for (const entry of entries) {
		const absolutePath = join(directory, entry.name)
		const relativePath = normalize(relative(root, absolutePath))
			.split('\\')
			.join('/')
		if (entry.isSymbolicLink()) {
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Symbolic links are not valid inside the Spec workspace: '${relativePath}'.`, { path: relativePath }))
			continue
		}
		if (entry.isDirectory()) {
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Nested directory '${relativePath}/' is not part of the canonical Spec layout.`, { path: relativePath }))
			continue
		}
		if (entry.isFile() && relativePath.endsWith('.md'))
			files.push({ relativePath, absolutePath })
		else
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Unexpected entry '${relativePath}' in the Spec workspace.`, { path: relativePath }))
	}
}

/** Discover every Markdown entry under `.spec`, without reading `.engineering`. */
export async function discoverWorkspaceFiles(root: string): Promise<DiscoverWorkspaceFilesResult> {
	const specDirectory = join(root, SPEC_ROOT)
	const diagnostics: Diagnostic[] = []
	const files: DiscoveredArtifactFile[] = []
	if (!(await isDirectory(specDirectory))) {
		diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Spec workspace root '${SPEC_ROOT}/' must be a directory.`, { path: SPEC_ROOT }))
		return { files, diagnostics }
	}
	let entries
	try {
		entries = await readdir(specDirectory, { withFileTypes: true })
	}
	catch (error) {
		diagnostics.push(diagnostic('SPEC-IO-ERROR', `Could not read '${SPEC_ROOT}/': ${(error as Error).message}.`, { path: SPEC_ROOT }))
		return { files, diagnostics }
	}
	const allowedDirectories = new Set(Object.values(CANONICAL_DIRECTORY_BY_KIND))
	for (const entry of entries) {
		const relativePath = `${SPEC_ROOT}/${entry.name}`
		if (relativePath === CONFIG_PATH)
			continue
		if (relativePath === RESOURCE_ROOT) {
			if (!entry.isDirectory())
				diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Resource root '${RESOURCE_ROOT}/' must be a directory.`, { path: RESOURCE_ROOT }))
			continue
		}
		if (!entry.isDirectory() || !allowedDirectories.has(relativePath)) {
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Unexpected entry '${relativePath}' in the Spec workspace.`, { path: relativePath }))
			continue
		}
		await walk(join(specDirectory, entry.name), root, files, diagnostics)
	}
	files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
	return { files, diagnostics }
}

export async function readWorkspaceConfig(root: string): Promise<{ config: ReturnType<typeof decodeConfig>['config'], diagnostics: Diagnostic[] }> {
	const configPath = join(root, CONFIG_PATH)
	try {
		const stat = await lstat(configPath)
		if (!stat.isFile())
			return { config: null, diagnostics: [diagnostic('SPEC-LAYOUT-INVALID', `'${CONFIG_PATH}' must be a regular file.`, { path: CONFIG_PATH })] }
		const text = await readFile(configPath, 'utf8')
		const result = decodeConfig(text, CONFIG_PATH)
		return result
	}
	catch (error) {
		return { config: null, diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not read '${CONFIG_PATH}': ${(error as Error).message}.`, { path: CONFIG_PATH })] }
	}
}
