/**
 * `ef init` plan/apply (13-cli-contract.md "Project Initialization",
 * "Filesystem Write Safety" / "Initialization claim-and-complete protocol";
 * 11-filesystem-and-config.md canonical layout, configuration schema, and
 * bootstrap-ref rules; 02-identity.md PROJECT singleton and atomic bootstrap;
 * 08-artifact-schemas.md PROJECT body schema; 12-input-normalization.md
 * Terminology bootstrap rules).
 *
 * `computeInitPlan` is pure aside from the two read-only Git checks it needs
 * (worktree-root identity and the configured integration branch's
 * first-parent history): it validates input values, builds the complete
 * planned `.engineering` content in memory, and validates that candidate by
 * running `validateSnapshot` (./snapshot-validation) over a synthetic
 * in-memory `ProjectSnapshot` containing exactly the planned PROJECT
 * Artifact -- an invalid plan never reaches `applyInitPlan`.
 *
 * `applyInitPlan` performs the exact eight-step claim-and-complete protocol:
 * atomically claim `.engineering`, create `.tmp` and the nonce-bearing
 * marker, materialize every planned file and directory, verify faithful
 * materialization and marker survival, remove the marker only on success,
 * and on any failure remove only paths whose ownership by this invocation is
 * proven (the exclusive claim before the marker exists; the matching nonce
 * afterward). It never re-runs project discovery or validation while the
 * marker exists, and a restarted process that meets a pre-existing
 * `.engineering` (complete or not) leaves it untouched via the same atomic
 * claim rejection.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { PathHistoryResult, RefResolutionResult, WorktreeRootResult } from '../git/repository'
import type { ParsedFrontmatterDocument } from '../parsing/frontmatter'
import type { ExtractedSections, ParseBodyResult } from '../parsing/markdown'
import type { ClaimDirectoryResult } from '../platform/claim-directory'
import type { CreateExclusiveResult, ReadInitMarkerResult } from '../platform/exclusive-file'
import type { ProjectSnapshot, SnapshotArtifactFile, SnapshotEntryKind } from './snapshot'
import { mkdir as fsMkdir, rm as fsRm, unlink as fsUnlink } from 'node:fs/promises'
import path from 'pathe'
import { decodeEnvelope } from '../domain/envelope'
import { compareBytewise } from '../domain/model'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { claimDirectory } from '../platform/claim-directory'
import { createExclusive, readInitMarker, writeInitMarker } from '../platform/exclusive-file'
import { isDirectory, readFileBytes } from '../platform/fs-facts'
import { generateNonce } from '../platform/nonce'
import { isSameLocation } from '../platform/path-identity'
import { decodeConfig, isValidIntegrationRef } from '../repository/config'
import { validateSnapshot } from './snapshot-validation'

// ---------------------------------------------------------------------------
// Fixed bootstrap content
// ---------------------------------------------------------------------------

const CANONICAL_DIRECTORIES: readonly string[] = [
	'.engineering/prd',
	'.engineering/req',
	'.engineering/adr',
	'.engineering/pol',
	'.engineering/chg',
	'.engineering/resources',
].slice()
	.sort(compareBytewise)

const GITIGNORE_TEXT = '.cache/\n.generated/\n.tmp/\n.lock\n'

const DEFAULT_TERMINOLOGY_TABLE = '| Term | Definition | Avoid or aliases |\n|---|---|---|\n'

// ---------------------------------------------------------------------------
// computeInitPlan
// ---------------------------------------------------------------------------

export interface InitValues {
	title: string
	summary: string
	vision: string
	projectScope: string
	nonGoals: string
	context: string
	/** Full local branch ref, e.g. `refs/heads/main` (immutable once bootstrapped). */
	integrationRef: string
	/** Raw canonical Terminology table markdown; omit for the canonical header-only table. */
	terminology?: string
}

export interface ComputeInitPlanInput {
	/** Absolute path; must be exactly an existing Git worktree root. */
	targetRoot: string
	values: InitValues
}

export interface InitPlanFile {
	/** Project-relative canonical path, `/` separators. */
	path: string
	bytes: Uint8Array
}

export interface InitPlanChange {
	action: 'create'
	path: string
}

export interface InitPlan {
	targetRoot: string
	integrationRef: string
	/** Bytewise sorted by path. */
	files: InitPlanFile[]
	/** Project-relative canonical directories, bytewise sorted. */
	directories: string[]
	/** Files and directories together, bytewise sorted by path (13-cli-contract.md "Changes are sorted by canonical path"). */
	changes: InitPlanChange[]
}

