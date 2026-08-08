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
 * `verifyClaimIntact` below therefore requires an EXACT witness, not merely a
 * one-directional "nothing unexpected is present" check: the claimed
 * directory's current top-level entries must be set-EQUAL to the names this
 * invocation has itself created so far (present-but-unexpected AND
 * already-created-but-now-missing are both a failure), and every path this
 * invocation has tracked as created -- at any depth, each with the `lstat`
 * identity captured immediately after ITS OWN creation -- must still denote
 * that exact entry. A one-directional check alone is fooled by a
 * same-claimed-identity replacement directory that contains only a strict
 * subset of the expected names (e.g. nothing but a copied-nonce marker):
 * every name present is indeed one this invocation created, yet everything
 * else it created has silently vanished. Cleanup never performs a
 * recursive/force removal: it deletes only the exact paths this invocation
 * tracked as having created, deepest first, via precise `unlink`/non-recursive
 * `rmdir` calls, and -- immediately before each individual deletion -- re-proves
 * that specific entry's ownership against what was captured at its own
 * creation, not merely the claimed directory's own identity; a same-name,
 * different-identity foreign substitution at one already-tracked path would
 * otherwise be deleted by a blind unlink/rmdir-by-path, since neither
 * primitive can tell whether the path's current content is the one this
 * invocation actually created there. For a FILE entry specifically, that
 * per-entry ownership proof is IDENTITY *and* BYTE-CONTENT together, never
 * identity alone, for exactly the same ABA reason as `engineeringPath` itself
 * but one level down: a filesystem that recycles a just-freed inode for a
 * brand-new, unrelated file (Linux ext4, immediately after an `unlink` +
 * `writeFile` of the same path -- the exact shape of the CI regression that
 * motivated this content check) reports the identical `dev`/`ino` pair
 * captured at that file's own creation even though its content is now
 * entirely foreign; an identity-only per-entry check is fooled by this
 * inode-ABA exactly like a bare directory-identity check would be fooled at
 * the claim level. A directory entry needs no separate content proof:
 * non-recursive `rmdir` succeeds only on a directory that is genuinely empty,
 * so any unexpected content left behind by a swap is never silently discarded
 * either way; cleanup simply stops at the first such failure and reports
 * `incomplete`. It never re-runs project discovery or validation while the
 * marker exists, and a restarted process that meets a pre-existing
 * `.engineering` (complete or not) leaves it untouched via the same atomic
 * claim rejection.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { PathHistoryResult, RefResolutionResult, WorktreeRootResult } from '../git/repository'
import type { ParsedFrontmatterDocument } from '../parsing/frontmatter'
import type { ExtractedSections, ParseBodyResult } from '../parsing/markdown'
import type { ClaimDirectoryResult } from '../platform/claim-directory'
import type { CreateExclusiveResult, LeaseReleaseResult, OwnedFileLease, ReadInitMarkerResult } from '../platform/exclusive-file'
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
import { directoryIdentity, isDirectory, readFileBytes, regularFileIdentity, sameFileIdentity } from '../platform/fs-facts'
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
	/**
	 * `lstat`-derived identity of `path` iff it is right now a real, non-symlink
	 * directory; `undefined` otherwise. Used both to RE-VERIFY every step
	 * after the claim against the exact directory instance claimed
	 * (`verifyClaimIntact`, `abort`) and, for a directory this invocation
	 * itself just created via `mkdir`, to ESTABLISH that directory's own
	 * ownership witness (`establishFreshDirectoryIdentity`) -- `mkdir` returns
	 * no handle, so unlike a file created via `createExclusive` there is no
	 * handle-bound alternative available; `establishFreshDirectoryIdentity`
	 * additionally requires the directory to be observed EMPTY immediately
	 * afterward (the strongest reachable substitute, identical to
	 * `platform/claim-directory.ts`'s own post-`mkdir` proof), since a
	 * directory this invocation alone just created is necessarily empty at
	 * that instant.
	 */
	directoryIdentity: (path: string) => Promise<FileIdentity | undefined>
	/**
	 * `lstat`-derived identity of `path` iff it is right now a real, non-symlink
	 * regular file; `undefined` otherwise. Used ONLY for RE-VERIFYING an
	 * identity already established elsewhere against a fresh pathname
	 * observation (`verifyClaimIntact`'s and `abort`'s per-entry
	 * `entryOwnershipProven` recheck) -- never for ESTABLISHING a new
	 * ownership identity in the first place. Every planned FILE's, and the
	 * marker's, own identity is established exclusively from
	 * `createExclusive`'s / `writeInitMarker`'s handle-bound return value (see
	 * `platform/exclusive-file.ts`'s own Finding P0), not from a call to this
	 * function.
	 */
	regularFileIdentity: (path: string) => Promise<FileIdentity | undefined>
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
	regularFileIdentity,
}

