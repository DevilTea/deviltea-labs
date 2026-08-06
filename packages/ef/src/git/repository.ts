/**
 * Typed Git plumbing adapter over {@link GitExecutor}
 * (00-implementation-decisions.md, "Git Execution"; trusted-transition
 * baseline and bootstrap-ref conditions in 11-filesystem-and-config.md;
 * atomicity in 07-change-transactions.md).
 *
 * `GitRepository` never passes user-controlled arbitrary Git options: every
 * method issues a fixed plumbing command shape, using `-z` output and byte
 * parsing instead of quoted or localized paths, and `--` to separate options
 * from path arguments where a pathspec is involved. Every method returns a
 * typed result instead of throwing; only the caller decides how a given
 * outcome maps to a diagnostic.
 */

import type { Buffer } from 'node:buffer'
import type { GitExecFailure, GitExecutor } from './executor'
import { createGitExecutor } from './executor'

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** The Git executable could not be run, or the process could not be observed to completion. */
export interface GitUnavailable {
	kind: 'git-unavailable'
	message: string
}

function execFailureMessage(failure: GitExecFailure): string {
	switch (failure.kind) {
		case 'unavailable':
			return failure.message
		case 'output-limit-exceeded':
			return `git output on ${failure.stream} exceeded ${failure.limitBytes} bytes`
		case 'aborted':
			return 'git command was aborted'
	}
}

function toGitUnavailable(failure: GitExecFailure): GitUnavailable {
	return { kind: 'git-unavailable', message: execFailureMessage(failure) }
}

export type ObjectFormat = 'sha1' | 'sha256'

const OID_HEX_LENGTH: Record<ObjectFormat, number> = { sha1: 40, sha256: 64 }

// ---------------------------------------------------------------------------
// findWorktreeRoot
// ---------------------------------------------------------------------------

export type WorktreeRootResult
	= | { kind: 'found', root: string }
		| { kind: 'not-a-worktree' }
		| GitUnavailable

/**
 * Resolve the Git worktree root that contains `path` (`rev-parse
 * --show-toplevel` semantics). Standalone so a root can be discovered before
 * any {@link GitRepository} is constructed; also exposed as an instance
 * method for convenience.
 */
export async function findWorktreeRoot(executor: GitExecutor, path: string): Promise<WorktreeRootResult> {
	const outcome = await executor.execIn(path, ['rev-parse', '--show-toplevel'])
	if (!outcome.ok)
		return toGitUnavailable(outcome.failure)
	if (outcome.result.exitCode !== 0)
		return { kind: 'not-a-worktree' }
	const root = outcome.result.stdout.toString('utf8')
		.replace(/\n+$/, '')
	return { kind: 'found', root }
}

// ---------------------------------------------------------------------------
// getObjectFormat
// ---------------------------------------------------------------------------

export type ObjectFormatResult
	= | { kind: 'resolved', format: ObjectFormat }
		| { kind: 'unsupported' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// resolveCommit
// ---------------------------------------------------------------------------

export type ResolvedCommitResult
	= | { kind: 'resolved', oid: string }
		| { kind: 'malformed', oid: string }
		| { kind: 'missing', oid: string }
		| { kind: 'not-a-commit', oid: string, actualType: string }
		| GitUnavailable

function isFullOid(oid: string, hexLength: number): boolean {
	if (oid.length !== hexLength)
		return false
	for (let i = 0; i < oid.length; i++) {
		const c = oid.charCodeAt(i)
		const isDigit = c >= 0x30 && c <= 0x39
		const isLowerHex = c >= 0x61 && c <= 0x66
		const isUpperHex = c >= 0x41 && c <= 0x46
		if (!isDigit && !isLowerHex && !isUpperHex)
			return false
	}
	return true
}

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------

export type RefResolutionResult
	= | { kind: 'resolved', oid: string }
		| { kind: 'unresolved' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// getFirstParent
// ---------------------------------------------------------------------------

export type FirstParentResult
	= | { kind: 'resolved', parentOid: string }
		| { kind: 'root-commit' }
		| { kind: 'missing' }
		| { kind: 'not-a-commit' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// readTree
// ---------------------------------------------------------------------------

export interface GitTreeEntry {
	path: string
	mode: string
	oid: string
	type: 'blob' | 'tree' | 'commit'
}

export type GitTree = readonly GitTreeEntry[]

export type ReadTreeResult
	= | { kind: 'resolved', entries: GitTree }
		| { kind: 'missing' }
		| GitUnavailable

/**
 * Parse `ls-tree -z` output: repeated `<mode> SP <type> SP <oid> TAB <path>`
 * records, each terminated by a NUL byte. Splitting on raw bytes (rather than
 * decoding the whole buffer to a string first) keeps a path's bytes intact
 * even when it contains a byte sequence that would otherwise need to be
 * decoded relative to a different boundary; `-z` guarantees Git never quotes
 * or escapes the path, so decoding each field independently as UTF-8 is
 * exact.
 */
function parseLsTreeZ(buffer: Buffer): GitTreeEntry[] {
	const entries: GitTreeEntry[] = []
	let start = 0
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] !== 0x00)
			continue
		if (i > start) {
			const record = buffer.subarray(start, i)
			const tabIndex = record.indexOf(0x09)
			const meta = record.subarray(0, tabIndex)
				.toString('utf8')
			const path = record.subarray(tabIndex + 1)
				.toString('utf8')
			const [mode, type, oid] = meta.split(' ')
			entries.push({ path, mode: mode ?? '', oid: oid ?? '', type: (type ?? 'blob') as GitTreeEntry['type'] })
		}
		start = i + 1
	}
	return entries
}