export type ComputeInitPlanFailureReason
	= | 'missing-value'
		| 'invalid-integration-ref'
		| 'not-a-worktree-root'
		| 'git-unavailable'
		| 'history-contains-ef-state'
		| 'invalid-plan'

export interface ComputeInitPlanFailure {
	ok: false
	reason: ComputeInitPlanFailureReason
	message: string
	diagnostics?: Diagnostic[]
}

export interface ComputeInitPlanSuccess {
	ok: true
	plan: InitPlan
}

export type ComputeInitPlanResult = ComputeInitPlanSuccess | ComputeInitPlanFailure

export interface ComputeInitPlanDeps {
	findWorktreeRoot: (path: string) => Promise<WorktreeRootResult>
	resolveRef: (fullRef: string) => Promise<RefResolutionResult>
	pathExistsInFirstParentHistory: (startOid: string, path: string) => Promise<PathHistoryResult>
}

function yamlDoubleQuoted(value: string): string {
	return JSON.stringify(value)
}

function buildConfigYaml(integrationRef: string): string {
	return [
		'schema: ef/config@1',
		'repository:',
		`  integration_ref: ${integrationRef}`,
		'linked_repositories: []',
		'schemas:',
		'  artifact_write_major: 1',
		'',
	].join('\n')
}

function buildProjectFrontmatter(title: string, summary: string): string {
	return [
		'---',
		'schema: ef/project@1',
		'type: project',
		'id: PROJECT',
		`title: ${yamlDoubleQuoted(title)}`,
		'status: active',
		`summary: ${yamlDoubleQuoted(summary)}`,
		'tags: []',
		'relations: []',
		'resources: []',
		'---',
		'',
	].join('\n')
}

function buildProjectBody(values: InitValues, terminologyContent: string): string {
	const sections: { name: string, content: string }[] = [
		{ name: 'Vision', content: values.vision },
		{ name: 'Scope', content: values.projectScope },
		{ name: 'Non-goals', content: values.nonGoals },
		{ name: 'Context', content: values.context },
		{ name: 'Terminology', content: terminologyContent },
	]
	return sections.map(section => `## ${section.name}\n\n${section.content.trim()}\n`)
		.join('\n')
}

/** Parse already-built Artifact bytes through the same pipeline `snapshot.ts` uses, without depending on its unexported helper. */
function parseArtifactBytes(bytes: Uint8Array, filePath: string): SnapshotArtifactFile {
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(bytes)
	const frontmatter = splitFrontmatter(text)

	if (!frontmatter.ok)
		return { path: filePath, bytes, text, frontmatter, document: undefined, envelope: undefined, body: undefined, sections: undefined }

	const document: ParsedFrontmatterDocument = parseFrontmatterDocument(frontmatter.frontmatterText, filePath, { startLine: 2 })
	const envelope = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, filePath)
	const body: ParseBodyResult = parseBody(frontmatter.bodyText, frontmatter.bodyStartLine - 1)
	const sections: ExtractedSections | undefined = body.ok ? extractSections(body.root) : undefined

	return { path: filePath, bytes, text, frontmatter, document, envelope, body, sections }
}

function isBlank(value: string): boolean {
	return value.trim().length === 0
}

function missingValueFailure(field: string): ComputeInitPlanFailure {
	return { ok: false, reason: 'missing-value', message: `'${field}' must be a non-empty value.` }
}

/**
 * Compute the complete `ef init` bootstrap plan in memory. Never touches the
 * filesystem; the only I/O is the two read-only Git checks (worktree-root
 * identity and the configured integration branch's first-parent history).
 */