export type ApplyInitPlanResult
	= | { applied: true, outcome: 'applied', changes: InitPlanChange[] }
		/**
		 * Initialization genuinely, fully completed -- `applyInitPlanCore`
		 * already verified the claim was never swapped out and removed the
		 * initialization marker under the exact same ownership-proof standard
		 * as every other deletion -- but releasing a tracked file's lease
		 * (the marker's own, or a planned file's) immediately afterward failed
		 * (Finding 1, seventeenth round, matching
		 * `ApplyCreatePlanResult`'s own `cleanup-failed` variant). `applied:
		 * true` because publication itself genuinely, physically occurred;
		 * `outcome: 'cleanup-failed'` because a later, POST-completion
		 * internal operation -- accounting for this invocation's own file
		 * handles -- did not. 13-cli-contract.md: "If publication succeeds
		 * but a later cleanup or internal operation fails, ... `complete:
		 * false`, `applied: true`, and exit `3`; the implementation MUST NOT
		 * misreport the published state as unapplied." Distinct from the
		 * `outcome: 'incomplete'` variant below, which reports a claim that
		 * was never proven to have completed in the first place -- never a
		 * completed one whose only failure was in cleaning up afterward.
		 */
		| { applied: true, outcome: 'cleanup-failed', changes: InitPlanChange[], message: string }
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
 * Establish the ownership witness for a directory THIS INVOCATION itself just
 * created via a non-recursive `mkdir` (`tmpPath`, and each of
 * `plan.directories`) -- the directory counterpart of a FILE's handle-bound
 * `createExclusive` identity. `mkdir` returns no handle, so unlike a file
 * there is no way to bind this observation to the exact creating syscall the
 * way `readBackThroughHandle`/`handle.stat()` bind a file's; the strongest
 * reachable substitute (identical to `platform/claim-directory.ts`'s own
 * post-`mkdir` proof) is an immediate `lstat`-based observation that ALSO
 * requires the directory to be EMPTY, not merely "is a non-symlink
 * directory": a directory this invocation alone just created is necessarily
 * empty at that instant, so requiring emptiness rules out a same-instant
 * swap for a real, pre-populated foreign directory of the identical name --
 * a pattern `directoryIdentity` alone, without the emptiness check, cannot
 * detect. `undefined` when `dirPath` cannot be proven, right now, to be both
 * a non-symlink directory AND empty.
 */
async function establishFreshDirectoryIdentity(deps: ApplyInitPlanDeps, dirPath: string): Promise<FileIdentity | undefined> {
	const identity = await deps.directoryIdentity(dirPath)
	if (identity === undefined)
		return undefined
	let entries: string[]
	try {
		entries = await deps.readDirectory(dirPath)
	}
	catch {
		return undefined
	}
	if (entries.length > 0)
		return undefined
	return identity
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
 *   `verifyClaimIntact` therefore also requires an EXACT witness, not merely a
 *   one-directional "nothing unexpected is present" check: `engineeringPath`'s
 *   current top-level entries must be SET-EQUAL (both directions) to the
 *   names this invocation has itself created so far, AND every path tracked
 *   as created so far (at any depth, not only top-level names) must still
 *   denote, by a fresh per-entry `lstat` identity re-check, the EXACT entry
 *   this invocation created there. (This ongoing, every-checkpoint re-check
 *   is deliberately identity-only, for every entry kind including files; see
 *   the "Because of the above" bullet below for the ADDITIONAL byte-content
 *   proof required of a FILE entry, but only once, immediately before `abort`
 *   actually deletes it -- not on every intermediate checkpoint.) A
 *   one-directional "every present name is
 *   allowed" check is fooled by a same-claimed-identity replacement directory
 *   that contains only a SUBSET of the expected names (e.g. a directory
 *   holding nothing but a copied-nonce `.tmp/init-state.json`): every present
 *   name is indeed one this invocation created, yet everything else this
 *   invocation created has silently vanished. Requiring set equality, plus a
 *   fresh identity check of every individually tracked entry, closes both
 *   directions: entries that vanished (undercounted at the top level, or
 *   individually missing at any depth) and entries replaced in place by a
 *   same-name, different-identity substitution are both detected. A
 *   same-inode replacement whose content is genuinely EMPTY and whose tracked
 *   descendants (there are none yet) all still match is
 *   content-indistinguishable from the original claimed directory at that
 *   point in the protocol and causes no data loss either way, so it is
 *   accepted and treated as the same claim.
 * - It does NOT catch a swap that lands strictly INSIDE the narrow window
 *   between one `verifyClaimIntact` check and the single syscall it guards:
 *   in that instant the guarded operation is still pathname-based and can be
 *   directed at whatever the path currently resolves to. This package cannot
 *   close that window without an `openat`-equivalent Node does not expose.
 * - Because of the above, destructive cleanup (`abort` below) is
 *   ownership-proven immediately before any deletion: a fresh
 *   `directoryIdentity` re-check of `engineeringPath` itself against the
 *   identity captured at claim time (and, once the marker exists, its nonce
 *   AND its full raw bytes -- see the marker paragraph below), AND -- per
 *   entry, immediately before that specific entry is removed -- a fresh
 *   ownership re-check against what was captured when THIS invocation created
 *   that exact entry: `lstat` identity for every entry, AND, for a FILE entry
 *   specifically, byte-for-byte content equality against the exact bytes this
 *   invocation itself wrote there. Re-proving `engineeringPath`'s own identity
 *   alone is not enough: it says nothing about whether some individual
 *   tracked path beneath it was itself swapped for a same-name,
 *   different-identity foreign entry, which a blind `unlink`/`rmdir`-by-path
 *   would otherwise delete without ever noticing the substitution. Per-entry
 *   IDENTITY alone is, in turn, not enough for a FILE: the same inode-ABA
 *   hazard described above for `engineeringPath` recurs one level down --
 *   Linux ext4 recycling a just-freed inode for a brand-new file after an
 *   `unlink` + `writeFile` of the identical tracked path reports the exact
 *   same `dev`/`ino` this invocation captured at that file's own creation,
 *   even though the file now holds entirely foreign content (the concrete CI
 *   regression this content check was added to close). The byte-equality
 *   check is independent of, and does not rely on, the identity check ever
 *   failing: a foreign file substituted under a forced/stubbed identity match
 *   is still caught, because its content practically never happens to equal
 *   the exact bytes this invocation itself wrote. A directory entry needs no
 *   separate content check: cleanup removes ONLY the exact paths this
 *   invocation itself tracked as having created AND still provably owns --
 *   deepest first, via precise `unlink`/non-recursive `rmdir`, never a
 *   recursive or force removal. `rmdir` succeeds only on a directory that is
 *   genuinely empty, so this is itself part of a directory's ownership proof:
 *   if `engineeringPath` (or any tracked directory beneath it) still holds
 *   content this invocation did not itself create -- the inode-ABA case
 *   above, or a swapped-in real directory this invocation never created --
 *   the corresponding `rmdir` fails and cleanup stops immediately, leaving
 *   that entry and everything at or above it in the deletion order completely
 *   untouched, and still reports `incomplete`. Any mismatch at any of these
 *   checks -- identity, byte content, or an outright read failure -- is
 *   treated identically: cleanup stops immediately, leaving that entry and
 *   everything above it in the deletion order untouched, and reports
 *   `incomplete`. It never deletes state it cannot prove it owns. Recovery
 *   from that state is an explicit operator action (13-cli-contract.md),
 *   matching the "on failure, remove only paths whose ownership by that
 *   invocation is proven" step of the protocol.
 * - The marker itself gets the same treatment one level up: `abort` requires
 *   not merely that the marker's parsed `nonce` field match (a foreign marker
 *   sharing that one field's value, amid otherwise different bytes, would
 *   still pass a field-level check alone) but that its ENTIRE raw content is
 *   byte-for-byte identical to what this invocation's own `writeInitMarker`
 *   produced, captured immediately after that call succeeded -- the same
 *   identity-is-not-enough principle applied to the one file whose exact
 *   serialized shape is this module's own implementation detail rather than a
 *   plan-supplied byte sequence.
 * - The narrowest residual case -- a swap that fully restores the SAME
 *   original directory to the SAME path strictly inside one guarded window --
 *   still acts on the genuine claimed directory either way; the only
 *   possible outcome there is a spurious abort of an otherwise-legitimate
 *   run, never a write to, or deletion of, anything else.
 */
