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
		/** `git show-ref --verify` exited `1`: the ref is PROVEN absent, not merely unprobed. */
		| { kind: 'proven-absent' }
		/**
		 * `show-ref --verify` ran but exited with something other than `0`
		 * (resolved) or `1` (proven absent) -- e.g. a corrupt ref database or
		 * an unexpected usage error -- or exited `0` with unparseable output.
		 * This is neither a resolved OID nor a proof of absence: a caller MUST
		 * treat it as incomplete (09-validation.md "An inaccessible ref ...
		 * makes the operation incomplete rather than eligible by assumption"),
		 * never fall back to treating the ref as though it does not exist.
		 */
		| { kind: 'error', message: string }
		| GitUnavailable

// ---------------------------------------------------------------------------
// getFirstParent
// ---------------------------------------------------------------------------

export type FirstParentResult
	= | { kind: 'resolved', parentOid: string }
		| { kind: 'root-commit' }
		| { kind: 'missing' }
		| { kind: 'not-a-commit' }
		/**
		 * `cat-file -t` already proved `commitOid` exists and names a commit;
		 * the follow-up `cat-file -p` then ran but exited unexpectedly. This is
		 * an execution/read error on an object just proven to exist, never
		 * proof the commit itself is missing -- a caller MUST treat this as
		 * incomplete, never fold it into `missing` (09-validation.md "An
		 * inaccessible ref ... makes the operation incomplete rather than
		 * eligible by assumption" applies equally to a commit body read).
		 */
		| { kind: 'error', message: string }
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
		/**
		 * `cat-file -t` already proved `commitOid` exists; the follow-up
		 * `ls-tree` then ran but exited unexpectedly. This is an execution/read
		 * error on an object just proven to exist, never proof the commit
		 * itself is missing -- a caller MUST treat this as incomplete, never
		 * fold it into `missing`.
		 */
		| { kind: 'error', message: string }
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
		/**
		 * `cat-file -t` already proved `blobOid` exists and names a blob; the
		 * follow-up `cat-file -p` then ran but exited unexpectedly. This is an
		 * execution/read error on an object just proven to exist, never proof
		 * the blob itself is missing -- a caller MUST treat this as incomplete,
		 * never fold it into `missing`.
		 */
		| { kind: 'error', message: string }
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
		/**
		 * `rev-list` could not resolve `commitish` at all, OR the walk
		 * produced OIDs but a required follow-up plumbing call (the boundary
		 * `cat-file` re-inspection) ran and exited unexpectedly. Either way
		 * completeness could not be conclusively determined; a caller MUST
		 * treat this as incomplete, never assume `complete` or assert the
		 * specific `shallow` conclusion from a failed read.
		 */
		| { kind: 'unresolved' }
		| GitUnavailable

// ---------------------------------------------------------------------------
// pathExistsInFirstParentHistory
// ---------------------------------------------------------------------------

