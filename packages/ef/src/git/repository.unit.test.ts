import type { GitExecOutcome, GitExecutor } from './executor'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from './executor'
import { checkCapabilities, createGitRepository, findWorktreeRoot } from './repository'

/**
 * A scripted stand-in for {@link GitExecutor} used only to reach branches
 * that depend on a specific multi-call sequence (e.g. the first plumbing
 * call in a method succeeding while the second fails) that would otherwise
 * require contriving an unreliable real-Git failure. Every other test in
 * this file exercises {@link GitRepository} against a real repository and a
 * real `git` process.
 */
function scriptedExecutor(outcomes: readonly GitExecOutcome[]): GitExecutor {
	let call = 0
	const next = (): Promise<GitExecOutcome> => {
		const outcome = outcomes[call] ?? outcomes[outcomes.length - 1]!
		call += 1
		return Promise.resolve(outcome)
	}
	return { exec: () => next(), execIn: () => next() }
}

function okOutcome(stdout: string, exitCode = 0): GitExecOutcome {
	return { ok: true, result: { stdout: Buffer.from(stdout, 'utf8'), stderr: Buffer.alloc(0), exitCode, signal: null } }
}

function unavailableOutcome(message: string): GitExecOutcome {
	return { ok: false, failure: { kind: 'unavailable', message } }
}

function outputLimitOutcome(): GitExecOutcome {
	return { ok: false, failure: { kind: 'output-limit-exceeded', stream: 'stdout', limitBytes: 10 } }
}

function abortedOutcome(): GitExecOutcome {
	return { ok: false, failure: { kind: 'aborted' } }
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	const result = execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
	// A freshly initialized fixture repository must not run background
	// maintenance (`gc --auto`'s detached repack, or `maintenance.auto`'s
	// scheduled runs): a stray background process can still be writing
	// `.git/objects/pack` when this file's teardown removes the fixture,
	// racing the rmdir and intermittently failing with `ENOTEMPTY` (observed
	// in CI). Disabling it right after `init` removes the writer instead of
	// just tolerating the race.
	if (args[0] === 'init') {
		execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
		execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
		execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
	}
	return result
}

/** Applies the same background-maintenance lockdown as {@link git}'s `init` branch, for fixture repositories created by `git init`/`git clone` outside that helper (e.g. with a non-default object format, or via a real clone). */
function disableBackgroundMaintenance(dir: string): void {
	execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
	execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
	execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
}

function writeTrackedFile(dir: string, relPath: string, content: string): void {
	const full = join(dir, relPath)
	mkdirSync(dirname(full), { recursive: true })
	writeFileSync(full, content, 'utf8')
}

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ef-git-repo-'))
	git(dir, ['init', '-q', '-b', 'main'])
	return dir
}

/**
 * Write `content` to the object database via `git hash-object -w --stdin`,
 * returning the resulting blob OID. Unlike {@link writeTrackedFile}, this
 * never touches the working tree or index by path, so it composes with
 * {@link addRawIndexEntry}'s raw-byte path injection below (Finding 4/5
 * fixtures) without any working-tree path ever needing to hold the exact
 * bytes under test.
 */
function hashObjectFromStdin(dir: string, content: Buffer): string {
	return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: { ...process.env, ...GIT_TEST_ENV }, input: content, encoding: 'utf8' })
		.trim()
}

/**
 * Stage one index entry whose PATH is exactly `pathBytes` -- which may
 * contain byte sequences that are not valid UTF-8 -- via `git update-index
 * --index-info`. Node's `child_process` API accepts only JS strings (never
 * raw bytes) as argv, so a path containing invalid UTF-8 cannot be passed as
 * a normal CLI argument; feeding the index-info line to the process's STDIN
 * as a `Buffer` sidesteps that entirely (Finding 4's fixture requirement).
 */
function addRawIndexEntry(dir: string, mode: string, blobOid: string, pathBytes: Buffer): void {
	const line = Buffer.concat([Buffer.from(`${mode} blob ${blobOid}\t`), pathBytes, Buffer.from('\n')])
	execFileSync('git', ['-C', dir, 'update-index', '--add', '--index-info'], { env: { ...process.env, ...GIT_TEST_ENV }, input: line })
}

