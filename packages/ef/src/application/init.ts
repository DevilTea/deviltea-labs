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
 * afterward). Ownership is proven by IDENTITY *and* CONTENT together, never
 * identity alone: a filesystem that recycles a just-freed inode for a
 * brand-new, unrelated directory (observed on Linux ext4 immediately after an
 * `rm -rf` + `mkdir` of the same path) reports the exact same `lstat`
 * `dev`/`ino` pair `claimDirectory` captured, even though the directory
 * instance is entirely different -- an identity-only check is fooled by this
 * ABA exactly like the classic lock-free-algorithm hazard of the same name.
 * `verifyClaimIntact` below therefore also requires every entry currently
 * present in the claimed directory to be one this invocation itself already
 * created; anything else (such as a victim's pre-existing file) proves the
 * directory instance changed regardless of what its identity reports. Cleanup
 * never performs a recursive/force removal: it deletes only the exact paths
 * this invocation tracked as having created, deepest first, via precise
 * `unlink`/non-recursive `rmdir` calls -- `rmdir` succeeds only on a directory
 * that is genuinely empty, so any unexpected content left behind by a swap is
 * never silently discarded; cleanup simply stops at the first such failure
 * and reports `incomplete`. It never re-runs project discovery or validation
 * while the marker exists, and a restarted process that meets a pre-existing
 * `.engineering` (complete or not) leaves it untouched via the same atomic
 * claim rejection.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { PathHistoryResult, RefResolutionResult, WorktreeRootResult } from '../git/repository'
import type { ParsedFrontmatterDocument } from '../parsing/frontmatter'
import type { ExtractedSections, ParseBodyResult } from '../parsing/markdown'
import type { ClaimDirectoryResult } from '../platform/claim-directory'
import type { CreateExclusiveResult, ReadInitMarkerResult } from '../platform/exclusive-file'
import type { FileIdentity } from '../platform/fs-facts'
import type { ProjectSnapshot, SnapshotArtifactFile, SnapshotEntryKind } from './snapshot'
import { mkdir as fsMkdir, readdir as fsReaddir, rmdir as fsRmdir, unlink as fsUnlink } from 'node:fs/promises'
import path from 'pathe'
import { decodeEnvelope } from '../domain/envelope'
import { compareBytewise } from '../domain/model'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { claimDirectory } from '../platform/claim-directory'
import { createExclusive, readInitMarker, writeInitMarker } from '../platform/exclusive-file'
import { directoryIdentity, isDirectory, readFileBytes, sameFileIdentity } from '../platform/fs-facts'
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
		| 'history-incomplete'
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
	if (refResult.kind === 'error') {
		// The ref probe ran but could not conclusively determine whether
		// `integration_ref` exists (distinct from `git-unavailable`, where Git
		// could not even be run). Falling through would treat it as though the
		// ref simply does not exist and let bootstrap proceed by assumption
		// (09-validation.md "An inaccessible ref ... makes the operation
		// incomplete rather than eligible by assumption").
		return {
			ok: false,
			reason: 'history-incomplete',
			message: `'${values.integrationRef}' could not be conclusively resolved: ${refResult.message}`,
		}
	}
	if (refResult.kind === 'resolved') {
		const historyResult = await deps.pathExistsInFirstParentHistory(refResult.oid, '.engineering/ef.yaml')
		if (historyResult.kind === 'git-unavailable')
			return { ok: false, reason: 'git-unavailable', message: historyResult.message }
		if (historyResult.kind === 'shallow') {
			return {
				ok: false,
				reason: 'history-incomplete',
				message: `'${values.integrationRef}' resolves in a shallow repository; its first-parent history cannot be completely inspected for '.engineering/ef.yaml', so absence cannot be established.`,
			}
		}
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
	/**
	 * Remove an EMPTY, non-recursive directory only (plain `rmdir` semantics:
	 * it fails, e.g. with `ENOTEMPTY`, on anything that still has content).
	 * `applyInitPlan` never performs a recursive/force removal -- see
	 * `applyInitPlan`'s own documentation on why a precise, non-recursive
	 * primitive is itself part of the ownership-proof story, not just a detail.
	 */
	rmdir: (path: string) => Promise<void>
	/** Non-recursive directory listing (entry names only), for the content-based half of `verifyClaimIntact` in `applyInitPlan`. */
	readDirectory: (path: string) => Promise<string[]>
	generateNonce: () => string
	/** `lstat`-derived identity of `path` iff it is right now a real, non-symlink directory; `undefined` otherwise. Used to bind every step after the claim to the exact directory instance claimed (see `verifyClaimIntact` in `applyInitPlan`). */
	directoryIdentity: (path: string) => Promise<FileIdentity | undefined>
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
	rmdir: async (target) => {
		await fsRmdir(target)
	},
	readDirectory: async target => fsReaddir(target),
	generateNonce,
	directoryIdentity,
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
 *
 * Exact guarantee (Node exposes no `openat`-style, file-descriptor-relative
 * primitive on any platform this package targets, so every step below is
 * necessarily pathname-based; this is a portability/security-boundary
 * narrowing, not a claim of race-freedom -- see 00's "path handling is not a
 * filesystem-security boundary" and the EF threat model, in which the working
 * tree is the operator's own data, not an adversarial input):
 *
 * - `verifyClaimIntact` binds every step after the claim to the `lstat`
 *   identity (`dev`/`ino`) of `plan.targetRoot` and the claimed
 *   `engineeringPath`, captured immediately after the claim succeeds, and is
 *   re-checked immediately before every subsequent write or read. This
 *   catches a non-racing or slow interference -- moving the claimed
 *   directory outside the project and symlinking the original path back to
 *   it (or substituting any other real directory) strictly BETWEEN two
 *   checkpoints aborts before the guarded step ever runs.
 * - Identity ALONE is not sufficient: a filesystem that recycles a just-freed
 *   inode for a brand-new, unrelated directory (Linux ext4, immediately after
 *   an `rm -rf` + `mkdir` of the claimed path -- the exact shape of a real CI
 *   regression this comment documents) reports the identical `dev`/`ino` pair
 *   `claimedIdentity` captured, even though the directory instance is
 *   entirely different -- an ABA hazard, not a mere timing coincidence.
 *   `verifyClaimIntact` therefore also lists `engineeringPath`'s current
 *   top-level entries and requires every one of them to be an entry this
 *   invocation itself already created; anything else (a victim's pre-existing
 *   file, for instance) proves the directory instance changed no matter what
 *   its identity reports. A same-inode replacement whose content is
 *   genuinely EMPTY is content-indistinguishable from the original claimed
 *   directory at that point in the protocol and causes no data loss either
 *   way, so it is accepted and treated as the same claim.
 * - It does NOT catch a swap that lands strictly INSIDE the narrow window
 *   between one `verifyClaimIntact` check and the single syscall it guards:
 *   in that instant the guarded operation is still pathname-based and can be
 *   directed at whatever the path currently resolves to. This package cannot
 *   close that window without an `openat`-equivalent Node does not expose.
 * - Because of the above, destructive cleanup (`abort` below) is
 *   ownership-proven immediately before any deletion via a fresh
 *   `directoryIdentity` re-check against the identity captured at claim
 *   time (and, once the marker exists, its nonce), and then removes ONLY the
 *   exact paths this invocation itself tracked as having created -- deepest
 *   first, via precise `unlink`/non-recursive `rmdir`, never a recursive or
 *   force removal. `rmdir` succeeds only on a directory that is genuinely
 *   empty, so this is itself part of the ownership proof: if
 *   `engineeringPath` (or anything tracked beneath it) still holds content
 *   this invocation did not itself create -- the inode-ABA case above, or a
 *   swapped-in real directory this invocation never created -- the
 *   corresponding `rmdir` fails and cleanup stops immediately, leaving that
 *   entry and everything at or above it in the deletion order completely
 *   untouched, and still reports `incomplete`. It never deletes state it
 *   cannot prove it owns. Recovery from that state is an explicit operator
 *   action (13-cli-contract.md), matching the "on failure, remove only paths
 *   whose ownership by that invocation is proven" step of the protocol.
 * - The narrowest residual case -- a swap that fully restores the SAME
 *   original directory to the SAME path strictly inside one guarded window --
 *   still acts on the genuine claimed directory either way; the only
 *   possible outcome there is a spurious abort of an otherwise-legitimate
 *   run, never a write to, or deletion of, anything else.
 */
export async function applyInitPlan(plan: InitPlan, deps: ApplyInitPlanDeps = defaultApplyInitPlanDeps): Promise<ApplyInitPlanResult> {
	const engineeringPath = path.join(plan.targetRoot, '.engineering')

	const targetRootIdentity = await deps.directoryIdentity(plan.targetRoot)
	if (targetRootIdentity === undefined)
		return { applied: false, outcome: 'incomplete', message: `'${plan.targetRoot}' could not be verified as a directory.` }

	const claim = await deps.claimDirectory(engineeringPath)
	if (claim.outcome === 'already-exists')
		return { applied: false, outcome: 'raced', message: `'${engineeringPath}' already exists and was not modified.` }
	if (claim.outcome === 'failed')
		return { applied: false, outcome: 'incomplete', message: `Failed to claim '${engineeringPath}': ${claim.error.message}` }
	if (claim.outcome === 'claim-unprovable') {
		// `claimDirectory` itself could not prove, immediately after its own
		// `mkdir` succeeded, that `engineeringPath` still denoted the exact,
		// empty, non-symlink directory it just created (Finding 1: a separate,
		// later observation of `engineeringPath` by this function would itself
		// be a second, independently racable pathname lookup, capable of
		// binding "ownership" to a swapped-in real directory -- or, on an
		// `undefined` observation, driving destructive cleanup of whatever now
		// occupies the path). Ownership was never established here, so nothing
		// this invocation created can be identified: fail closed without any
		// destructive cleanup, exactly like any other failed claim.
		return { applied: false, outcome: 'incomplete', message: claim.message }
	}

	// Ownership of `engineeringPath` is proven by `claimDirectory` itself,
	// which established it via its own immediate post-`mkdir` observation --
	// but only of the exact directory instance that claim created, not of
	// whatever later resolves to this path. Once the marker is written,
	// cleanup must also compare its nonce before removing anything
	// (13-cli-contract.md).
	const claimedIdentity = claim.identity

	/**
	 * Every path this invocation has itself created so far, in creation
	 * order, `engineeringPath` first -- the sole basis for both halves of the
	 * ownership proof: the content check in `verifyClaimIntact` (via
	 * `createdTopLevelNames`) and `abort`'s precise, non-recursive cleanup.
	 */
	const createdStack: { path: string, kind: 'file' | 'directory' }[] = [
		{ path: engineeringPath, kind: 'directory' },
	]
	/** Names of `engineeringPath`'s own direct children created by this invocation so far (see `verifyClaimIntact`). */
	const createdTopLevelNames = new Set<string>()

	/**
	 * The single path segment of `canonicalRelativePath` immediately below
	 * `.engineering` -- every planned directory and file
	 * (`CANONICAL_DIRECTORIES`, `InitPlan.files`) is exactly one level
	 * beneath it, so this is also the exact entry name `readDirectory`
	 * reports for it once created.
	 */
	function topLevelChildName(canonicalRelativePath: string): string {
		return path.relative('.engineering', canonicalRelativePath)
			.split('/')[0]!
	}

	/**
	 * `true` iff `plan.targetRoot` and `engineeringPath` are both still real,
	 * non-symlink directories with the identical identity captured above, AND
	 * every entry `engineeringPath` currently contains is one this invocation
	 * itself already created. The identity check alone is insufficient: see
	 * `applyInitPlan`'s own documentation on the inode-ABA hazard this content
	 * check exists to close. See also the residual-risk note on
	 * `applyInitPlan` itself for what neither check can catch.
	 */
	async function verifyClaimIntact(): Promise<boolean> {
		const currentRoot = await deps.directoryIdentity(plan.targetRoot)
		if (currentRoot === undefined || !sameFileIdentity(currentRoot, targetRootIdentity!))
			return false
		const currentClaim = await deps.directoryIdentity(engineeringPath)
		if (currentClaim === undefined || !sameFileIdentity(currentClaim, claimedIdentity!))
			return false

		let currentEntries: string[]
		try {
			currentEntries = await deps.readDirectory(engineeringPath)
		}
		catch {
			return false
		}
		return currentEntries.every(name => createdTopLevelNames.has(name))
	}

	const claimIntactFailureMessage = `'${engineeringPath}' no longer denotes the directory this invocation claimed.`

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

		// Ownership of `engineeringPath` must be re-proven immediately before
		// any destructive step, independently of whichever earlier
		// `verifyClaimIntact` call led here: by the time `abort` runs,
		// `engineeringPath` may already denote a completely different real
		// directory this invocation never claimed (a directory swapped in from
		// inside the very write step that triggered this abort, not merely
		// between two checkpoints). Nothing here may delete state it cannot
		// prove it owns (13-cli-contract.md step 8: "remove only paths whose
		// ownership by that invocation is proven"). A fresh `lstat`: only a
		// non-symlink directory whose identity is still the EXACT one captured
		// immediately after the claim succeeded is provably still this
		// invocation's claim; anything else -- a symlink, a different real
		// directory, or anything that stopped being a directory at all -- is
		// left completely untouched and reported `incomplete` instead, per this
		// function's own residual-risk documentation on `applyInitPlan`.
		const currentIdentity = await deps.directoryIdentity(engineeringPath)
		if (currentIdentity === undefined || !sameFileIdentity(currentIdentity, claimedIdentity!))
			return { applied: false, outcome: 'incomplete', message }

		// Remove only the exact paths tracked in `createdStack`, deepest first
		// (`engineeringPath` itself last), via precise `unlink` / non-recursive
		// `rmdir` -- never a recursive or force removal. `rmdir` succeeds only
		// on a directory that is genuinely empty: if `engineeringPath` (or
		// anything tracked beneath it) still holds content this invocation did
		// not itself create -- an inode-ABA replacement (see `applyInitPlan`'s
		// documentation) or a swapped-in real directory -- the corresponding
		// `rmdir` fails and this loop stops immediately, leaving that entry and
		// everything at or above it in this order completely untouched. No
		// unexpected content is ever silently discarded.
		for (let i = createdStack.length - 1; i >= 0; i--) {
			const entry = createdStack[i]!
			try {
				if (entry.kind === 'file')
					await deps.unlink(entry.path)
				else
					await deps.rmdir(entry.path)
			}
			catch {
				return { applied: false, outcome: 'incomplete', message }
			}
		}

		return { applied: false, outcome: 'incomplete', message }
	}

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

	try {
		await deps.mkdir(tmpPath)
	}
	catch (error) {
		return abort(`Failed to create '${tmpPath}': ${(error as Error).message}`)
	}
	createdStack.push({ path: tmpPath, kind: 'directory' })
	createdTopLevelNames.add('.tmp')

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

	const markerResult = await deps.writeInitMarker(markerPath, nonce)
	if (markerResult.outcome !== 'created')
		return abort(`Failed to create the initialization marker at '${markerPath}'.`)
	markerCreated = true
	createdStack.push({ path: markerPath, kind: 'file' })

	for (const dir of plan.directories) {
		if (!(await verifyClaimIntact()))
			return abort(claimIntactFailureMessage)
		try {
			await deps.mkdir(path.join(plan.targetRoot, dir))
		}
		catch (error) {
			return abort(`Failed to create directory '${dir}': ${(error as Error).message}`)
		}
		createdStack.push({ path: path.join(plan.targetRoot, dir), kind: 'directory' })
		createdTopLevelNames.add(topLevelChildName(dir))
	}

	for (const file of plan.files) {
		if (!(await verifyClaimIntact()))
			return abort(claimIntactFailureMessage)
		const result = await deps.createExclusive(path.join(plan.targetRoot, file.path), file.bytes)
		if (result.outcome !== 'created')
			return abort(`Failed to write '${file.path}'.`)
		createdStack.push({ path: path.join(plan.targetRoot, file.path), kind: 'file' })
		createdTopLevelNames.add(topLevelChildName(file.path))
	}

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

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

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

	const finalMarker = await deps.readInitMarker(markerPath)
	if (finalMarker.outcome !== 'found' || finalMarker.marker.nonce !== nonce)
		return abort('The initialization marker no longer contains the invocation\'s nonce.')

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

	await deps.unlink(markerPath)

	if (!(await verifyClaimIntact())) {
		// The claim was swapped out from under us in the narrow window between
		// the marker removal above and this final check. The marker -- this
		// invocation's sole ownership proof once the claim itself is no longer
		// verifiable -- is already gone, so cleanup cannot safely remove
		// anything further here; report incomplete rather than misreport a
		// successful application (13-cli-contract.md "the implementation MUST
		// NOT misreport the published state as unapplied" applies symmetrically
		// in the other direction: it also must not misreport an unproven state
		// as applied).
		return { applied: false, outcome: 'incomplete', message: claimIntactFailureMessage }
	}

	return { applied: true, outcome: 'applied', changes: plan.changes }
}