export type PathHistoryResult
	= | { kind: 'found', commitOid: string }
		| { kind: 'not-found' }
		/** The repository is shallow and the path was not found within the visible history: absence cannot be concluded because hidden ancestors beyond the shallow boundary were never inspected. */
		| { kind: 'shallow' }
		/**
		 * `rev-list` could not resolve `startOid` at all, OR the walk
		 * produced OIDs but a required follow-up plumbing call (an in-loop
		 * `ls-tree`, the post-loop shallow-repository probe, or the boundary
		 * `cat-file` re-inspection) ran and exited unexpectedly. Either way
		 * `found`/`not-found`/`shallow` could not be conclusively
		 * determined; a caller MUST treat this as incomplete, never fall
		 * back to a specific found/absent/shallow conclusion.
		 */
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
		// `show-ref --verify` WITHOUT `--quiet` does not reliably use exit `1`
		// for "ref does not exist" -- at least the installed Git prints a
		// `fatal: '<ref>' - not a valid ref` message and exits `128` for a
		// syntactically well-formed but simply missing ref, indistinguishable
		// by exit code alone from a genuine execution/repository error. `-q`
		// is documented to make a failed verify use exit `1` specifically, so
		// existence is probed quietly first; the OID is fetched with a
		// second, now-expected-to-succeed call only once existence is
		// confirmed.
		const verifyOutcome = await this.executor.execIn(this.root, ['show-ref', '--verify', '--quiet', '--', fullRef])
		if (!verifyOutcome.ok)
			return toGitUnavailable(verifyOutcome.failure)
		const verifyExitCode = verifyOutcome.result.exitCode
		if (verifyExitCode === 1)
			return { kind: 'proven-absent' }
		if (verifyExitCode !== 0) {
			return { kind: 'error', message: `git show-ref --verify --quiet for '${fullRef}' exited with status ${verifyExitCode ?? 'null'}.` }
		}

		const resolveOutcome = await this.executor.execIn(this.root, ['show-ref', '--verify', '--', fullRef])
		if (!resolveOutcome.ok)
			return toGitUnavailable(resolveOutcome.failure)
		if (resolveOutcome.result.exitCode !== 0) {
			// The quiet probe just confirmed existence; a mismatched second
			// read (e.g. the ref was deleted concurrently) is an
			// execution/observation error, not a proof of absence.
			return { kind: 'error', message: `git show-ref --verify for '${fullRef}' failed to confirm existence already reported by the quiet probe (status ${resolveOutcome.result.exitCode ?? 'null'}).` }
		}
		const line = resolveOutcome.result.stdout.toString('utf8')
			.trim()
		const oid = line.split(' ')[0]
		if (!oid) {
			return { kind: 'error', message: `git show-ref --verify for '${fullRef}' exited 0 but produced no parseable output.` }
		}
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
		if (bodyOutcome.result.exitCode !== 0) {
			// The type check above just proved `commitOid` exists and is a
			// commit; a non-zero exit from the body fetch now is an unexpected
			// execution/read error, not proof the object is missing.
			return { kind: 'error', message: `git cat-file -p '${commitOid}' failed after cat-file -t proved it is a commit (exit status ${bodyOutcome.result.exitCode ?? 'null'}).` }
		}
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
		// `missing` is established ONLY by this existence probe. Once
		// `commitOid` is proven to exist, a subsequent `ls-tree` failure is an
		// execution/read error on an object already known to exist, never
		// proof of absence.
		const typeOutcome = await this.executor.execIn(this.root, ['cat-file', '-t', commitOid])
		if (!typeOutcome.ok)
			return toGitUnavailable(typeOutcome.failure)
		if (typeOutcome.result.exitCode !== 0)
			return { kind: 'missing' }

		const outcome = await this.executor.execIn(this.root, ['ls-tree', '-r', '-t', '-z', '--full-tree', commitOid])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0) {
			return { kind: 'error', message: `git ls-tree failed for '${commitOid}' after cat-file -t proved it exists (exit status ${outcome.result.exitCode ?? 'null'}).` }
		}
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
		if (contentOutcome.result.exitCode !== 0) {
			// The type check above just proved `blobOid` exists and is a blob;
			// a non-zero exit from the content fetch now is an unexpected
			// execution/read error, not proof the object is missing.
			return { kind: 'error', message: `git cat-file -p '${blobOid}' failed after cat-file -t proved it is a blob (exit status ${contentOutcome.result.exitCode ?? 'null'}).` }
		}
		return { kind: 'resolved', bytes: contentOutcome.result.stdout }
	}

	/**
	 * Walks `commitish`'s first-parent ancestry (via `rev-list
	 * --first-parent`) and only concludes `shallow` once that walk has
	 * actually run out of visible history: the same precise boundary test
	 * {@link pathExistsInFirstParentHistory} uses, applied here instead of a
	 * repo-wide pre-check.
	 *
	 * `rev-parse --is-shallow-repository` is repository-wide: it is true when
	 * ANY shallow boundary exists anywhere, even on a branch unrelated to
	 * `commitish`, so consulting it *before* walking (as this method
	 * previously did) wrongly reported `shallow` for a commitish whose own
	 * first-parent chain is completely available and reaches a true root,
	 * merely because some other branch in the same repository happens to be
	 * shallow-fetched. A shallow graft hides a commit's parent from traversal
	 * (`rev-list`) but `cat-file` still reports the object's true `parent`
	 * header, so the walked chain's oldest (last) visible commit is inspected
	 * with `cat-file` before concluding: a `parent` header proves a hidden
	 * ancestor beyond a genuine shallow boundary; its absence proves the chain
	 * actually ended at a true root commit, so this `commitish`'s history is
	 * complete despite an unrelated shallow boundary existing elsewhere in the
	 * same repository.
	 */
	async listFirstParentHistory(commitish: string): Promise<HistoryResult> {
		const outcome = await this.executor.execIn(this.root, ['rev-list', '--first-parent', commitish])
		if (!outcome.ok)
			return toGitUnavailable(outcome.failure)
		if (outcome.result.exitCode !== 0)
			return { kind: 'unresolved' }
		const oids = outcome.result.stdout.toString('utf8')
			.split('\n')
			.map(s => s.trim())
			.filter(s => s.length > 0)

		const oldestVisibleOid = oids[oids.length - 1]
		if (oldestVisibleOid === undefined) {
			// No commit was even walked; nothing to re-inspect for a hidden
			// boundary, and an empty first-parent chain is not a shallow
			// symptom on its own.
			return { kind: 'complete', oids }
		}

		const boundaryOutcome = await this.executor.execIn(this.root, ['cat-file', '-p', oldestVisibleOid])
		if (!boundaryOutcome.ok)
			return toGitUnavailable(boundaryOutcome.failure)
		if (boundaryOutcome.result.exitCode !== 0) {
			// `oldestVisibleOid` was just produced by a successful `rev-list`
			// walk, so it names a real, existing commit; `cat-file` failing
			// on it now is an unexpected execution/read error, not proof of
			// a shallow boundary. Asserting `shallow` here would convert a
			// failed read into a specific (and here unproven) semantic
			// conclusion; report the walk as unresolved instead.
			return { kind: 'unresolved' }
		}
		const text = boundaryOutcome.result.stdout.toString('utf8')
		const headerEnd = text.indexOf('\n\n')
		const header = headerEnd === -1 ? text : text.slice(0, headerEnd)
		const hiddenParent = header.split('\n')
			.some(line => line.startsWith('parent '))
		if (hiddenParent)
			return { kind: 'shallow' }
		return { kind: 'complete', oids }
	}

	/**
	 * Walks first-parent ancestors from `startOid` (via `rev-list
	 * --first-parent`) and checks each commit's tree for the exact `path`
	 * with `ls-tree <commit> -- <path>`, stopping at the first match. This is
	 * a positive-existence bootstrap check ("has this path ever appeared"),
	 * but a `not-found` conclusion is only sound over *complete* history: a
	 * shallow clone's visible first-parent chain silently stops at the
	 * shallow boundary, so an absent path there does not prove the path
	 * never appeared in a hidden ancestor beyond it
	 * (09-validation.md Bootstrap exception: "An inaccessible ref or
	 * required history makes the operation incomplete rather than eligible
	 * by assumption.").
	 *
	 * `rev-parse --is-shallow-repository` is repository-wide: it is true when
	 * ANY shallow boundary exists anywhere, even on a branch unrelated to
	 * `startOid`, so it is used only as a fast path that decides whether the
	 * precise boundary test below is worth running -- never as the
	 * conclusion itself. A shallow graft hides a commit's parent from
	 * traversal (`rev-list`) but `cat-file` still reports the object's true
	 * `parent` header, so the walked chain's last visible commit is
	 * re-inspected with `cat-file` before concluding `shallow`: a `parent`
	 * header proves a hidden ancestor (genuine boundary); its absence proves
	 * the chain actually ended at a true root commit, so absence over the
	 * entire first-parent history is proven despite an unrelated shallow
	 * boundary existing elsewhere in the same repository.
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
			if (outcome.result.exitCode !== 0) {
				// `oid` was just produced by a successful `rev-list` walk, so
				// it names a real, existing commit; a real `ls-tree` exits
				// `0` with empty output when a path is simply absent from
				// that commit's tree, so a non-zero exit here is an
				// unexpected execution/read error, never a legitimate
				// "path absent at this commit" signal. Silently continuing
				// the loop would let the walk conclude `not-found` despite
				// never having actually inspected this commit's tree.
				return { kind: 'unresolved' }
			}
			if (outcome.result.stdout.length > 0)
				return { kind: 'found', commitOid: oid }
		}

		const shallowOutcome = await this.executor.execIn(this.root, ['rev-parse', '--is-shallow-repository'])
		if (!shallowOutcome.ok)
			return toGitUnavailable(shallowOutcome.failure)
		if (shallowOutcome.result.exitCode !== 0) {
			// A fatal, non-`git-unavailable` exit from the probe itself is an
			// execution/read error, not proof the repository is non-shallow;
			// folding it into "false" would let an unprobed (and possibly
			// real) shallow boundary silently fall through to `not-found`.
			return { kind: 'unresolved' }
		}
		const repositoryHasAnyShallowBoundary = shallowOutcome.result.stdout.toString('utf8')
			.trim() === 'true'
		if (!repositoryHasAnyShallowBoundary)
			return { kind: 'not-found' }

		const lastVisibleOid = oids[oids.length - 1]
		if (lastVisibleOid === undefined) {
			// No commit was even walked; nothing to re-inspect, so defer to
			// the repo-wide flag conservatively.
			return { kind: 'shallow' }
		}

		const boundaryOutcome = await this.executor.execIn(this.root, ['cat-file', '-p', lastVisibleOid])
		if (!boundaryOutcome.ok)
			return toGitUnavailable(boundaryOutcome.failure)
		if (boundaryOutcome.result.exitCode !== 0) {
			// `lastVisibleOid` was just produced by a successful `rev-list`
			// walk, so it names a real, existing commit; `cat-file` failing
			// on it now is an unexpected execution/read error, not proof of
			// a shallow boundary. Asserting `shallow` here would convert a
			// failed read into a specific (and here unproven) semantic
			// conclusion; report the walk as unresolved instead.
			return { kind: 'unresolved' }
		}
		const text = boundaryOutcome.result.stdout.toString('utf8')
		const headerEnd = text.indexOf('\n\n')
		const header = headerEnd === -1 ? text : text.slice(0, headerEnd)
		const hiddenParent = header.split('\n')
			.some(line => line.startsWith('parent '))
		return hiddenParent ? { kind: 'shallow' } : { kind: 'not-found' }
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