// ---------------------------------------------------------------------------
// readBlob
// ---------------------------------------------------------------------------

export type ReadBlobResult
	= | { kind: 'resolved', bytes: Buffer }
		| { kind: 'missing' }
		| { kind: 'not-a-blob', actualType: string }
		| GitUnavailable

// ---------------------------------------------------------------------------
// listFirstParentHistory
// ---------------------------------------------------------------------------

/**
 * Oldest-first vs. newest-first is an implementation choice the spec leaves
 * open ("pick one, document it"). This adapter returns newest-first: exactly
 * `git rev-list`'s native order (the starting commit, then each first-parent
 * ancestor), so no reversal or extra buffering is needed.
 */
export type HistoryResult
	= | { kind: 'complete', oids: readonly string[] }
		| { kind: 'shallow' }
		| { kind: 'unresolved' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// pathExistsInFirstParentHistory
// ---------------------------------------------------------------------------

export type PathHistoryResult
	= | { kind: 'found', commitOid: string }
		| { kind: 'not-found' }
		| { kind: 'unresolved' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// diffTrees
// ---------------------------------------------------------------------------

export interface TreeDiffEntry {
	status: 'A' | 'M' | 'D'
	path: string
}

export type GitTreeDiff = readonly TreeDiffEntry[]

export type DiffTreesResult
	= | { kind: 'resolved', entries: GitTreeDiff }
		| { kind: 'invalid-object' }
		| GitUnavailable

/**
 * Parse `--name-status -z` output: alternating `<status>\0<path>\0` records.
 * Renames and copies are disabled by the caller (`--no-renames`), so every
 * status is a single letter with no similarity score or second path. Any
 * letter besides `A`/`D` (for example Git's `T` type-change status) is
 * reported as `M`: EF's transaction model only distinguishes introduced,
 * removed, and otherwise-changed content for a target's aggregate state.
 */
function parseNameStatusZ(buffer: Buffer): TreeDiffEntry[] {
	const fields: string[] = []
	let start = 0
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] !== 0x00)
			continue
		fields.push(buffer.subarray(start, i)
			.toString('utf8'))
		start = i + 1
	}
	const entries: TreeDiffEntry[] = []
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const rawStatus = fields[i]!
		const path = fields[i + 1]!
		const status: TreeDiffEntry['status'] = rawStatus === 'A' ? 'A' : rawStatus === 'D' ? 'D' : 'M'
		entries.push({ status, path })
	}
	return entries
}

// ---------------------------------------------------------------------------
// checkCapabilities
// ---------------------------------------------------------------------------

export interface GitCapabilities {
	available: boolean
	version: string | null
	/** `rev-parse --show-object-format` is recognized (SHA-1/SHA-256 detection). Only probed when `root` is supplied. */
	showObjectFormat: boolean
	/** `rev-parse --is-shallow-repository` is recognized (shallow-history detection). Only probed when `root` is supplied. */
	isShallowRepository: boolean
}

/**
 * Detect required Git capabilities at runtime rather than trusting a version
 * string alone (00-implementation-decisions.md). Without `root`, only Git's
 * availability and reported version are known; the plumbing-flag checks
 * require an actual repository to run against, so they report `false`
 * (not probed) until a root is supplied.
 */