async function applyInitPlanCore(plan: InitPlan, deps: ApplyInitPlanDeps, fileLeases: OwnedFileLease[]): Promise<ApplyInitPlanResult> {
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
	 * One path this invocation has itself created, together with the
	 * `lstat`-derived identity (`dev`/`ino`) captured immediately after that
	 * creation succeeded -- the exact-witness proof that the entry currently
	 * at `path` is still the very instance this invocation created there, not
	 * merely an entry of the same name (Finding 1: a present-name check alone
	 * cannot tell a genuinely materialized entry apart from a same-name
	 * replacement).
	 *
	 * For a `'file'` entry, `bytes` additionally carries the exact content
	 * this invocation itself wrote there, captured immediately after creation
	 * (the planned bytes already held in memory for a plan file; the just-read
	 * marker content for `.tmp/init-state.json`, whose exact serialized bytes
	 * are otherwise this module's implementation detail, not this module's
	 * own). Identity ALONE is not sufficient for a file, for the same class of
	 * reason `applyInitPlan`'s own documentation gives for `engineeringPath`
	 * itself: a filesystem that recycles a just-freed inode for a brand-new,
	 * unrelated FILE (observed on Linux ext4 immediately after an `unlink` +
	 * `writeFile` of the same path -- the exact shape of a real CI regression
	 * this comment documents) reports the identical `dev`/`ino` pair captured
	 * at creation even though the file's actual content is now entirely
	 * foreign -- an ABA at the level of one individually tracked entry, not
	 * only at the level of the claimed directory. A `'directory'` entry needs
	 * no separate `bytes`: non-recursive `rmdir` already succeeds only on a
	 * directory that is genuinely empty, which is itself the content half of a
	 * directory's ownership proof (see `entryContentProven`).
	 *
	 * Finding (P0, sixteenth round, matching `platform/hard-link-publish.ts`'s
	 * own finding): a prior implementation captured a FILE entry's `identity`
	 * once, statically, from `createExclusive`'s/`writeInitMarker`'s
	 * handle-bound return value, then let that creating handle close. Once
	 * closed, the file had only its pathname link; a filesystem that recycled
	 * that freed inode for a byte-identical foreign replacement at the exact
	 * same tracked path could report the exact same `(dev, ino)` this
	 * invocation captured at creation, fooling every subsequent per-entry
	 * ownership re-check at once. A FILE entry now instead carries its
	 * `OwnedFileLease` directly (`createExclusive`/`writeInitMarker` keep the
	 * creating handle open; see `platform/exclusive-file.ts`'s own doc): the
	 * lease's still-open handle pins the underlying inode against recycling
	 * for as long as `applyInitPlan` might still need to make a destructive
	 * ownership decision about it, and a per-entry re-check compares a fresh
	 * pathname observation against the lease's LIVE `fstat` (`fstatLive()`)
	 * rather than a stale, statically captured identity alone. A `'directory'`
	 * entry has no handle to retain (`mkdir` returns none) and keeps its
	 * existing `identity`-only witness.
	 */
	type CreatedEntry
		= | { path: string, kind: 'file', lease: OwnedFileLease }
			| { path: string, kind: 'directory', identity: FileIdentity }

	/**
	 * Every path this invocation has itself created so far, in creation
	 * order, `engineeringPath` first -- the sole basis for both halves of the
	 * ownership proof: the exact-witness content check in `verifyClaimIntact`
	 * (every tracked entry present with its captured identity, AND no
	 * untracked entry present -- via `createdTopLevelNames`) and `abort`'s
	 * precise, non-recursive, per-entry-ownership-proven cleanup.
	 */
	const createdStack: CreatedEntry[] = [
		{ path: engineeringPath, kind: 'directory', identity: claimedIdentity! },
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
	 * `true` iff `entry.path` still denotes, right now, the EXACT entry this
	 * invocation created there. This is the identity half alone -- the
	 * ongoing, throughout-the-protocol check `verifyClaimIntact` uses for its
	 * ordinary per-entry re-check on every checkpoint. See `entrySafeToDelete`
	 * for the ADDITIONAL byte-content proof `abort` requires of a FILE entry
	 * immediately before it is actually deleted, which this function alone
	 * does not perform.
	 *
	 * For a `'directory'` entry: an ordinary fresh `lstat` identity comparison
	 * (`deps.directoryIdentity`), unchanged from before.
	 *
	 * For a `'file'` entry (Finding P0, sixteenth round): compares a FRESH
	 * pathname observation (`deps.regularFileIdentity`) against the entry's
	 * OWN lease's LIVE `fstat` (`lease.fstatLive()`) -- never a statically
	 * captured identity alone. While the lease is held, POSIX guarantees the
	 * kernel cannot free this inode for reuse by an unrelated file, so a
	 * match here is sound proof of "same file, right now," immune to the
	 * inode-recycling ABA a stale, closed-handle identity comparison could not
	 * rule out. A released lease, or one whose `fstatLive()` fails (e.g. the
	 * tracked path's last link was removed), makes ownership unprovable --
	 * fail closed.
	 */
	async function entryOwnershipProven(entry: CreatedEntry): Promise<boolean> {
		if (entry.kind === 'directory') {
			const current = await deps.directoryIdentity(entry.path)
			return current !== undefined && sameFileIdentity(current, entry.identity)
		}
		const liveIdentity = await entry.lease.fstatLive()
		if (liveIdentity === undefined)
			return false
		const current = await deps.regularFileIdentity(entry.path)
		return current !== undefined && sameFileIdentity(current, liveIdentity)
	}

	/**
	 * `true` iff `entry.path`'s current raw bytes are byte-for-byte identical
	 * to the content this invocation itself wrote there (`entry.lease.bytes`).
	 * A read failure (the path vanished, or turned into something unreadable,
	 * between the identity check and this one) is treated as unproven, not
	 * retried or ignored. Trivially `true` for a `'directory'` entry: see
	 * `CreatedEntry`'s own documentation on why `rmdir`'s empty-only semantics
	 * already are a directory's content proof.
	 */
	async function entryContentProven(entry: CreatedEntry): Promise<boolean> {
		if (entry.kind === 'directory')
			return true
		try {
			const current = await deps.readFileBytes(entry.path)
			return bytesEqual(current, entry.lease.bytes)
		}
		catch {
			return false
		}
	}

	/**
	 * `true` iff `entry.path` is provably safe for `abort`'s cleanup loop to
	 * actually delete right now: `entryOwnershipProven`'s identity re-check
	 * AND, for a FILE entry, `entryContentProven`'s additional byte-content
	 * proof. This stronger, deletion-time-only definition of ownership exists
	 * because identity alone is insufficient for a FILE at the moment of
	 * deletion: a filesystem that recycles a just-freed inode for a
	 * brand-new, unrelated file (Linux ext4, immediately after an `unlink` +
	 * `writeFile` of the identical tracked path -- the exact shape of the CI
	 * regression this check exists to close) reports the identical `dev`/`ino`
	 * this invocation captured at that file's own creation, even though the
	 * file's current content is now entirely foreign. `verifyClaimIntact`'s
	 * ongoing checkpoints deliberately do NOT pay this extra cost on every
	 * step; only the single re-check immediately before each individual
	 * deletion needs it, and that is exactly where `abort` calls this
	 * function instead of `entryOwnershipProven` alone. A directory entry
	 * needs no separate content check here either: non-recursive `rmdir`
	 * itself only ever succeeds on a directory that is genuinely empty, which
	 * is already that entry kind's content proof.
	 */
	async function entrySafeToDelete(entry: CreatedEntry): Promise<boolean> {
		if (!(await entryOwnershipProven(entry)))
			return false
		return entryContentProven(entry)
	}

	/**
	 * Delete `entry` if, and only if, `entrySafeToDelete` proves -- right now,
	 * immediately before the actual `unlink`/`rmdir` call this function makes
	 * -- that `entry.path` still denotes the exact entry this invocation
	 * created there. Returns `true` only when that proof AND the deletion
	 * itself both succeed; otherwise `entry.path` is left completely
	 * untouched. This is the ONE ownership-proven deletion primitive every
	 * destructive step in `applyInitPlan` routes through: `abort`'s own
	 * per-entry cleanup loop, and the success path's final removal of the
	 * marker itself. Routing both through the same primitive closes a gap a
	 * bespoke, ad hoc final deletion could otherwise reopen: a same-path
	 * replacement (a forced-inode-ABA reusing a tracked FILE's captured
	 * `(dev, ino)` for foreign content) landing strictly after an earlier
	 * checkpoint -- `readInitMarker`'s nonce-field parse, or
	 * `verifyClaimIntact`'s identity-only re-check -- but before a deletion
	 * that skipped this exact re-proof would otherwise have its foreign bytes
	 * silently deleted, exactly like `abort`'s own documentation describes for
	 * every other tracked FILE entry.
	 */
	async function deleteOwnedEntry(entry: CreatedEntry): Promise<boolean> {
		if (!(await entrySafeToDelete(entry)))
			return false
		try {
			if (entry.kind === 'file')
				await deps.unlink(entry.path)
			else
				await deps.rmdir(entry.path)
		}
		catch {
			return false
		}
		return true
	}

	/**
	 * `true` iff ALL of the following hold:
	 *
	 * 1. `plan.targetRoot` is still a real, non-symlink directory with the
	 *    identical identity captured above.
	 * 2. `engineeringPath`'s current top-level entries are EXACTLY (set
	 *    equality, both directions) the names this invocation has itself
	 *    created so far -- not merely a subset. A one-directional "every
	 *    present name is allowed" check proves nothing about entries this
	 *    invocation already created that are no longer present (Finding 1: a
	 *    same-claimed-identity replacement directory containing only a
	 *    subset of the expected names, such as a copied-nonce marker alone,
	 *    passed the old one-directional check).
	 * 3. Every path tracked in `createdStack` -- not just top-level names --
	 *    still denotes, by fresh `lstat` identity, the EXACT entry this
	 *    invocation created there (`entryOwnershipProven`). This is the
	 *    per-entry exact-witness half: a same-name substitution at an
	 *    already-tracked path (different content, different `dev`/`ino`) is
	 *    caught here even when the top-level name set is unchanged.
	 *
	 * The identity check alone is insufficient: see `applyInitPlan`'s own
	 * documentation on the inode-ABA hazard this content check exists to
	 * close. See also the residual-risk note on `applyInitPlan` itself for
	 * what neither check can catch.
	 */
	async function verifyClaimIntact(): Promise<boolean> {
		const currentRoot = await deps.directoryIdentity(plan.targetRoot)
		if (currentRoot === undefined || !sameFileIdentity(currentRoot, targetRootIdentity!))
			return false

		let currentEntries: string[]
		try {
			currentEntries = await deps.readDirectory(engineeringPath)
		}
		catch {
			return false
		}
		if (currentEntries.length !== createdTopLevelNames.size)
			return false
		for (const name of currentEntries) {
			if (!createdTopLevelNames.has(name))
				return false
		}

		for (const entry of createdStack) {
			if (!(await entryOwnershipProven(entry)))
				return false
		}

		return true
	}

	const claimIntactFailureMessage = `'${engineeringPath}' no longer denotes the directory this invocation claimed.`

	const nonce = deps.generateNonce()
	const tmpPath = path.join(engineeringPath, '.tmp')
	const markerPath = path.join(tmpPath, 'init-state.json')
	let markerCreated = false
	/** The marker's exact bytes, captured immediately after this invocation's own `writeInitMarker` succeeded (see the `bytes` field of `CreatedEntry`). Used both to seed the marker's own tracked entry and by `abort`'s upfront marker check below. */
	let markerBytes: Uint8Array | undefined

	async function abort(message: string): Promise<ApplyInitPlanResult> {
		if (markerCreated) {
			const read = await deps.readInitMarker(markerPath)
			if (read.outcome !== 'found' || read.marker.nonce !== nonce)
				return { applied: false, outcome: 'incomplete', message }

			// The parsed `nonce` field alone proves only that ONE sub-field's
			// value matches -- not that the marker's entire content is
			// byte-for-byte identical to what THIS invocation itself wrote
			// there. A foreign marker sharing the same nonce string (e.g.
			// embedded among extra fields, or byte-reordered/reformatted JSON
			// that still parses to the same `nonce`) would still pass the
			// check above. Require an EXACT match against the raw bytes
			// captured immediately after this invocation's own
			// `writeInitMarker` succeeded; any mismatch, including a read
			// failure, is treated exactly like a nonce mismatch.
			let currentMarkerBytes: Uint8Array
			try {
				currentMarkerBytes = await deps.readFileBytes(markerPath)
			}
			catch {
				return { applied: false, outcome: 'incomplete', message }
			}
			if (markerBytes === undefined || !bytesEqual(currentMarkerBytes, markerBytes))
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
		// `rmdir` -- never a recursive or force removal, and never by pathname
		// trust alone. `engineeringPath`'s own identity re-check above proves
		// only the top-level claim is still intact; it does NOT prove that
		// every individual tracked path beneath it still denotes the exact
		// entry this invocation created there -- a same-name, different-content
		// substitution at one already-tracked path (a foreign file swapped in
		// under the identical name, with a genuinely different `dev`/`ino`)
		// would otherwise be deleted by a blind `unlink`/`rmdir`-by-path, since
		// neither primitive cares whether the path's current content is the one
		// this invocation actually wrote there. Each entry is therefore
		// re-`lstat`'d and its identity compared against the one captured
		// immediately after THIS invocation created it -- AND, for a FILE
		// entry, its exact byte content is also re-read and compared against
		// what this invocation itself wrote there (`entrySafeToDelete`):
		// identity alone is not enough for a file either, since a filesystem
		// that recycles a just-freed inode for a brand-new file (an `unlink` +
		// `writeFile` of the identical tracked path -- observed on Linux ext4,
		// the exact CI regression this check exists to close) reports the
		// identical `dev`/`ino` even though the file's content is now entirely
		// foreign. Any mismatch (missing, a different real entry, or -- for a
		// file -- merely different content under the same identity) halts the
		// loop immediately, before that entry -- or anything remaining above
		// it in this deepest-first order -- is ever touched, leaving all of it
		// completely untouched. `rmdir` also succeeds only on a directory that
		// is genuinely empty: if `engineeringPath` (or anything tracked
		// beneath it) still holds content this invocation did not itself
		// create, the corresponding `rmdir` fails too, for the same reason. No
		// unexpected content is ever silently discarded.
		for (let i = createdStack.length - 1; i >= 0; i--) {
			const entry = createdStack[i]!
			if (!(await deleteOwnedEntry(entry)))
				return { applied: false, outcome: 'incomplete', message }
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
	{
		// The per-entry ownership witness is captured immediately after THIS
		// invocation's own creation call succeeds -- not read back later from
		// an independently racable observation -- exactly like `claimDirectory`
		// establishes `engineeringPath`'s own identity. `mkdir` returns no
		// handle, so `establishFreshDirectoryIdentity`'s `lstat`-plus-emptiness
		// check is the strongest reachable substitute (see its own doc). If it
		// cannot even be captured here, materialization is unprovable: fail
		// closed without tracking (and therefore without ever attempting to
		// delete) an entry whose ownership was never established.
		const identity = await establishFreshDirectoryIdentity(deps, tmpPath)
		if (identity === undefined)
			return abort(`'${tmpPath}' could not be verified as an empty, non-symlink directory immediately after being created.`)
		createdStack.push({ path: tmpPath, kind: 'directory', identity })
		createdTopLevelNames.add('.tmp')
	}

	if (!(await verifyClaimIntact()))
		return abort(claimIntactFailureMessage)

	// Finding (P0, fifteenth round, matching `platform/hard-link-publish.ts`'s
	// `writeTempFileComplete` finding): a prior implementation established
	// this entry's identity and bytes from TWO fresh PATHNAME observations
	// made only AFTER `writeInitMarker`'s own `open(markerPath, 'wx')` handle
	// had already closed -- `deps.regularFileIdentity(markerPath)`, then
	// `deps.readFileBytes(markerPath)`. Neither call carries any provenance
	// binding it back to the exact file this invocation itself created:
	// whatever real regular file happened to occupy `markerPath` by the time
	// they ran would have been silently adopted as "ours".
	//
	// Finding (P0, sixteenth round): even the fifteenth-round fix -- capturing
	// identity/bytes from the handle, then closing it before returning -- was
	// not enough: once closed, a recycled, byte-identical foreign replacement
	// at `markerPath` could report the exact same `(dev, ino)`. `writeInitMarker`
	// (via `createExclusive`) now keeps its creating handle OPEN, returned as
	// an `OwnedFileLease` (see `platform/exclusive-file.ts`'s own doc); the
	// marker's tracked entry below carries that lease directly, and every
	// later ownership re-check compares a fresh pathname observation against
	// the lease's LIVE `fstat` rather than a statically captured identity.
	const markerResult = await deps.writeInitMarker(markerPath, nonce)
	if (markerResult.outcome !== 'created')
		return abort(`Failed to create the initialization marker at '${markerPath}'.`)
	markerCreated = true
	{
		const { lease } = markerResult
		markerBytes = lease.bytes
		fileLeases.push(lease)
		createdStack.push({ path: markerPath, kind: 'file', lease })
	}

	for (const dir of plan.directories) {
		if (!(await verifyClaimIntact()))
			return abort(claimIntactFailureMessage)
		const dirPath = path.join(plan.targetRoot, dir)
		try {
			await deps.mkdir(dirPath)
		}
		catch (error) {
			return abort(`Failed to create directory '${dir}': ${(error as Error).message}`)
		}
		// See the `tmpPath` creation above: `mkdir` returns no handle, so
		// `establishFreshDirectoryIdentity`'s `lstat`-plus-emptiness check is
		// the strongest reachable ownership proof for a directory entry.
		const identity = await establishFreshDirectoryIdentity(deps, dirPath)
		if (identity === undefined)
			return abort(`'${dirPath}' could not be verified as an empty, non-symlink directory immediately after being created.`)
		createdStack.push({ path: dirPath, kind: 'directory', identity })
		createdTopLevelNames.add(topLevelChildName(dir))
	}

	for (const file of plan.files) {
		if (!(await verifyClaimIntact()))
			return abort(claimIntactFailureMessage)
		const filePath = path.join(plan.targetRoot, file.path)
		// Finding (P0, fifteenth round, matching `platform/hard-link-publish.ts`'s
		// `writeTempFileComplete` finding): a prior implementation established
		// this entry's identity from a fresh PATHNAME observation
		// (`deps.regularFileIdentity(filePath)`) made only AFTER
		// `createExclusive`'s own handle had already closed -- silently
		// adopting whatever real regular file happened to occupy `filePath` by
		// the time that call ran, including a foreign file substituted in at
		// the exact same path in the interim.
		//
		// Finding (P0, sixteenth round): closing the handle before returning
		// (even after capturing its identity, the fifteenth-round fix) still
		// left a window for a recycled inode to defeat a later, statically
		// compared identity. `createExclusive` now keeps its creating handle
		// OPEN, returned as an `OwnedFileLease` (see
		// `platform/exclusive-file.ts`'s own doc); this entry carries that
		// lease directly, and every later ownership re-check compares a fresh
		// pathname observation against the lease's LIVE `fstat`.
		const result = await deps.createExclusive(filePath, file.bytes)
		if (result.outcome !== 'created')
			return abort(`Failed to write '${file.path}'.`)
		fileLeases.push(result.lease)
		createdStack.push({ path: filePath, kind: 'file', lease: result.lease })
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

	// The marker's own removal is this success path's one and only destructive
	// step, so it must be held to exactly the same ownership-proof standard as
	// every deletion `abort` performs -- routed through the very same
	// `deleteOwnedEntry` primitive, never a bespoke direct `unlink`. Neither
	// `finalMarker`'s nonce-field match above nor `verifyClaimIntact`'s
	// identity-only re-check is sufficient alone (see `entrySafeToDelete`'s own
	// documentation): a same-path, same-(forced-)identity, foreign-content
	// replacement landing strictly in the narrow window between them and this
	// deletion -- a forced-inode-ABA reusing the marker's captured
	// `(dev, ino)`, reformatted to still parse with the identical `nonce` --
	// is caught HERE, immediately before deletion, by the additional
	// byte-content proof, and never reaches `deps.unlink`.
	const markerEntryIndex = createdStack.findIndex(entry => entry.path === markerPath)
	const markerEntry = markerEntryIndex !== -1 ? createdStack[markerEntryIndex] : undefined
	if (markerEntry === undefined || !(await deleteOwnedEntry(markerEntry)))
		return abort('The initialization marker could not be safely removed: its ownership could not be re-proven immediately before deletion.')
	// The marker was just removed intentionally (not by `abort`'s cleanup):
	// `createdStack` must stop tracking it as an entry `verifyClaimIntact`
	// expects to still be present, or every subsequent check would spuriously
	// fail simply because the marker this invocation itself just deleted is,
	// correctly, no longer there.
	createdStack.splice(markerEntryIndex, 1)

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

/** Release every lease in `leases`, in order, collecting each `release()` outcome. Never throws: `release()` itself never does (see `OwnedFileLease`'s own doc). */
async function releaseAllLeases(leases: readonly OwnedFileLease[]): Promise<LeaseReleaseResult[]> {
	const results: LeaseReleaseResult[] = []
	for (const lease of leases)
		results.push(await lease.release())
	return results
}

/**
 * `true` iff `error` looks like a Node `fs` system error (an `Error` carrying
 * a string `.code`, e.g. `EACCES`/`EIO`/`EPERM`) rather than a genuine
 * programmer/invariant defect such as a `TypeError` (which carries no such
 * `.code`). `ENOENT` specifically is never reachable here: every
 * `directoryIdentity`/`regularFileIdentity` probe this module calls already
 * normalizes a missing path to `undefined` before ever throwing
 * (`platform/fs-facts.ts`'s own `tryLstat`), so anything that DOES escape as
 * an exception is, by construction, some OTHER, unexpected system error -- an
 * execution/permission failure this invocation could not itself complete, not
 * a proven domain fact one way or the other. Used by `applyInitPlan` to
 * classify an exception escaping `applyInitPlanCore` as 13-cli-contract.md's
 * exit `2` class (contained as a typed `incomplete` result) rather than exit
 * `3` (reserved for a genuine implementation defect, which has no such `.code`
 * and must still propagate after this module's own lease finalization).
 */
function isFsSystemError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

/**
 * Fold every tracked file lease's `release()` outcome into `natural` --
 * `applyInitPlanCore`'s own already-decided result.
 *
 * Finding 1 (P1, seventeenth round, correcting the sixteenth round's own
 * fix): `release()` never throws, so a close failure can never escape as an
 * uncaught rejection here either -- that part of the sixteenth round's fix
 * was correct. What was wrong is WHICH `ApplyInitPlanResult` a release
 * failure was folded into. Every tracked lease here (the marker's, and every
 * planned file's) is released only once, right before this function's
 * caller returns -- structurally, well after `applyInitPlanCore` already
 * decided its own result. That ordering means a release failure can be
 * reached from `natural.applied === true` ONLY once `applyInitPlanCore` has
 * already verified the claim was never swapped out and removed the marker
 * under its full ownership-proof standard: i.e. only strictly AFTER
 * publication genuinely, physically completed. The sixteenth round's fix
 * downgraded that case to `applied: false, outcome: 'incomplete'`, which
 * misreported a genuinely completed publication as never having happened --
 * exactly the `13-cli-contract.md` "MUST NOT misreport the published state
 * as unapplied" violation Finding 1 of this round caught. If `natural`
 * already reports `applied: false` (a proven race, or an already-incomplete
 * abort -- publication never completed, or was never provably completed),
 * that result already carries its own, more specific explanation of why this
 * invocation did not complete; a release failure changes nothing further and
 * is not folded in at all (unchanged from before this round's fix). If
 * `natural` reports `applied: true` (the plan fully materialized, verified,
 * and the marker was removed), a release failure means this invocation could
 * not even cleanly account for its own file handles afterward, AFTER
 * publication itself genuinely succeeded; that is folded into the `outcome:
 * 'cleanup-failed'` variant (matching `application/artifact-create.ts`'s own
 * `foldLeaseRelease`) -- `applied: true` throughout -- rather than silently
 * reported as a plain, unqualified success, and never downgraded to
 * `applied: false`.
 */
function foldLeaseReleases(natural: ApplyInitPlanResult, releases: readonly LeaseReleaseResult[]): ApplyInitPlanResult {
	if (!natural.applied)
		return natural

	const failed = releases.find((release): release is Extract<LeaseReleaseResult, { outcome: 'released-with-error' }> => release.outcome === 'released-with-error')
	if (failed === undefined)
		return natural

	return { applied: true, outcome: 'cleanup-failed', changes: natural.changes, message: `'ef init' completed and its initialization marker was removed, but a tracked file's handle could not be cleanly released afterward: ${failed.error.message}.` }
}

/**
 * Perform the exact 13-cli-contract.md "Initialization claim-and-complete
 * protocol" for an already-validated `plan` (see `applyInitPlanCore`'s own
 * doc for the full protocol). This thin wrapper has two jobs:
 *
 * 1. Lease lifecycle: every FILE entry `applyInitPlanCore` creates (the
 *    marker, and every planned file) is tracked in `fileLeases` as it is
 *    created, and released -- exactly once each, regardless of outcome --
 *    immediately after `applyInitPlanCore` settles, so `entryOwnershipProven`'s
 *    `fstatLive()`-based checks stay valid for the ENTIRE protocol, never
 *    released mid-flight (see `foldLeaseReleases`'s own doc for how a release
 *    failure is folded into the reported result).
 * 2. Structured finalization and error classification (Finding A, eighteenth
 *    round): a prior implementation released `fileLeases` only after a
 *    successful, non-throwing return from `applyInitPlanCore` -- a bare
 *    `const natural = await applyInitPlanCore(...)`, with no surrounding
 *    `try`. `applyInitPlanCore`'s internal ownership-proof probes
 *    (`verifyClaimIntact`'s and `entryOwnershipProven`'s
 *    `directoryIdentity`/`regularFileIdentity` calls, `establishFreshDirectoryIdentity`'s,
 *    `abort`'s own re-check, and the very first `directoryIdentity(plan.targetRoot)`
 *    call) all rethrow a non-`ENOENT` `lstat` failure exactly like any other
 *    `lstat`-based check in this package (`platform/fs-facts.ts`'s own
 *    `tryLstat`): a real `EACCES`/`EIO` surfacing from ANY of them, at ANY
 *    point after the marker's own lease was already tracked in `fileLeases`
 *    (e.g. `writeInitMarker` having already succeeded), let that lease escape
 *    completely unreleased as an uncaught rejection -- directly contradicting
 *    this wrapper's own "exactly once each, regardless of outcome" guarantee
 *    -- and the CLI's own generic top-level `catch` then reported exit `3`
 *    (an internal implementation defect) for what is, in fact, an ordinary
 *    execution/permission failure (13-cli-contract.md exit `2`'s own class).
 *    Both halves are fixed together below: `fileLeases` is released exactly
 *    once, whether `applyInitPlanCore` returned normally OR threw, via
 *    structured (`try`/`catch`, never a bare `await`) finalization; a caught
 *    exception is then itself classified -- `isFsSystemError` contains a
 *    "predictable" fs observation/execution failure as a typed
 *    `applied: false, outcome: 'incomplete'` result (never a stronger claim:
 *    nothing was proven materialized, verified, or removed at the point such
 *    a failure occurred), and only a genuine non-fs-system error (e.g. a
 *    violated invariant surfacing as a `TypeError`) still propagates, after
 *    finalization, as the exit `3` this contract reserves for it.
 */
export async function applyInitPlan(plan: InitPlan, deps: ApplyInitPlanDeps = defaultApplyInitPlanDeps): Promise<ApplyInitPlanResult> {
	const fileLeases: OwnedFileLease[] = []
	let natural: ApplyInitPlanResult | undefined
	let thrown: unknown
	try {
		natural = await applyInitPlanCore(plan, deps, fileLeases)
	}
	catch (error) {
		thrown = error
	}

	// Structured finalization: every tracked lease is released here exactly
	// once, regardless of whether `applyInitPlanCore` returned normally or
	// threw -- never skipped by an early rethrow the way an un-guarded
	// `await` chain would (Finding A, eighteenth round).
	const releases = await releaseAllLeases(fileLeases)

	if (thrown !== undefined) {
		if (isFsSystemError(thrown))
			return { applied: false, outcome: 'incomplete', message: `An unexpected filesystem failure interrupted initialization before it could complete: ${thrown.message}.` }
		throw thrown
	}

	return foldLeaseReleases(natural!, releases)
}