export async function computeInitPlan(input: ComputeInitPlanInput, deps: ComputeInitPlanDeps): Promise<ComputeInitPlanResult> {
	const { targetRoot, values } = input

	const requiredTextFields: [string, string][] = [
		['title', values.title],
		['summary', values.summary],
		['vision', values.vision],
		['project-scope', values.projectScope],
		['non-goals', values.nonGoals],
		['context', values.context],
		['integration-ref', values.integrationRef],
	]
	for (const [field, value] of requiredTextFields) {
		if (isBlank(value))
			return missingValueFailure(field)
	}
	if (/[\r\n]/.test(values.title.trim()))
		return { ok: false, reason: 'missing-value', message: '\'title\' must be a single line.' }

	if (!isValidIntegrationRef(values.integrationRef)) {
		return {
			ok: false,
			reason: 'invalid-integration-ref',
			message: `'${values.integrationRef}' is not a syntactically valid full local branch ref of the form 'refs/heads/<branch-name>'.`,
		}
	}

	const worktree = await deps.findWorktreeRoot(targetRoot)
	if (worktree.kind === 'git-unavailable')
		return { ok: false, reason: 'git-unavailable', message: worktree.message }
	if (worktree.kind === 'not-a-worktree' || !isSameLocation(worktree.root, targetRoot)) {
		return {
			ok: false,
			reason: 'not-a-worktree-root',
			message: `'${targetRoot}' is not exactly an existing Git worktree root.`,
		}
	}

	const refResult = await deps.resolveRef(values.integrationRef)
	if (refResult.kind === 'git-unavailable')
		return { ok: false, reason: 'git-unavailable', message: refResult.message }
	if (refResult.kind === 'resolved') {
		const historyResult = await deps.pathExistsInFirstParentHistory(refResult.oid, '.engineering/ef.yaml')
		if (historyResult.kind === 'git-unavailable')
			return { ok: false, reason: 'git-unavailable', message: historyResult.message }
		if (historyResult.kind === 'found') {
			return {
				ok: false,
				reason: 'history-contains-ef-state',
				message: `'${values.integrationRef}' already contains '.engineering/ef.yaml' in its first-parent history at ${historyResult.commitOid}.`,
			}
		}
	}

	const title = values.title.trim()
	const summary = values.summary.trim()
	const terminologyContent = values.terminology !== undefined && !isBlank(values.terminology)
		? values.terminology.trim()
		: DEFAULT_TERMINOLOGY_TABLE.trimEnd()

	const configText = buildConfigYaml(values.integrationRef)
	const projectText = buildProjectFrontmatter(title, summary) + buildProjectBody(values, terminologyContent)

	const configBytes = new TextEncoder()
		.encode(configText)
	const gitignoreBytes = new TextEncoder()
		.encode(GITIGNORE_TEXT)
	const projectBytes = new TextEncoder()
		.encode(projectText)

	const files: InitPlanFile[] = [
		{ path: '.engineering/ef.yaml', bytes: configBytes },
		{ path: '.engineering/.gitignore', bytes: gitignoreBytes },
		{ path: '.engineering/PROJECT.md', bytes: projectBytes },
	].sort((a, b) => compareBytewise(a.path, b.path))

	const entryKinds = new Map<string, SnapshotEntryKind>([
		['.engineering', 'directory'],
		['.engineering/ef.yaml', 'file'],
		['.engineering/.gitignore', 'file'],
		['.engineering/PROJECT.md', 'file'],
		...CANONICAL_DIRECTORIES.map(dir => [dir, 'directory'] as const),
	])

	const syntheticSnapshot: ProjectSnapshot = {
		source: { kind: 'working-tree', projectRoot: targetRoot },
		configBytes,
		config: decodeConfig(configText, '.engineering/ef.yaml'),
		gitignoreBytes,
		artifacts: [parseArtifactBytes(projectBytes, '.engineering/PROJECT.md')],
		resourceFiles: [],
		entryKinds,
		layoutDiagnostics: [],
	}

	const validation = validateSnapshot(syntheticSnapshot)
	const errorDiagnostics = validation.diagnostics.filter(d => d.severity === 'error')
	if (errorDiagnostics.length > 0) {
		return {
			ok: false,
			reason: 'invalid-plan',
			message: 'The computed bootstrap content candidate failed validation.',
			diagnostics: validation.diagnostics,
		}
	}

	const changes: InitPlanChange[] = [...files.map(f => ({ action: 'create' as const, path: f.path })), ...CANONICAL_DIRECTORIES.map(dir => ({ action: 'create' as const, path: dir }))]
		.sort((a, b) => compareBytewise(a.path, b.path))

	return {
		ok: true,
		plan: {
			targetRoot,
			integrationRef: values.integrationRef,
			files,
			directories: CANONICAL_DIRECTORIES.slice(),
			changes,
		},
	}
}

// ---------------------------------------------------------------------------
// applyInitPlan
// ---------------------------------------------------------------------------

export interface ApplyInitPlanDeps {
	claimDirectory: (path: string) => Promise<ClaimDirectoryResult>
	mkdir: (path: string) => Promise<void>
	createExclusive: (path: string, bytes: Uint8Array) => Promise<CreateExclusiveResult>
	writeInitMarker: (path: string, nonce: string) => Promise<CreateExclusiveResult>
	readInitMarker: (path: string) => Promise<ReadInitMarkerResult>
	readFileBytes: (path: string) => Promise<Uint8Array>
	isDirectory: (path: string) => Promise<boolean>
	unlink: (path: string) => Promise<void>
	removeTree: (path: string) => Promise<void>
	generateNonce: () => string
}