export async function checkCapabilities(executor: GitExecutor, root?: string): Promise<GitCapabilities> {
	const versionOutcome = await executor.exec(['--version'])
	if (!versionOutcome.ok || versionOutcome.result.exitCode !== 0)
		return { available: false, version: null, showObjectFormat: false, isShallowRepository: false }

	const match = /git version (\S+)/.exec(versionOutcome.result.stdout.toString('utf8'))
	const version = match?.[1] ?? null

	if (root === undefined)
		return { available: true, version, showObjectFormat: false, isShallowRepository: false }

	const [objectFormatOutcome, shallowOutcome] = await Promise.all([
		executor.execIn(root, ['rev-parse', '--show-object-format']),
		executor.execIn(root, ['rev-parse', '--is-shallow-repository']),
	])

	return {
		available: true,
		version,
		showObjectFormat: objectFormatOutcome.ok && objectFormatOutcome.result.exitCode === 0,
		isShallowRepository: shallowOutcome.ok && shallowOutcome.result.exitCode === 0,
	}
}

// ---------------------------------------------------------------------------
// GitRepository
// ---------------------------------------------------------------------------

export interface GitRepository {
	readonly root: string
	findWorktreeRoot: (path: string) => Promise<WorktreeRootResult>
	getObjectFormat: () => Promise<ObjectFormatResult>
	resolveCommit: (oid: string) => Promise<ResolvedCommitResult>
	resolveRef: (fullRef: string) => Promise<RefResolutionResult>
	getFirstParent: (commitOid: string) => Promise<FirstParentResult>
	readTree: (commitOid: string) => Promise<ReadTreeResult>
	readBlob: (blobOid: string) => Promise<ReadBlobResult>
	/** Newest-first OID sequence; see {@link HistoryResult}. */
	listFirstParentHistory: (commitish: string) => Promise<HistoryResult>
	pathExistsInFirstParentHistory: (startOid: string, path: string) => Promise<PathHistoryResult>
	diffTrees: (beforeOid: string, afterOid: string) => Promise<DiffTreesResult>
}

class GitRepositoryImpl implements GitRepository {
	private objectFormatCache: ObjectFormat | undefined

	constructor(readonly root: string, private readonly executor: GitExecutor) {}

	findWorktreeRoot(path: string): Promise<WorktreeRootResult> {
		return findWorktreeRoot(this.executor, path)
	}

