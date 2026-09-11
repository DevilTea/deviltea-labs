import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor, sanitizeGitEnv } from './executor'

/**
 * Initializes a fixture Git repository at `dir`, then disables background
 * maintenance (`gc --auto`'s detached repack, and `maintenance.auto`'s
 * scheduled runs): a stray background process can still be writing
 * `.git/objects/pack` when this file's teardown removes the fixture, racing
 * the rmdir and intermittently failing with `ENOTEMPTY` (observed in CI).
 * Disabling it right after `init` removes the writer instead of just
 * tolerating the race.
 */
function initGitFixture(dir: string): void {
	execFileSync('git', ['init', '-q', '-b', 'main', dir])
	execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
	execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
	execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
}

describe('sanitizeGitEnv', () => {
	it('strips the fixed repository-selecting Git variables', () => {
		const result = sanitizeGitEnv({
			GIT_DIR: '/poison/.git',
			GIT_WORK_TREE: '/poison',
			GIT_COMMON_DIR: '/poison/.git',
			GIT_INDEX_FILE: '/poison/.git/index',
			GIT_OBJECT_DIRECTORY: '/poison/.git/objects',
			GIT_ALTERNATE_OBJECT_DIRECTORIES: '/poison/.git/alt',
			GIT_NAMESPACE: 'poison',
			PATH: '/usr/bin',
		})

		expect(result.GIT_DIR)
			.toBeUndefined()
		expect(result.GIT_WORK_TREE)
			.toBeUndefined()
		expect(result.GIT_COMMON_DIR)
			.toBeUndefined()
		expect(result.GIT_INDEX_FILE)
			.toBeUndefined()
		expect(result.GIT_OBJECT_DIRECTORY)
			.toBeUndefined()
		expect(result.GIT_ALTERNATE_OBJECT_DIRECTORIES)
			.toBeUndefined()
		expect(result.GIT_NAMESPACE)
			.toBeUndefined()
		expect(result.PATH)
			.toBe('/usr/bin')
	})

	it('strips dynamic GIT_CONFIG_COUNT/KEY_*/VALUE_* overrides but keeps unrelated GIT_CONFIG-like names', () => {
		const result = sanitizeGitEnv({
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'user.name',
			GIT_CONFIG_VALUE_0: 'Poison',
			GIT_CONFIG_KEY_12: 'user.email',
			GIT_CONFIG_VALUE_12: 'poison@example.com',
			GIT_CONFIG_NOSYSTEM: '1',
		})

		expect(result.GIT_CONFIG_COUNT)
			.toBeUndefined()
		expect(result.GIT_CONFIG_KEY_0)
			.toBeUndefined()
		expect(result.GIT_CONFIG_VALUE_0)
			.toBeUndefined()
		expect(result.GIT_CONFIG_KEY_12)
			.toBeUndefined()
		expect(result.GIT_CONFIG_VALUE_12)
			.toBeUndefined()
		expect(result.GIT_CONFIG_NOSYSTEM)
			.toBe('1')
	})

	it('forces the fixed diagnostic/behavior variables even when the base overrides them', () => {
		const result = sanitizeGitEnv({
			GIT_TERMINAL_PROMPT: '1',
			GIT_NO_REPLACE_OBJECTS: '0',
			GIT_OPTIONAL_LOCKS: '1',
			GIT_PAGER: 'less',
			PAGER: 'less',
			LC_ALL: 'en_US.UTF-8',
		})

		expect(result)
			.toMatchObject({
				GIT_TERMINAL_PROMPT: '0',
				GIT_NO_REPLACE_OBJECTS: '1',
				GIT_OPTIONAL_LOCKS: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				LC_ALL: 'C',
			})
	})

	it('drops keys whose base value is undefined without throwing', () => {
		const result = sanitizeGitEnv({ FOO: undefined, BAR: 'baz' })
		expect(result.FOO)
			.toBeUndefined()
		expect(result.BAR)
			.toBe('baz')
	})
})

