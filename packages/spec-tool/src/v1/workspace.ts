import type { FeatureData, Stored, StoryData } from './storage'
import type { MutationResponse, NormalizedEdge, NormalizedIr, NormalizedNode, ValidationIssue, ValidationResult } from './types'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { invalidRequest, validationFailed } from './errors'
import { isUuidV7 } from './identity'
import { addIssue, compareText, decodeFeature, decodeStory, statOrNull } from './storage'
import { withWorkspaceWriteLock } from './write-lock'

const SPEC = '.spec'
const MANIFEST = '.spec/spec.yaml'
const STORAGE_ROOTS = ['stories', 'features', 'contracts', 'scenarios'] as const
type StorageRoot = typeof STORAGE_ROOTS[number]

export interface WorkspaceSnapshot {
	root: string
	features: Map<string, Stored<FeatureData>>
	stories: Map<string, Stored<StoryData>>
	ir: NormalizedIr
	revision: string
}

export interface WorkspaceInspection {
	issues: ValidationIssue[]
	snapshot?: WorkspaceSnapshot
}

function compareIssue(left: ValidationIssue, right: ValidationIssue): number {
	return compareText(left.source.path, right.source.path)
		|| compareText(left.path, right.path)
		|| compareText(left.reason, right.reason)
		|| compareText(left.message, right.message)
}

function sortedIssues(issues: ValidationIssue[]): ValidationIssue[] {
	return issues.sort(compareIssue)
}

async function inspectManifest(root: string, issues: ValidationIssue[]): Promise<boolean> {
	const path = join(root, MANIFEST)
	const stat = await statOrNull(path)
	if (!stat) {
		addIssue(issues, MANIFEST, MANIFEST, 'missing', 'Workspace manifest is required.')
		return false
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		addIssue(issues, MANIFEST, MANIFEST, 'invalid_format', 'Workspace manifest must be a regular file.')
		return false
	}
	const content = await readFile(path, 'utf8')
	const document = parseDocument(content, { uniqueKeys: true })
	if (document.errors.length > 0 || !isMap(document.contents)) {
		addIssue(issues, MANIFEST, MANIFEST, 'invalid_format', 'Workspace manifest must be a valid YAML mapping.')
		return false
	}
	if (document.contents.items.length !== 1 || document.contents.items[0]?.key?.toJSON() !== 'formatVersion') {
		addIssue(issues, MANIFEST, MANIFEST, 'unsupported', 'Manifest supports only formatVersion.')
		return false
	}
	if (document.contents.items[0]?.value?.toJSON() !== 1) {
		addIssue(issues, MANIFEST, 'formatVersion', 'unsupported', 'Only workspace formatVersion 1 is supported.')
		return false
	}
	return true
}

async function scanRoot(
	root: string,
	name: StorageRoot,
	features: Map<string, Stored<FeatureData>>,
	stories: Map<string, Stored<StoryData>>,
	ids: Map<string, string>,
	issues: ValidationIssue[],
): Promise<void> {
	const directory = join(root, SPEC, name)
	const stat = await statOrNull(directory)
	if (!stat)
		return
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		addIssue(issues, `${SPEC}/${name}`, `${SPEC}/${name}`, 'invalid_format', 'Storage root must be a real directory.')
		return
	}
	const entries = (await readdir(directory)).sort(compareText)
	for (const filename of entries) {
		const relative = `${SPEC}/${name}/${filename}`
		const absolute = join(directory, filename)
		const fileStat = await statOrNull(absolute)
		if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) {
			addIssue(issues, relative, relative, 'invalid_format', 'Storage root must be flat and contain regular files only.')
			continue
		}
		const extension = name === 'scenarios' ? '.feature' : '.md'
		if (!filename.endsWith(extension) || !isUuidV7(filename.slice(0, -extension.length))) {
			addIssue(issues, relative, relative, 'invalid_format', 'Filename must contain a canonical lowercase UUIDv7 and the expected extension.')
			continue
		}
		if (name === 'contracts' || name === 'scenarios') {
			addIssue(issues, relative, relative, 'unsupported', 'This semantic kind is implemented in a later vertical slice.')
			continue
		}
		const filenameId = filename.slice(0, -extension.length)
		const raw = await readFile(absolute, 'utf8')
		const decoded = name === 'features'
			? decodeFeature(relative, raw, filenameId, issues)
			: decodeStory(relative, raw, filenameId, issues)
		if (!decoded)
			continue
		if (ids.has(decoded.value.id)) {
			addIssue(issues, relative, 'id', 'duplicate', 'Semantic ID duplicates an existing workspace unit.')
			continue
		}
		ids.set(decoded.value.id, relative)
		if (name === 'features')
			features.set(decoded.value.id, decoded as Stored<FeatureData>)
		else
			stories.set(decoded.value.id, decoded as Stored<StoryData>)
	}
}