/** Stage one index entry at an ordinary (ASCII) `path` with an explicit `mode` -- e.g. `120000` for a symlink -- via `git update-index --add --cacheinfo`, without ever creating a real filesystem symlink (Finding 5's fixture requirement). */
function addCacheinfoEntry(dir: string, mode: string, blobOid: string, path: string): void {
	execFileSync('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `${mode},${blobOid},${path}`], { env: { ...process.env, ...GIT_TEST_ENV } })
}

/** `git write-tree`: materialize the current index as a tree object, returning its OID. */
function writeTreeOid(dir: string): string {
	return execFileSync('git', ['-C', dir, 'write-tree'], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
		.trim()
}

/** `git commit-tree`: create a parentless commit for `treeOid`, returning its OID. */
function commitTreeOid(dir: string, treeOid: string, message: string): string {
	return execFileSync('git', ['-C', dir, 'commit-tree', treeOid, '-m', message], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
		.trim()
}

describe('gitRepository', () => {
	let executor: GitExecutor
	const tempDirs: string[] = []

	beforeEach(() => {
		executor = createGitExecutor()
	})

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	function repo(dir: string) {
		tempDirs.push(dir)
		return createGitRepository(dir, executor)
	}

	// -------------------------------------------------------------------------
	// findWorktreeRoot
	// -------------------------------------------------------------------------

	describe('findWorktreeRoot', () => {
		it('resolves the root of a plain worktree', async () => {
			const dir = initRepo()
			const result = await findWorktreeRoot(executor, dir)
			expect(result.kind)
				.toBe('found')
			if (result.kind !== 'found')
				return
			expect(result.root.endsWith(dir.split('/')
				.pop()!))
				.toBe(true)
			tempDirs.push(dir)
		})

		it('is also reachable as a GitRepository instance method (delegates to the standalone function)', async () => {
			const dir = initRepo()
			const result = await repo(dir)
				.findWorktreeRoot(dir)
			expect(result.kind)
				.toBe('found')
		})

		it('reports not-a-worktree for a directory outside any Git repository', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'ef-git-not-a-repo-'))
			const result = await findWorktreeRoot(executor, dir)
			expect(result)
				.toEqual({ kind: 'not-a-worktree' })
			tempDirs.push(dir)
		})

		it('resolves the worktree root while HEAD is detached', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const first = commitAll(dir, 'first')
			writeTrackedFile(dir, 'b.txt', 'b\n')
			commitAll(dir, 'second')
			git(dir, ['checkout', '-q', first])

			const result = await findWorktreeRoot(executor, dir)
			expect(result.kind)
				.toBe('found')
			if (result.kind === 'found') {
				expect(result.root.endsWith(dir.split('/')
					.pop()!))
					.toBe(true)
			}
			tempDirs.push(dir)
		})

		it('resolves a linked worktree to its own root, not the main worktree', async () => {
			const main = initRepo()
			writeTrackedFile(main, 'a.txt', 'a\n')
			commitAll(main, 'first')
			const linked = join(tmpdir(), `ef-git-linked-${Date.now()}`)
			git(main, ['worktree', 'add', '-q', '-b', 'linked-branch', linked])

			const result = await findWorktreeRoot(executor, linked)
			expect(result.kind)
				.toBe('found')
			if (result.kind === 'found') {
				expect(result.root.endsWith(`ef-git-linked-${linked.split('-')
					.pop()}`))
					.toBe(true)
				expect(result.root).not.toBe(main)
			}
			tempDirs.push(main)
			tempDirs.push(linked)
		})
	})

	// -------------------------------------------------------------------------
	// getObjectFormat
	// -------------------------------------------------------------------------

	describe('getObjectFormat', () => {
		it('resolves sha1 for a default repository', async () => {
			const dir = initRepo()
			const result = await repo(dir)
				.getObjectFormat()
			expect(result)
				.toEqual({ kind: 'resolved', format: 'sha1' })
		})

		it('resolves sha256 when the repository was created with --object-format=sha256', async () => {
			const dir = mkdtempSync(join(tmpdir(), 'ef-git-repo-'))
			try {
				execFileSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', dir], { stdio: 'pipe' })
				disableBackgroundMaintenance(dir)
			}
			catch {
				rmSync(dir, { recursive: true, force: true })
				// The installed Git does not support the SHA-256 object format; skip.
				expect(true)
					.toBe(true)
				return
			}
			const result = await repo(dir)
				.getObjectFormat()
			expect(result)
				.toEqual({ kind: 'resolved', format: 'sha256' })
		})

		it('caches a resolved format so a second call does not invoke Git again', async () => {
			const dir = initRepo()
			tempDirs.push(dir)
			let calls = 0
			const countingExecutor: GitExecutor = {
				exec: () => { throw new Error('unused') },
				execIn: (...args) => {
					calls++
					return executor.execIn(...args)
				},
			}
			const instance = createGitRepository(dir, countingExecutor)
			await instance.getObjectFormat()
			await instance.getObjectFormat()
			expect(calls)
				.toBe(1)
		})
	})

	// -------------------------------------------------------------------------
	// resolveCommit
	// -------------------------------------------------------------------------

	describe('resolveCommit', () => {
		it('resolves a full-length OID that names a commit', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')
			const result = await repo(dir)
				.resolveCommit(oid)
			expect(result)
				.toEqual({ kind: 'resolved', oid })
		})

		it('rejects an abbreviated (short) OID as malformed without asking Git to resolve it', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')
			const short = oid.slice(0, 7)
			const result = await repo(dir)
				.resolveCommit(short)
			expect(result)
				.toEqual({ kind: 'malformed', oid: short })
		})

		it('rejects a full-length string containing a non-hex character as malformed', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const invalid = `g${'0'.repeat(39)}`
			const result = await repo(dir)
				.resolveCommit(invalid)
			expect(result)
				.toEqual({ kind: 'malformed', oid: invalid })
		})

		it('rejects a branch name as malformed rather than resolving it to a commit', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.resolveCommit('main')
			expect(result)
				.toEqual({ kind: 'malformed', oid: 'main' })
		})

		it('reports missing for a well-formed OID with no matching object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const bogus = '0'.repeat(40)
			const result = await repo(dir)
				.resolveCommit(bogus)
			expect(result)
				.toEqual({ kind: 'missing', oid: bogus })
		})

		it('reports not-a-commit for a full OID naming a tree object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const treeOid = git(dir, ['rev-parse', 'HEAD^{tree}'])
				.trim()
			const result = await repo(dir)
				.resolveCommit(treeOid)
			expect(result)
				.toEqual({ kind: 'not-a-commit', oid: treeOid, actualType: 'tree' })
		})

		it('reports not-a-commit for a full OID naming a blob object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const blobOid = git(dir, ['rev-parse', 'HEAD:a.txt'])
				.trim()
			const result = await repo(dir)
				.resolveCommit(blobOid)
			expect(result)
				.toEqual({ kind: 'not-a-commit', oid: blobOid, actualType: 'blob' })
		})

		it('accepts an uppercase-hex full OID by normalizing it to lowercase', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')
			const result = await repo(dir)
				.resolveCommit(oid.toUpperCase())
			expect(result)
				.toEqual({ kind: 'resolved', oid })
		})
	})

	// -------------------------------------------------------------------------
	// resolveRef
	// -------------------------------------------------------------------------

	describe('resolveRef', () => {
		it('resolves an existing branch ref to its current OID', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')
			const result = await repo(dir)
				.resolveRef('refs/heads/main')
			expect(result)
				.toEqual({ kind: 'resolved', oid })
		})

		it('reports proven-absent (exit 1) for an unborn branch ref with no commits', async () => {
			const dir = initRepo()
			const result = await repo(dir)
				.resolveRef('refs/heads/main')
			expect(result)
				.toEqual({ kind: 'proven-absent' })
		})

		it('reports proven-absent (exit 1) for a ref name that has never existed', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.resolveRef('refs/heads/does-not-exist')
			expect(result)
				.toEqual({ kind: 'proven-absent' })
		})

		// FINDING A regression: `show-ref --verify` uses exit 1 specifically for
		// "none of the given refs exist" (a PROVEN absence); any other non-zero
		// exit is an execution/repository error and must not be conflated with
		// that proof, or bootstrap/transition would wrongly treat a failed probe
		// as though `integration_ref` does not exist.
		it('reports a distinct error (not proven-absent) for a fatal show-ref exit other than 1', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('fatal: bad ref database\n', 128)]))
				.resolveRef('refs/heads/main')
			expect(result.kind)
				.toBe('error')
			expect(result.kind === 'error' && result.message)
				.toContain('128')
		})
	})

	// -------------------------------------------------------------------------
	// getFirstParent
	// -------------------------------------------------------------------------

	describe('getFirstParent', () => {
		it('reports root-commit for a commit with no parent', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')
			const result = await repo(dir)
				.getFirstParent(oid)
			expect(result)
				.toEqual({ kind: 'root-commit' })
		})

		it('resolves the first parent of a linear commit', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const first = commitAll(dir, 'first')
			writeTrackedFile(dir, 'b.txt', 'b\n')
			const second = commitAll(dir, 'second')
			const result = await repo(dir)
				.getFirstParent(second)
			expect(result)
				.toEqual({ kind: 'resolved', parentOid: first })
		})

		it('resolves the first parent (not the merged-in branch) of a merge commit', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const main1 = commitAll(dir, 'main1')
			git(dir, ['checkout', '-q', '-b', 'feature'])
			writeTrackedFile(dir, 'feature.txt', 'feature\n')
			commitAll(dir, 'feature1')
			git(dir, ['checkout', '-q', 'main'])
			git(dir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
			const mergeOid = git(dir, ['rev-parse', 'HEAD'])
				.trim()
			const result = await repo(dir)
				.getFirstParent(mergeOid)
			expect(result)
				.toEqual({ kind: 'resolved', parentOid: main1 })
		})

		it('reports missing for an OID with no matching object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.getFirstParent('0'.repeat(40))
			expect(result)
				.toEqual({ kind: 'missing' })
		})

		it('reports not-a-commit for an OID naming a blob', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const blobOid = git(dir, ['rev-parse', 'HEAD:a.txt'])
				.trim()
			const result = await repo(dir)
				.getFirstParent(blobOid)
			expect(result)
				.toEqual({ kind: 'not-a-commit' })
		})
	})

	// -------------------------------------------------------------------------
	// readTree
	// -------------------------------------------------------------------------

	describe('readTree', () => {
		it('lists the complete recursive tree, including a filename with a space and an NFC non-ASCII name', async () => {
			const dir = initRepo()
			const spacedName = 'my notes.txt'
			const unicodeName = 'café résumé.txt'.normalize('NFC')
			writeTrackedFile(dir, spacedName, 'spaced\n')
			writeTrackedFile(dir, `nested/${unicodeName}`, 'unicode\n')
			writeTrackedFile(dir, 'nested/deep/leaf.txt', 'leaf\n')
			const oid = commitAll(dir, 'first')

			const result = await repo(dir)
				.readTree(oid)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return

			const byPath = new Map(result.entries.map(e => [e.path, e]))
			expect(byPath.get(spacedName))
				.toMatchObject({ type: 'blob' })
			expect(byPath.get(`nested/${unicodeName}`))
				.toMatchObject({ type: 'blob' })
			expect(byPath.get('nested/deep/leaf.txt'))
				.toMatchObject({ type: 'blob' })
			expect(byPath.get('nested'))
				.toMatchObject({ type: 'tree' })
			expect(byPath.get('nested/deep'))
				.toMatchObject({ type: 'tree' })
			for (const entry of result.entries) {
				expect(entry.oid)
					.toMatch(/^[0-9a-f]{40}$/)
				expect(entry.mode)
					.toMatch(/^\d+$/)
			}
		})

		it('reports missing for an OID with no matching object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.readTree('0'.repeat(40))
			expect(result)
				.toEqual({ kind: 'missing' })
		})

		it('reports the raw mode for a symlink entry, unchanged from an ordinary blob\'s mode (Finding 5 foundation: ls-tree reports both as type "blob")', async () => {
			const dir = initRepo()
			const targetBlobOid = hashObjectFromStdin(dir, Buffer.from('irrelevant symlink target text'))
			addCacheinfoEntry(dir, '120000', targetBlobOid, 'a-symlink')
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, 'symlink entry')

			const result = await repo(dir)
				.readTree(commitOid)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			const entry = result.entries.find(e => e.path === 'a-symlink')
			expect(entry)
				.toMatchObject({ mode: '120000', type: 'blob' })
		})

		// ---- Finding 4: invalid UTF-8 path bytes --------------------------------

		it('decodes a raw path containing invalid UTF-8 bytes as a typed invalid-path entry, never a lossy replacement-character string', async () => {
			const dir = initRepo()
			const blobOid = hashObjectFromStdin(dir, Buffer.from('content\n'))
			const invalidPathBytes = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xFF, 0xFE]), Buffer.from('-name.txt')])
			addRawIndexEntry(dir, '100644', blobOid, invalidPathBytes)
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, 'invalid path')

			const result = await repo(dir)
				.readTree(commitOid)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return

			const entry = result.entries.find(e => e.pathValid === false)
			expect(entry)
				.toBeDefined()
			expect(entry!.pathBytes)
				.toEqual(new Uint8Array(invalidPathBytes))
			// Never the lossy `Buffer#toString('utf8')` replacement-character
			// decoding of the same raw bytes (the previous implementation).
			expect(entry!.path)
				.not.toBe(invalidPathBytes.toString('utf8'))
			// Never masquerades as (i.e. is never string-equal to) a genuine,
			// ordinary project path.
			expect(entry!.path)
				.not.toBe('.engineering/ef.yaml')
		})

		it('assigns distinct paths to two byte-distinct invalid paths that the previous lossy decode would have aliased onto the identical replacement-character string', async () => {
			const dir = initRepo()
			const blobOidA = hashObjectFromStdin(dir, Buffer.from('content-a\n'))
			const blobOidB = hashObjectFromStdin(dir, Buffer.from('content-b\n'))
			// Both `0xFF` and `0xFE` are, standing alone, invalid UTF-8 lead
			// bytes; `Buffer#toString('utf8')` replaces each with the identical
			// single U+FFFD character, so the previous implementation's `path`
			// for both entries below would have been the byte-identical string
			// `'same-�name.txt'` -- silently aliasing two DIFFERENT Git
			// blobs onto the same map key in any downstream consumer keyed by
			// `path` (e.g. `application/snapshot.ts`'s `entryKinds`).
			const pathA = Buffer.concat([Buffer.from('same-'), Buffer.from([0xFF]), Buffer.from('name.txt')])
			const pathB = Buffer.concat([Buffer.from('same-'), Buffer.from([0xFE]), Buffer.from('name.txt')])
			expect(pathA.toString('utf8'))
				.toBe(pathB.toString('utf8'))
			addRawIndexEntry(dir, '100644', blobOidA, pathA)
			addRawIndexEntry(dir, '100644', blobOidB, pathB)
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, 'collision')

			const result = await repo(dir)
				.readTree(commitOid)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return

			const invalidEntries = result.entries.filter(e => e.pathValid === false)
			expect(invalidEntries)
				.toHaveLength(2)
			const paths = new Set(invalidEntries.map(e => e.path))
			expect(paths.size)
				.toBe(2)
			const oidsByPath = new Map(invalidEntries.map(e => [e.path, e.oid]))
			expect(new Set(oidsByPath.values()))
				.toEqual(new Set([blobOidA, blobOidB]))
		})
	})

	// -------------------------------------------------------------------------
	// readBlob
	// -------------------------------------------------------------------------

	describe('readBlob', () => {
		it('returns the exact raw bytes of a blob', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'hello\nworld\n')
			commitAll(dir, 'first')
			const blobOid = git(dir, ['rev-parse', 'HEAD:a.txt'])
				.trim()
			const result = await repo(dir)
				.readBlob(blobOid)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind === 'resolved') {
				expect(result.bytes.equals(Buffer.from('hello\nworld\n', 'utf8')))
					.toBe(true)
			}
		})

		it('reports not-a-blob for an OID naming a tree', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const treeOid = git(dir, ['rev-parse', 'HEAD^{tree}'])
				.trim()
			const result = await repo(dir)
				.readBlob(treeOid)
			expect(result)
				.toEqual({ kind: 'not-a-blob', actualType: 'tree' })
		})

		it('reports missing for an OID with no matching object', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.readBlob('0'.repeat(40))
			expect(result)
				.toEqual({ kind: 'missing' })
		})
	})

	// -------------------------------------------------------------------------
	// listFirstParentHistory
	// -------------------------------------------------------------------------

	describe('listFirstParentHistory', () => {
		it('returns the newest-first first-parent sequence and excludes non-first-parent (merged-in) commits', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const main1 = commitAll(dir, 'main1')
			git(dir, ['checkout', '-q', '-b', 'feature'])
			writeTrackedFile(dir, 'feature.txt', 'feature\n')
			const feature1 = commitAll(dir, 'feature1')
			git(dir, ['checkout', '-q', 'main'])
			git(dir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
			const mergeOid = git(dir, ['rev-parse', 'HEAD'])
				.trim()
			writeTrackedFile(dir, 'c.txt', 'c\n')
			const main2 = commitAll(dir, 'main2')

			const result = await repo(dir)
				.listFirstParentHistory(main2)
			expect(result)
				.toEqual({ kind: 'complete', oids: [main2, mergeOid, main1] })
			expect(result.kind === 'complete' && result.oids.includes(feature1))
				.toBe(false)
		})

		it('reports shallow for a shallow clone', async () => {
			const source = initRepo()
			writeTrackedFile(source, 'a.txt', 'a\n')
			commitAll(source, 'first')
			writeTrackedFile(source, 'b.txt', 'b\n')
			commitAll(source, 'second')
			writeTrackedFile(source, 'c.txt', 'c\n')
			const head = commitAll(source, 'third')

			const shallowDir = mkdtempSync(join(tmpdir(), 'ef-git-shallow-'))
			rmSync(shallowDir, { recursive: true, force: true })
			execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallowDir], { stdio: 'pipe' })
			disableBackgroundMaintenance(shallowDir)
			tempDirs.push(shallowDir)

			const result = await repo(shallowDir)
				.listFirstParentHistory(head)
			expect(result)
				.toEqual({ kind: 'shallow' })
		})

		it('reports unresolved for a commitish that does not resolve', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.listFirstParentHistory('refs/heads/does-not-exist')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		// FINDING B regression (same repo-wide-flag defect as
		// `pathExistsInFirstParentHistory`, but reported as more severe: this
		// method used to consult `--is-shallow-repository` *before* even
		// attempting to walk, so a repository-wide shallow boundary on some
		// unrelated branch made every `listFirstParentHistory` call report
		// `shallow` -- even one whose own first-parent chain is completely
		// available and reaches a true root.
		it('reports complete (not shallow) for a commitish whose own first-parent chain is completely available, while an unrelated shallow-fetched branch in the same repository still reports shallow', async () => {
			const shallowSource = initRepo()
			writeTrackedFile(shallowSource, 's1.txt', 's1\n')
			commitAll(shallowSource, 's1')
			writeTrackedFile(shallowSource, 's2.txt', 's2\n')
			const shallowSourceTip = commitAll(shallowSource, 's2')

			const local = initRepo()
			writeTrackedFile(local, 'c1.txt', 'c1\n')
			const completeRoot = commitAll(local, 'c1')
			writeTrackedFile(local, 'c2.txt', 'c2\n')
			const completeTip = commitAll(local, 'c2')

			// Bring in an unrelated shallow-fetched branch: the repository as a
			// whole now has a shallow boundary, but only on `shallow-branch`.
			// `local`'s own `main` (`completeTip`) was never touched by the fetch
			// and its first-parent chain still reaches a true root commit.
			git(local, ['fetch', '-q', '--depth', '1', `file://${shallowSource}`, `main:refs/heads/shallow-branch`])
			expect(git(local, ['rev-parse', '--is-shallow-repository'])
				.trim())
				.toBe('true')

			const completeResult = await repo(local)
				.listFirstParentHistory(completeTip)
			expect(completeResult)
				.toEqual({ kind: 'complete', oids: [completeTip, completeRoot] })

			const shallowResult = await repo(local)
				.listFirstParentHistory(shallowSourceTip)
			expect(shallowResult)
				.toEqual({ kind: 'shallow' })
		})
	})

	// -------------------------------------------------------------------------
	// pathExistsInFirstParentHistory
	// -------------------------------------------------------------------------

	describe('pathExistsInFirstParentHistory', () => {
		it('finds a path present in an ancestor tree (bootstrap positive case)', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, '.engineering/ef.yaml', 'schema: ef/config@1\n')
			const bootstrapOid = commitAll(dir, 'bootstrap')
			writeTrackedFile(dir, 'other.txt', 'x\n')
			const head = commitAll(dir, 'later')

			// The file is untouched by the later commit, so it persists unchanged
			// in every subsequent tree too; either commit legitimately satisfies
			// "some first-parent ancestor's tree contains this path".
			const result = await repo(dir)
				.pathExistsInFirstParentHistory(head, '.engineering/ef.yaml')
			expect(result.kind)
				.toBe('found')
			if (result.kind === 'found') {
				expect([bootstrapOid, head])
					.toContain(result.commitOid)
			}
		})

		it('reports not-found when no first-parent ancestor tree contains the path', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const head = commitAll(dir, 'first')

			const result = await repo(dir)
				.pathExistsInFirstParentHistory(head, '.engineering/ef.yaml')
			expect(result)
				.toEqual({ kind: 'not-found' })
		})

		it('reports unresolved for a startOid that does not resolve', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'first')
			const result = await repo(dir)
				.pathExistsInFirstParentHistory('refs/heads/does-not-exist', '.engineering/ef.yaml')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		it('does not find a path introduced only on a non-first-parent (merged-in) branch', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			commitAll(dir, 'main1')
			git(dir, ['checkout', '-q', '-b', 'feature'])
			writeTrackedFile(dir, '.engineering/ef.yaml', 'schema: ef/config@1\n')
			commitAll(dir, 'feature1')
			git(dir, ['checkout', '-q', 'main'])
			// `-s ours` (the whole-merge strategy, not `-X ours` conflict resolution)
			// records feature as a parent but keeps the resulting tree identical to
			// main's, so .engineering/ef.yaml never enters any first-parent tree.
			git(dir, ['merge', '-q', '-s', 'ours', '-m', 'merge feature (ours)', 'feature'])
			const head = git(dir, ['rev-parse', 'HEAD'])
				.trim()

			const result = await repo(dir)
				.pathExistsInFirstParentHistory(head, '.engineering/ef.yaml')
			expect(result)
				.toEqual({ kind: 'not-found' })
		})

		it('reports shallow (not not-found) when the path is absent from the visible history of a shallow clone but was present in a hidden ancestor', async () => {
			// The bootstrap history condition (09-validation.md "Bootstrap
			// exception") requires proving absence over *complete* history. A
			// shallow clone's visible first-parent chain silently stops at the
			// shallow boundary: the path existed in an early commit that the
			// shallow clone never fetched, and was removed before the tip, so
			// the visible history alone would wrongly look clean.
			const source = initRepo()
			writeTrackedFile(source, '.engineering/ef.yaml', 'schema: ef/config@1\n')
			commitAll(source, 'bootstrap (hidden ancestor)')
			execFileSync('git', ['rm', '-q', '.engineering/ef.yaml'], { cwd: source })
			const head = commitAll(source, 'remove ef.yaml before the shallow boundary')

			const shallowDir = mkdtempSync(join(tmpdir(), 'ef-git-shallow-path-'))
			rmSync(shallowDir, { recursive: true, force: true })
			execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallowDir], { stdio: 'pipe' })
			disableBackgroundMaintenance(shallowDir)
			tempDirs.push(shallowDir)
			tempDirs.push(source)

			const result = await repo(shallowDir)
				.pathExistsInFirstParentHistory(head, '.engineering/ef.yaml')
			expect(result)
				.toEqual({ kind: 'shallow' })
		})

		it('still reports found in a shallow clone when the path is present in the visible tip tree (no need to consult hidden history)', async () => {
			const source = initRepo()
			writeTrackedFile(source, '.engineering/ef.yaml', 'schema: ef/config@1\n')
			const head = commitAll(source, 'bootstrap')

			const shallowDir = mkdtempSync(join(tmpdir(), 'ef-git-shallow-path-found-'))
			rmSync(shallowDir, { recursive: true, force: true })
			execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallowDir], { stdio: 'pipe' })
			disableBackgroundMaintenance(shallowDir)
			tempDirs.push(shallowDir)
			tempDirs.push(source)

			const result = await repo(shallowDir)
				.pathExistsInFirstParentHistory(head, '.engineering/ef.yaml')
			expect(result)
				.toEqual({ kind: 'found', commitOid: head })
		})

		// FINDING B regression: `--is-shallow-repository` is true whenever ANY
		// shallow boundary exists anywhere in the repository, even on a branch
		// unrelated to the one being walked. A repository can still have a
		// fully available first-parent chain for a *different* branch; wrongly
		// concluding `shallow` purely from the repo-wide flag blocks a valid
		// bootstrap/init on that complete branch.
		it('reports not-found (not shallow) for a complete branch reaching a true root, while an unrelated shallow-fetched branch in the same repository still reports shallow', async () => {
			const shallowSource = initRepo()
			writeTrackedFile(shallowSource, 's1.txt', 's1\n')
			commitAll(shallowSource, 's1')
			writeTrackedFile(shallowSource, 's2.txt', 's2\n')
			const shallowSourceTip = commitAll(shallowSource, 's2')

			const local = initRepo()
			writeTrackedFile(local, 'c1.txt', 'c1\n')
			commitAll(local, 'c1')
			writeTrackedFile(local, 'c2.txt', 'c2\n')
			const completeTip = commitAll(local, 'c2')

			// Bring in an unrelated shallow-fetched branch: the repository as a
			// whole now has a shallow boundary, but only on `shallow-branch`.
			// `local`'s own `main` (`completeTip`) was never touched by the fetch
			// and its first-parent chain still reaches a true root commit.
			git(local, ['fetch', '-q', '--depth', '1', `file://${shallowSource}`, `main:refs/heads/shallow-branch`])
			expect(git(local, ['rev-parse', '--is-shallow-repository'])
				.trim())
				.toBe('true')

			const completeResult = await repo(local)
				.pathExistsInFirstParentHistory(completeTip, 'nonexistent-path.txt')
			expect(completeResult)
				.toEqual({ kind: 'not-found' })

			const shallowResult = await repo(local)
				.pathExistsInFirstParentHistory(shallowSourceTip, 'nonexistent-path.txt')
			expect(shallowResult)
				.toEqual({ kind: 'shallow' })
		})
	})

	// -------------------------------------------------------------------------
	// diffTrees
	// -------------------------------------------------------------------------

	describe('diffTrees', () => {
		it('reports added, modified, and deleted paths with renames disabled', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'keep.txt', 'unchanged\n')
			writeTrackedFile(dir, 'modify.txt', 'before\n')
			writeTrackedFile(dir, 'remove.txt', 'gone\n')
			const before = commitAll(dir, 'before')

			writeTrackedFile(dir, 'modify.txt', 'after\n')
			rmSync(join(dir, 'remove.txt'))
			writeTrackedFile(dir, 'add.txt', 'new\n')
			const after = commitAll(dir, 'after')

			const result = await repo(dir)
				.diffTrees(before, after)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			const byPath = new Map(result.entries.map(e => [e.path, e.status]))
			expect(byPath.get('add.txt'))
				.toBe('A')
			expect(byPath.get('modify.txt'))
				.toBe('M')
			expect(byPath.get('remove.txt'))
				.toBe('D')
			expect(byPath.has('keep.txt'))
				.toBe(false)
		})

		it('reports a full-file rewrite as delete+add rather than a rename, given --no-renames', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'source-name.txt', 'identical content for rename detection\n'.repeat(20))
			const before = commitAll(dir, 'before')
			rmSync(join(dir, 'source-name.txt'))
			writeTrackedFile(dir, 'renamed-name.txt', 'identical content for rename detection\n'.repeat(20))
			const after = commitAll(dir, 'after')

			const result = await repo(dir)
				.diffTrees(before, after)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			const byPath = new Map(result.entries.map(e => [e.path, e.status]))
			expect(byPath.get('source-name.txt'))
				.toBe('D')
			expect(byPath.get('renamed-name.txt'))
				.toBe('A')
		})

		it('reports invalid-object when an oid does not resolve', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const before = commitAll(dir, 'first')
			const result = await repo(dir)
				.diffTrees(before, '0'.repeat(40))
			expect(result)
				.toEqual({ kind: 'invalid-object' })
		})

		it('decodes an added path containing invalid UTF-8 bytes as a typed invalid-path entry, never a lossy replacement-character string (Finding 4)', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const before = commitAll(dir, 'before')

			const blobOid = hashObjectFromStdin(dir, Buffer.from('content\n'))
			const invalidPathBytes = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xFF, 0xFE]), Buffer.from('-name.txt')])
			// The index already reflects `before`'s tree exactly (`commitAll`
			// just committed it); adding one more raw-byte entry on top makes
			// the next `write-tree` produce `before`'s tree plus this addition.
			addRawIndexEntry(dir, '100644', blobOid, invalidPathBytes)
			const afterTreeOid = writeTreeOid(dir)
			const after = commitTreeOid(dir, afterTreeOid, 'invalid path added')

			const result = await repo(dir)
				.diffTrees(before, after)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return

			const entry = result.entries.find(e => e.pathValid === false)
			expect(entry)
				.toMatchObject({ status: 'A' })
			expect(entry!.pathBytes)
				.toEqual(new Uint8Array(invalidPathBytes))
			expect(entry!.path)
				.not.toBe(invalidPathBytes.toString('utf8'))
		})
	})

	// -------------------------------------------------------------------------
	// checkCapabilities
	// -------------------------------------------------------------------------

	describe('checkCapabilities', () => {
		it('reports availability, version, and probed plumbing-flag support against a real repository', async () => {
			const dir = initRepo()
			tempDirs.push(dir)
			const result = await checkCapabilities(executor, dir)
			expect(result.available)
				.toBe(true)
			expect(result.version)
				.toMatch(/^\d+\.\d+/)
			expect(result.showObjectFormat)
				.toBe(true)
			expect(result.isShallowRepository)
				.toBe(true)
		})

		it('reports unavailable without probing plumbing flags when the Git executable is missing', async () => {
			const brokenExecutor = createGitExecutor({ gitPath: '/nonexistent/ef-test-git-binary-xyz' })
			const result = await checkCapabilities(brokenExecutor)
			expect(result)
				.toEqual({ available: false, version: null, showObjectFormat: false, isShallowRepository: false })
		})

		it('reports version without probing plumbing flags when no root is supplied', async () => {
			const result = await checkCapabilities(executor)
			expect(result.available)
				.toBe(true)
			expect(result.showObjectFormat)
				.toBe(false)
			expect(result.isShallowRepository)
				.toBe(false)
		})
	})

	// -------------------------------------------------------------------------
	// git-unavailable propagation and other executor-outcome edge branches
	//
	// These use a scripted executor (see `scriptedExecutor` above) because
	// they depend on one specific plumbing call in a multi-call method
	// succeeding while a later call in the same method fails, which cannot be
	// reliably contrived against a real `git` process.
	// -------------------------------------------------------------------------

	describe('propagating a failed executor outcome', () => {
		it('getObjectFormat propagates git-unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.getObjectFormat()
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('getObjectFormat reports unsupported for a non-zero exit (older Git rejecting the flag)', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('', 1)]))
				.getObjectFormat()
			expect(result)
				.toEqual({ kind: 'unsupported' })
		})

		it('getObjectFormat reports unsupported for an unrecognized format value', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('sha384\n')]))
				.getObjectFormat()
			expect(result)
				.toEqual({ kind: 'unsupported' })
		})

		it('resolveCommit propagates git-unavailable from getObjectFormat', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.resolveCommit('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('resolveCommit reports malformed when the object format itself is unsupported', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('', 1)]))
				.resolveCommit('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'malformed', oid: 'a'.repeat(40) })
		})

		it('resolveCommit propagates git-unavailable from the cat-file type check', async () => {
			const oid = 'a'.repeat(40)
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('sha1'), abortedOutcome()]))
				.resolveCommit(oid)
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'git command was aborted' })
		})

		it('resolveRef propagates git-unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([outputLimitOutcome()]))
				.resolveRef('refs/heads/main')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'git output on stdout exceeded 10 bytes' })
		})

		it('resolveRef reports error (not proven-absent) when show-ref exits 0 with blank, unparseable output', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('   ')]))
				.resolveRef('refs/heads/main')
			expect(result.kind)
				.toBe('error')
		})

		it('getFirstParent propagates git-unavailable from the cat-file type check', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.getFirstParent('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('getFirstParent propagates git-unavailable from the commit body fetch', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('commit'), unavailableOutcome('no git')]))
				.getFirstParent('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		// FINDING (repository.ts getFirstParent): the type check just proved the
		// commit exists; a non-zero, non-`git-unavailable` exit from the body
		// fetch now is an execution/read error on an object already known to
		// exist, never proof the commit itself is missing. Folding this into
		// `missing` would let a caller treat a real read failure as though the
		// commit does not exist.
		it('getFirstParent reports error (not missing) when the commit type check succeeds but the body fetch fails', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('commit'), okOutcome('', 1)]))
				.getFirstParent('a'.repeat(40))
			expect(result.kind)
				.toBe('error')
			expect(result.kind === 'error' && result.message)
				.toContain('cat-file -p')
		})

		it('readTree propagates git-unavailable from the existence check', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.readTree('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('readTree propagates git-unavailable from the ls-tree call', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('commit'), unavailableOutcome('no git')]))
				.readTree('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('readTree reports missing when the existence check itself fails (exit 1)', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('', 1)]))
				.readTree('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'missing' })
		})

		// FINDING (repository.ts readTree): `cat-file -t` already proved the
		// commit exists; a non-zero, non-`git-unavailable` exit from `ls-tree`
		// now is an execution/read error on an object already known to exist,
		// never proof the commit itself is missing.
		it('readTree reports error (not missing) when the existence check succeeds but ls-tree fails', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('commit'), okOutcome('', 128)]))
				.readTree('a'.repeat(40))
			expect(result.kind)
				.toBe('error')
			expect(result.kind === 'error' && result.message)
				.toContain('ls-tree')
		})

		it('readBlob propagates git-unavailable from the cat-file type check', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.readBlob('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('readBlob propagates git-unavailable from the content fetch', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('blob'), unavailableOutcome('no git')]))
				.readBlob('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		// FINDING (repository.ts readBlob): the type check just proved the blob
		// exists; a non-zero, non-`git-unavailable` exit from the content fetch
		// now is an execution/read error on an object already known to exist,
		// never proof the blob itself is missing.
		it('readBlob reports error (not missing) when the blob type check succeeds but the content fetch fails', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('blob'), okOutcome('', 1)]))
				.readBlob('a'.repeat(40))
			expect(result.kind)
				.toBe('error')
			expect(result.kind === 'error' && result.message)
				.toContain('cat-file -p')
		})

		it('listFirstParentHistory propagates git-unavailable from rev-list', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.listFirstParentHistory('main')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('listFirstParentHistory propagates git-unavailable from the post-walk boundary cat-file check', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), unavailableOutcome('no git')]))
				.listFirstParentHistory('main')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('pathExistsInFirstParentHistory propagates git-unavailable from rev-list', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('pathExistsInFirstParentHistory propagates git-unavailable from an in-loop ls-tree call', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), unavailableOutcome('no git')]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('pathExistsInFirstParentHistory propagates git-unavailable from the post-loop shallow check', async () => {
			// The ls-tree call reports a legitimate "path absent at this
			// commit" outcome (exit 0, empty stdout, matching real Git
			// behavior) so the walk reaches the post-loop shallow check.
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), okOutcome(''), unavailableOutcome('no git')]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		// FINDING (repository.ts pathExistsInFirstParentHistory): a non-zero,
		// non-`git-unavailable` `ls-tree` exit is a Git execution/read error --
		// real Git exits `0` with empty output for a legitimately absent
		// path -- so it must never be folded into "no match, keep walking"
		// and allowed to fall through to `not-found`.
		it('pathExistsInFirstParentHistory reports unresolved (not not-found) when an in-loop ls-tree call exits non-zero without being unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), okOutcome('', 128), okOutcome('false\n')]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		// FINDING (repository.ts pathExistsInFirstParentHistory): a non-zero,
		// non-`git-unavailable` `rev-parse --is-shallow-repository` exit is
		// folded into `repositoryHasAnyShallowBoundary === false`, so a
		// probe that could not even run is treated the same as a proven
		// non-shallow repository and falls through to `not-found`.
		it('pathExistsInFirstParentHistory reports unresolved (not not-found) when the post-loop shallow-repository probe exits non-zero without being unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), okOutcome(''), okOutcome('', 128)]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		// Audit-driven (same pattern as the two findings above): a non-zero,
		// non-`git-unavailable` exit from the boundary `cat-file` re-inspection
		// is a Git execution/read error on a commit `rev-list` itself just
		// reported as existing, not proof of a shallow boundary; it must be
		// reported as unresolved rather than asserting the specific (and
		// here unproven) `shallow` conclusion.
		it('pathExistsInFirstParentHistory reports unresolved (not shallow) when the final boundary cat-file re-inspection exits non-zero without being unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), okOutcome(''), okOutcome('true\n'), okOutcome('', 128)]))
				.pathExistsInFirstParentHistory('main', 'x')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		// Audit-driven (same pattern; `listFirstParentHistory`'s own
		// post-walk boundary check has the identical fallback).
		it('listFirstParentHistory reports unresolved (not shallow) when the post-walk boundary cat-file check exits non-zero without being unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('abc123\n'), okOutcome('', 128)]))
				.listFirstParentHistory('main')
			expect(result)
				.toEqual({ kind: 'unresolved' })
		})

		it('diffTrees propagates git-unavailable', async () => {
			const result = await createGitRepository('/r', scriptedExecutor([unavailableOutcome('no git')]))
				.diffTrees('a'.repeat(40), 'b'.repeat(40))
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('findWorktreeRoot (standalone) propagates git-unavailable', async () => {
			const result = await findWorktreeRoot(scriptedExecutor([unavailableOutcome('no git')]), '/some/path')
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'no git' })
		})

		it('getFirstParent falls back to the whole body when no blank header/message separator is present', async () => {
			// Real commit objects always have a blank line between the header and
			// the message; this exercises the defensive fallback for malformed
			// input that lacks one.
			const result = await createGitRepository('/r', scriptedExecutor([okOutcome('commit'), okOutcome('tree deadbeef')]))
				.getFirstParent('a'.repeat(40))
			expect(result)
				.toEqual({ kind: 'root-commit' })
		})

		it('checkCapabilities reports a null version when the --version output does not match the expected shape', async () => {
			const result = await checkCapabilities(scriptedExecutor([okOutcome('not a version string')]))
			expect(result)
				.toEqual({ available: true, version: null, showObjectFormat: false, isShallowRepository: false })
		})
	})

	// -------------------------------------------------------------------------
	// Sanitized environment
	// -------------------------------------------------------------------------

	describe('environment sanitization', () => {
		it('does not leak a poisoned parent GIT_DIR into repository resolution', async () => {
			const dir = initRepo()
			writeTrackedFile(dir, 'a.txt', 'a\n')
			const oid = commitAll(dir, 'first')

			const poisoned = mkdtempSync(join(tmpdir(), 'ef-git-poison-'))
			git(poisoned, ['init', '-q', '-b', 'main'])

			const previousGitDir = process.env.GIT_DIR
			process.env.GIT_DIR = join(poisoned, '.git')
			try {
				const result = await repo(dir)
					.resolveRef('refs/heads/main')
				expect(result)
					.toEqual({ kind: 'resolved', oid })
			}
			finally {
				if (previousGitDir === undefined)
					delete process.env.GIT_DIR
				else
					process.env.GIT_DIR = previousGitDir
				rmSync(poisoned, { recursive: true, force: true })
			}
		})
	})
})