/** Real filesystem access, composed from `platform/*` primitives. */
export const defaultApplyInitPlanDeps: ApplyInitPlanDeps = {
	claimDirectory,
	mkdir: async (target) => {
		await fsMkdir(target)
	},
	createExclusive,
	writeInitMarker,
	readInitMarker,
	readFileBytes,
	isDirectory,
	unlink: async (target) => {
		await fsUnlink(target)
	},
	removeTree: async (target) => {
		await fsRm(target, { recursive: true, force: true })
	},
	generateNonce,
}

export type ApplyInitPlanResult
	= | { applied: true, outcome: 'applied', changes: InitPlanChange[] }
		| { applied: false, outcome: 'raced', message: string }
		| { applied: false, outcome: 'incomplete', message: string }

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length)
		return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i])
			return false
	}
	return true
}

/**
 * Perform the exact 13-cli-contract.md "Initialization claim-and-complete
 * protocol" for an already-validated `plan`. Never re-validates the plan's
 * content and never runs project discovery while the marker exists.
 */
export async function applyInitPlan(plan: InitPlan, deps: ApplyInitPlanDeps = defaultApplyInitPlanDeps): Promise<ApplyInitPlanResult> {
	const engineeringPath = path.join(plan.targetRoot, '.engineering')

	const claim = await deps.claimDirectory(engineeringPath)
	if (claim.outcome === 'already-exists')
		return { applied: false, outcome: 'raced', message: `'${engineeringPath}' already exists and was not modified.` }
	if (claim.outcome === 'failed')
		return { applied: false, outcome: 'incomplete', message: `Failed to claim '${engineeringPath}': ${claim.error.message}` }

	// From here on, ownership of `engineeringPath` is proven by the successful
	// exclusive claim above; once the marker is written, cleanup must also
	// compare its nonce before removing anything (13-cli-contract.md).
	const nonce = deps.generateNonce()
	const tmpPath = path.join(engineeringPath, '.tmp')
	const markerPath = path.join(tmpPath, 'init-state.json')
	let markerCreated = false

	async function abort(message: string): Promise<ApplyInitPlanResult> {
		if (markerCreated) {
			const read = await deps.readInitMarker(markerPath)
			if (read.outcome !== 'found' || read.marker.nonce !== nonce)
				return { applied: false, outcome: 'incomplete', message }
		}
		await deps.removeTree(engineeringPath)
		return { applied: false, outcome: 'incomplete', message }
	}

	try {
		await deps.mkdir(tmpPath)
	}
	catch (error) {
		return abort(`Failed to create '${tmpPath}': ${(error as Error).message}`)
	}

	const markerResult = await deps.writeInitMarker(markerPath, nonce)
	if (markerResult.outcome !== 'created')
		return abort(`Failed to create the initialization marker at '${markerPath}'.`)
	markerCreated = true

	for (const dir of plan.directories) {
		try {
			await deps.mkdir(path.join(plan.targetRoot, dir))
		}
		catch (error) {
			return abort(`Failed to create directory '${dir}': ${(error as Error).message}`)
		}
	}

	for (const file of plan.files) {
		const result = await deps.createExclusive(path.join(plan.targetRoot, file.path), file.bytes)
		if (result.outcome !== 'created')
			return abort(`Failed to write '${file.path}'.`)
	}

	for (const dir of plan.directories) {
		if (!(await deps.isDirectory(path.join(plan.targetRoot, dir))))
			return abort(`Directory '${dir}' was not materialized.`)
	}

	for (const file of plan.files) {
		let bytes: Uint8Array
		try {
			bytes = await deps.readFileBytes(path.join(plan.targetRoot, file.path))
		}
		catch (error) {
			return abort(`Failed to verify '${file.path}': ${(error as Error).message}`)
		}
		if (!bytesEqual(bytes, file.bytes))
			return abort(`File '${file.path}' was not materialized with the planned bytes.`)
	}

	const finalMarker = await deps.readInitMarker(markerPath)
	if (finalMarker.outcome !== 'found' || finalMarker.marker.nonce !== nonce)
		return abort('The initialization marker no longer contains the invocation\'s nonce.')

	await deps.unlink(markerPath)

	return { applied: true, outcome: 'applied', changes: plan.changes }
}
