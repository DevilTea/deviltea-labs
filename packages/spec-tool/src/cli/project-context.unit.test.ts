import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSnapshotFromWorkingTree } from '../application/snapshot'
import { createGitExecutor } from '../git/executor'
import { findWorktreeRoot } from '../git/repository'
import { checkWorkingDirectoryAssociation } from '../repository/discovery'
import { resolveProject } from './project-context'

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

describe('resolveProject', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-ctx-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	it('resolves a real initialized project by ascending from a nested cwd', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n',
		)
		const nested = path.join(tempDir, 'sub', 'dir')
		await fs.mkdir(nested, { recursive: true })

		const result = await resolveProject({ cwd: nested }, createGitExecutor())

		expect(result.ok)
			.toBe(true)
		expect(result.ok && result.context.root)
			.toBe(tempDir)
		expect(result.ok && result.context.config?.repository.integrationRef)
			.toBe('refs/heads/main')
	})

	it('reports not-found when no .engineering exists anywhere above cwd', async () => {
		initGitFixture(tempDir)
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-found')
	})

	it('reports incomplete-initialization when ef.yaml is absent from an existing .engineering directory', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('incomplete-initialization')
	})

	it('honors an explicit --project root even when cwd is elsewhere', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n',
		)
		const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-ctx-elsewhere-')))
		try {
			const result = await resolveProject({ cwd: elsewhere, explicitProject: tempDir }, createGitExecutor())
			expect(result.ok)
				.toBe(true)
			expect(result.ok && result.context.root)
				.toBe(tempDir)
		}
		finally {
			await fs.rm(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('reports not-a-directory when .engineering exists as a plain file', async () => {
		initGitFixture(tempDir)
		await fs.writeFile(path.join(tempDir, '.engineering'), 'not a directory')
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-a-directory')
	})

	it('reports read-error when ef.yaml exists as a directory instead of a file', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.mkdir(path.join(tempDir, '.engineering', 'ef.yaml'))
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
	})

	it('reports not-project-worktree-root when .engineering is found below the Git worktree root', async () => {
		initGitFixture(tempDir)
		const sub = path.join(tempDir, 'sub')
		await fs.mkdir(path.join(sub, '.engineering'), { recursive: true })
		await fs.writeFile(
			path.join(sub, '.engineering', 'ef.yaml'),
			'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n',
		)
		const result = await resolveProject({ cwd: sub }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-project-worktree-root')
		expect(result.ok === false && result.root)
			.toBe(sub)
	})

	it('reports unassociated when cwd sits inside a nested, undeclared Git worktree', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n',
		)
		const nestedRepo = path.join(tempDir, 'linked')
		await fs.mkdir(nestedRepo)
		initGitFixture(nestedRepo)

		const result = await resolveProject({ cwd: nestedRepo }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('unassociated')
	})

	it('propagates git-unavailable from discovery without throwing', async () => {
		const unavailableExecutor = {
			exec: async () => ({ ok: false as const, failure: { kind: 'unavailable' as const, message: 'git is not installed' } }),
			execIn: async () => ({ ok: false as const, failure: { kind: 'unavailable' as const, message: 'git is not installed' } }),
		}
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')

		const result = await resolveProject({ cwd: tempDir }, unavailableExecutor)
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('git-unavailable')
	})

	// ---- Finding 5: an in-place ef.yaml rewrite between discovery's own ------
	// ---- association decision and a later snapshot load ----------------------

	// `discoverProject`'s own implicit-association decision (`resolveProject`
	// here) is made against its OWN, first read of `ef.yaml` (config A, which
	// declares `linked` as a linked repository, so `cwd` inside it resolves).
	// An in-place rewrite to config B (no linked repositories at all) landing
	// immediately afterward means the CURRENT, authoritative state of the
	// project no longer associates this `cwd` with it at all. `resolveProject`
	// itself cannot re-observe this (it already returned); the fix (Finding 5)
	// is that a caller which goes on to load a snapshot -- the single,
	// freshest config observation every command semantic must derive from,
	// per `ProjectContext.config`'s own doc -- re-runs the EXACT association
	// decision against THAT config via the exported, reusable
	// `checkWorkingDirectoryAssociation` (extracted from `discoverProject`
	// verbatim), rather than trusting discovery's now-stale `associated`
	// verdict.
	it('re-running the association decision against a snapshot load\'s fresher config reverses a stale verdict after ef.yaml is rewritten in place', async () => {
		initGitFixture(tempDir)
		await fs.mkdir(path.join(tempDir, '.engineering'))
		const configA = 'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories:\n  - id: linked\n    path: linked\n    role: implementation\n    required: true\nschemas:\n  artifact_write_major: 1\n'
		const configB = 'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n'
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), configA)

		const linkedDir = path.join(tempDir, 'linked')
		await fs.mkdir(linkedDir)
		initGitFixture(linkedDir)

		const executor = createGitExecutor()
		const resolved = await resolveProject({ cwd: linkedDir }, executor)
		expect(resolved.ok)
			.toBe(true)
		if (!resolved.ok)
			return
		// Discovery's own (now stale) read associated `linkedDir` via config A's
		// declared linked repository.
		expect(resolved.context.config?.linkedRepositories)
			.toHaveLength(1)

		// The in-place rewrite: config B declares no linked repositories at all.
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), configB)

		const loaded = await loadSnapshotFromWorkingTree(resolved.context.root)
		expect(loaded.ok)
			.toBe(true)
		if (!loaded.ok)
			return
		// The snapshot's own, freshest read reflects the rewrite.
		expect(loaded.snapshot.config.config?.linkedRepositories)
			.toEqual([])

		const association = await checkWorkingDirectoryAssociation(
			{ cwd: linkedDir, candidateRoot: resolved.context.root, config: loaded.snapshot.config.config },
			{ findWorktreeRoot: absolutePath => findWorktreeRoot(executor, absolutePath) },
		)
		// Re-running the decision against the snapshot's fresher config reverses
		// discovery's own, now-stale `associated` verdict: `linkedDir` is no
		// longer declared by the CURRENT, authoritative configuration.
		expect(association)
			.toEqual({ kind: 'unassociated' })
	})
})