	async getObjectFormat(): Promise<ObjectFormatResult> {
		if (this.objectFormatCache !== undefined)
			return { kind: 'resolved', format: this.objectFormatCache }

		const outcome = await this.executor.execIn(this.root, ['rev-parse', '--show-object-format'])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'unsupported' }
		const value = outcome.result.stdout.toString('utf8')
			.trim()
		if (value !== 'sha1' && value !== 'sha256')
			return { kind: 'unsupported' }
		this.objectFormatCache = value
		return { kind: 'resolved', format: value }
	}

	async resolveCommit(oid: string): Promise<ResolvedCommitResult> {
		const formatResult = await this.getObjectFormat()
		if (formatResult.kind === 'git-unavailable')
			return formatResult
		if (formatResult.kind === 'unsupported')
			return { kind: 'malformed', oid }

		const hexLength = OID_HEX_LENGTH[formatResult.format]
		if (!isFullOid(oid, hexLength))
			return { kind: 'malformed', oid }
		const normalized = oid.toLowerCase()

		const typeOutcome = await this.executor.execIn(this.root, ['cat-file', '-t', normalized])
		if (!typeOutcome.ok)
			return toGitUnavailable(typeOutcome.failure)
		if (typeOutcome.result.exitCode !== 0)
			return { kind: 'missing', oid: normalized }
		const actualType = typeOutcome.result.stdout.toString('utf8')
			.trim()
		if (actualType !== 'commit')
			return { kind: 'not-a-commit', oid: normalized, actualType }
		return { kind: 'resolved', oid: normalized }
	}

	async resolveRef(fullRef: string): Promise<RefResolutionResult> {
		const outcome = await this.executor.execIn(this.root, ['show-ref', '--verify', '--', fullRef])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'unresolved' }
		const line = outcome.result.stdout.toString('utf8')
			.trim()
		const oid = line.split(' ')[0]
		if (!oid)
			return { kind: 'unresolved' }
		return { kind: 'resolved', oid }
	}

	async getFirstParent(commitOid: string): Promise<FirstParentResult> {
		const typeOutcome = await this.executor.execIn(this.root, ['cat-file', '-t', commitOid])
		if (!typeOutcome.ok)
			return toGitUnavailable(typeOutcome.failure)
		if (typeOutcome.result.exitCode !== 0)
			return { kind: 'missing' }
		const actualType = typeOutcome.result.stdout.toString('utf8')
			.trim()
		if (actualType !== 'commit')
			return { kind: 'not-a-commit' }

		const bodyOutcome = await this.executor.execIn(this.root, ['cat-file', '-p', commitOid])
		if (!bodyOutcome.ok)
			return toGitUnavailable(bodyOutcome.failure)
		if (bodyOutcome.result.exitCode !== 0)
			return { kind: 'missing' }
		const text = bodyOutcome.result.stdout.toString('utf8')
		const headerEnd = text.indexOf('\n\n')
		const header = headerEnd === -1 ? text : text.slice(0, headerEnd)
		const parentLine = header.split('\n')
			.find(line => line.startsWith('parent '))
		if (!parentLine)
			return { kind: 'root-commit' }
		return { kind: 'resolved', parentOid: parentLine.slice('parent '.length)
			.trim() }
	}

	async readTree(commitOid: string): Promise<ReadTreeResult> {
		const outcome = await this.executor.execIn(this.root, ['ls-tree', '-r', '-t', '-z', '--full-tree', commitOid])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'missing' }
		return { kind: 'resolved', entries: parseLsTreeZ(outcome.result.stdout) }
	}

	async readBlob(blobOid: string): Promise<ReadBlobResult> {
		const typeOutcome = await this.executor.execIn(this.root, ['cat-file', '-t', blobOid])
		if (!typeOutcome.ok)
			return toGitUnavailable(typeOutcome.failure)
		if (typeOutcome.result.exitCode !== 0)
			return { kind: 'missing' }
		const actualType = typeOutcome.result.stdout.toString('utf8')
			.trim()
		if (actualType !== 'blob')
			return { kind: 'not-a-blob', actualType }

		const contentOutcome = await this.executor.execIn(this.root, ['cat-file', '-p', blobOid])
		if (!contentOutcome.ok)
			return toGitUnavailable(contentOutcome.failure)
		if (contentOutcome.result.exitCode !== 0)
			return { kind: 'missing' }
		return { kind: 'resolved', bytes: contentOutcome.result.stdout }
	}

	async listFirstParentHistory(commitish: string): Promise<HistoryResult> {
		const shallowOutcome = await this.executor.execIn(this.root, ['rev-parse', '--is-shallow-repository'])
		if (!shallowOutcome.ok)
			return toGitUnavailable(shallowOutcome.failure)
		if (shallowOutcome.result.exitCode === 0 && shallowOutcome.result.stdout.toString('utf8')
			.trim() === 'true') {
			return { kind: 'shallow' }
		}

		const outcome = await this.executor.execIn(this.root, ['rev-list', '--first-parent', commitish])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'unresolved' }
		const oids = outcome.result.stdout.toString('utf8')
			.split('\n')
			.map(s => s.trim())
			.filter(s => s.length > 0)
		return { kind: 'complete', oids }
	}

	/**
	 * Walks first-parent ancestors from `startOid` (via `rev-list
	 * --first-parent`) and checks each commit's tree for the exact `path`
	 * with `ls-tree <commit> -- <path>`, stopping at the first match. This is
	 * a positive-existence bootstrap check ("has this path ever appeared"),
	 * not a complete-history requirement, so unlike
	 * {@link GitRepositoryImpl.listFirstParentHistory} it does not fail on a
	 * shallow repository: a shallow clone simply limits how far back the
	 * search can look before reporting `not-found`.
	 */
	async pathExistsInFirstParentHistory(startOid: string, path: string): Promise<PathHistoryResult> {
		const listOutcome = await this.executor.execIn(this.root, ['rev-list', '--first-parent', startOid])
		if (!listOutcome.ok)
			return toGitUnavailable(listOutcome.failure)
		if (listOutcome.result.exitCode !== 0)
			return { kind: 'unresolved' }
		const oids = listOutcome.result.stdout.toString('utf8')
			.split('\n')
			.map(s => s.trim())
			.filter(s => s.length > 0)

		for (const oid of oids) {
			const outcome = await this.executor.execIn(this.root, ['ls-tree', oid, '--', path])
			if (!outcome.ok)
				return toGitUnavailable(outcome.failure)
			if (outcome.result.exitCode === 0 && outcome.result.stdout.length > 0)
				return { kind: 'found', commitOid: oid }
		}
		return { kind: 'not-found' }
	}

	async diffTrees(beforeOid: string, afterOid: string): Promise<DiffTreesResult> {
		const outcome = await this.executor.execIn(this.root, ['diff', '--no-renames', '--name-status', '-z', beforeOid, afterOid])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'invalid-object' }
		return { kind: 'resolved', entries: parseNameStatusZ(outcome.result.stdout) }
	}
}

/** Create a {@link GitRepository} bound to an explicit, already-verified worktree root. */
export function createGitRepository(root: string, executor: GitExecutor = createGitExecutor()): GitRepository {
	return new GitRepositoryImpl(root, executor)
}