describe('createGitExecutor', () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'ef-git-executor-'))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	it('runs a repository-independent command and returns stdout, exit code, and null signal', async () => {
		const executor = createGitExecutor()
		const outcome = await executor.exec(['--version'])

		expect(outcome.ok)
			.toBe(true)
		if (!outcome.ok)
			return
		expect(outcome.result.exitCode)
			.toBe(0)
		expect(outcome.result.signal)
			.toBeNull()
		expect(outcome.result.stdout.toString('utf8'))
			.toMatch(/^git version /)
		expect(Buffer.isBuffer(outcome.result.stderr))
			.toBe(true)
	})

	it('does not throw on a non-zero Git exit code; it is ordinary result data', async () => {
		const executor = createGitExecutor()
		const outcome = await executor.exec(['not-a-real-git-subcommand'])

		expect(outcome.ok)
			.toBe(true)
		if (!outcome.ok)
			return
		expect(outcome.result.exitCode).not.toBe(0)
		expect(outcome.result.stderr.length)
			.toBeGreaterThan(0)
	})

	it('prepends -C <root> for execIn so the result reflects the given root, not process.cwd()', async () => {
		initGitFixture(tempDir)
		const executor = createGitExecutor()

		// The test process cwd (inside this monorepo) is itself a Git worktree
		// different from tempDir. execIn must report tempDir's toplevel, not the
		// cwd's, which proves -C <root> was actually applied.
		const cwdOutcome = await executor.exec(['rev-parse', '--show-toplevel'])
		expect(cwdOutcome.ok)
			.toBe(true)
		const cwdRoot = cwdOutcome.ok
			? cwdOutcome.result.stdout.toString('utf8')
					.trim()
			: ''

		const rootedOutcome = await executor.execIn(tempDir, ['rev-parse', '--show-toplevel'])
		expect(rootedOutcome.ok)
			.toBe(true)
		if (!rootedOutcome.ok)
			return
		expect(rootedOutcome.result.exitCode)
			.toBe(0)
		const reportedRoot = rootedOutcome.result.stdout.toString('utf8')
			.trim()
		expect(reportedRoot).not.toBe(cwdRoot)
		expect(reportedRoot.endsWith(tempDir.split('/')
			.pop()!))
			.toBe(true)
	})

	it('returns a typed unavailable failure when the Git executable cannot be found', async () => {
		const executor = createGitExecutor({ gitPath: '/nonexistent/ef-test-git-binary-xyz' })
		const outcome = await executor.exec(['--version'])

		expect(outcome.ok)
			.toBe(false)
		if (outcome.ok)
			return
		expect(outcome.failure.kind)
			.toBe('unavailable')
	})

	it('returns a typed unavailable failure when spawn itself throws synchronously', async () => {
		// An empty executable name makes Node's spawn throw synchronously
		// (before any 'error' event), exercising the executor's own try/catch
		// around spawn rather than the asynchronous ENOENT path above.
		const executor = createGitExecutor({ gitPath: '' })
		const outcome = await executor.exec(['--version'])

		expect(outcome.ok)
			.toBe(false)
		if (outcome.ok)
			return
		expect(outcome.failure.kind)
			.toBe('unavailable')
	})

	it('kills the child and resolves aborted when the signal fires after the child has already started', async () => {
		const executor = createGitExecutor()
		const controller = new AbortController()

		// The Promise executor (including spawn and the abort-listener
		// registration) runs synchronously, so aborting on the very next line,
		// before awaiting, reliably races ahead of the child's natural exit.
		const promise = executor.exec(['--version'], { signal: controller.signal })
		controller.abort()

		const outcome = await promise
		expect(outcome)
			.toEqual({ ok: false, failure: { kind: 'aborted' } })
	})

	it('kills the child and reports output-limit-exceeded once stdout exceeds the configured limit', async () => {
		const executor = createGitExecutor()
		const outcome = await executor.exec(['--version'], { maxOutputBytes: 3 })

		expect(outcome.ok)
			.toBe(false)
		if (outcome.ok)
			return
		expect(outcome.failure)
			.toEqual({ kind: 'output-limit-exceeded', stream: 'stdout', limitBytes: 3 })
	})

	it('reports output-limit-exceeded for stderr, independent of the stdout limit check', async () => {
		const executor = createGitExecutor()
		// A real, deterministic Git error: the "not a git command" message on
		// stderr is comfortably longer than the 3-byte limit.
		const outcome = await executor.exec(['not-a-real-git-subcommand'], { maxOutputBytes: 3 })

		expect(outcome.ok)
			.toBe(false)
		if (outcome.ok)
			return
		expect(outcome.failure)
			.toEqual({ kind: 'output-limit-exceeded', stream: 'stderr', limitBytes: 3 })
	})

	it('ignores stdout/stderr data that arrives after the outcome has already settled', async () => {
		// Points the executor at a small standalone Node script (a real spawned
		// process, using the documented `gitPath` override seam) that writes a
		// first burst to stdout, then - after the executor has already settled
		// on output-limit-exceeded and sent SIGTERM - ignores that signal and
		// writes a second burst to both stdout and stderr before exiting on its
		// own. The executor must still resolve exactly once, with only the
		// first burst's outcome, proving the late data is safely dropped.
		const script = [
			'process.on(\'SIGTERM\', () => {})',
			'process.stdout.write(\'A\'.repeat(5000))',
			'setTimeout(() => {',
			'  process.stdout.write(\'C\'.repeat(5000))',
			'  process.stderr.write(\'D\'.repeat(5000))',
			'  process.exit(0)',
			'}, 30)',
		].join('\n')
		const executor = createGitExecutor({ gitPath: process.execPath })

		const outcome = await executor.exec(['-e', script], { maxOutputBytes: 10 })

		expect(outcome.ok)
			.toBe(false)
		if (outcome.ok)
			return
		expect(outcome.failure)
			.toEqual({ kind: 'output-limit-exceeded', stream: 'stdout', limitBytes: 10 })
	})

	it('resolves aborted without spawning when the signal is already aborted', async () => {
		const executor = createGitExecutor()
		const controller = new AbortController()
		controller.abort()

		const outcome = await executor.exec(['--version'], { signal: controller.signal })

		expect(outcome)
			.toEqual({ ok: false, failure: { kind: 'aborted' } })
	})

	it('sanitizes a poisoned parent GIT_DIR so it cannot redirect execIn to another repository', async () => {
		initGitFixture(tempDir)
		const poisonedDir = mkdtempSync(join(tmpdir(), 'ef-git-executor-poison-'))
		initGitFixture(poisonedDir)

		const previousGitDir = process.env.GIT_DIR
		process.env.GIT_DIR = join(poisonedDir, '.git')
		try {
			const executor = createGitExecutor()
			const outcome = await executor.execIn(tempDir, ['rev-parse', '--show-toplevel'])
			expect(outcome.ok)
				.toBe(true)
			if (!outcome.ok)
				return
			const root = outcome.result.stdout.toString('utf8')
				.trim()
			expect(root.endsWith(tempDir.split('/')
				.pop()!))
				.toBe(true)
			expect(root).not.toBe(poisonedDir)
		}
		finally {
			if (previousGitDir === undefined)
				delete process.env.GIT_DIR
			else
				process.env.GIT_DIR = previousGitDir
			rmSync(poisonedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})