/**
 * Inspect canonical persistence without returning an incomplete semantic graph.
 * All observations and diagnostics are deterministic for a stable working tree.
 */
export async function inspectWorkspace(root: string): Promise<WorkspaceInspection> {
	const issues: ValidationIssue[] = []
	const features = new Map<string, Stored<FeatureData>>()
	const stories = new Map<string, Stored<StoryData>>()
	const ids = new Map<string, string>()
	const stat = await statOrNull(join(root, SPEC))
	if (!stat) {
		addIssue(issues, MANIFEST, MANIFEST, 'missing', 'Spec workspace is not initialized.')
		return { issues }
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		addIssue(issues, SPEC, SPEC, 'invalid_format', 'Spec workspace must be a real directory.')
		return { issues }
	}
	const rootEntries = await readdir(join(root, SPEC))
	for (const name of rootEntries.sort(compareText)) {
		if (name !== 'spec.yaml' && !(STORAGE_ROOTS as readonly string[]).includes(name))
			addIssue(issues, `${SPEC}/${name}`, `${SPEC}/${name}`, 'unsupported', 'Unknown entry in closed-world .spec root.')
	}
	await inspectManifest(root, issues)
	for (const name of STORAGE_ROOTS)
		await scanRoot(root, name, features, stories, ids, issues)
	for (const story of stories.values()) {
		for (const target of story.value.motivates) {
			if (!features.has(target)) {
				addIssue(issues, story.path, 'motivates', 'unresolved', `Story must motivate an existing Feature: ${target}`)
			}
		}
	}
	if (issues.length > 0)
		return { issues: sortedIssues(issues) }
	const nodes: NormalizedNode[] = [
		...[...features.values()].map(({ value, path }) => ({
			id: value.id,
			kind: 'feature' as const,
			title: value.title,
			summary: value.summary,
			source: { path },
		})),
		...[...stories.values()].map(({ value, path }) => ({
			id: value.id,
			kind: 'story' as const,
			title: value.title,
			actor: value.actor,
			goal: value.goal,
			value: value.value,
			source: { path },
		})),
	].sort((left, right) => compareText(left.id, right.id))
	const edges: NormalizedEdge[] = [...stories.values()].flatMap(({ value }) =>
		value.motivates.map(to => ({ from: value.id, type: 'motivates' as const, to })))
		.sort((left, right) => compareText(left.from, right.from) || compareText(left.type, right.type) || compareText(left.to, right.to))
	const ir: NormalizedIr = { formatVersion: 1, nodes, edges }
	const semanticNodes = nodes.map((node) => {
		const copy: Record<string, unknown> = { ...node }
		delete copy.source
		return copy
	})
	const semanticProjection = { workspaceFormatVersion: 1, formatVersion: ir.formatVersion, nodes: semanticNodes, edges }
	const revision = createHash('sha256')
		.update(JSON.stringify(semanticProjection), 'utf8')
		.digest('hex')
	return { issues: [], snapshot: { root, features, stories, ir, revision } }
}

export async function readSnapshot(root: string): Promise<WorkspaceSnapshot> {
	const inspection = await inspectWorkspace(root)
	if (!inspection.snapshot)
		throw validationFailed(inspection.issues)
	return inspection.snapshot
}

export async function validateWorkspace(root: string): Promise<ValidationResult> {
	const inspection = await inspectWorkspace(root)
	return inspection.snapshot
		? { valid: true, revision: inspection.snapshot.revision, issues: [] }
		: { valid: false, issues: inspection.issues }
}

export async function initWorkspace(root: string): Promise<MutationResponse> {
	return withWorkspaceWriteLock(root, async () => {
		if (await statOrNull(join(root, SPEC))) {
			throw invalidRequest([{
				path: SPEC,
				reason: 'conflict',
				message: 'Cannot initialize when a .spec entry already exists.',
			}])
		}
		const temporary = join(root, `.spec-init-${randomUUID()}`)
		await mkdir(temporary)
		try {
			await writeFile(join(temporary, 'spec.yaml'), 'formatVersion: 1\n', { flag: 'wx' })
			if (await statOrNull(join(root, SPEC))) {
				throw invalidRequest([{
					path: SPEC,
					reason: 'conflict',
					message: 'Cannot initialize when a .spec entry already exists.',
				}])
			}
			await rename(temporary, join(root, SPEC))
		}
		finally {
			await rm(temporary, { recursive: true, force: true })
		}
		const snapshot = await readSnapshot(root)
		return {
			revision: snapshot.revision,
			changedNodes: [],
			deletedIds: [],
			changedEdges: { added: [], removed: [] },
		}
	})
}
