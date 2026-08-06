import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { resolveProject } from './project-context'

describe('resolveProject', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-ctx-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('resolves a real initialized project by ascending from a nested cwd', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
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
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-found')
	})

	it('reports incomplete-initialization when ef.yaml is absent from an existing .engineering directory', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
		await fs.mkdir(path.join(tempDir, '.engineering'))
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('incomplete-initialization')
	})

	it('honors an explicit --project root even when cwd is elsewhere', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
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
			await fs.rm(elsewhere, { recursive: true, force: true })
		}
	})

	it('reports not-a-directory when .engineering exists as a plain file', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
		await fs.writeFile(path.join(tempDir, '.engineering'), 'not a directory')
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-a-directory')
	})

	it('reports read-error when ef.yaml exists as a directory instead of a file', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.mkdir(path.join(tempDir, '.engineering', 'ef.yaml'))
		const result = await resolveProject({ cwd: tempDir }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
	})

	it('reports not-project-worktree-root when .engineering is found below the Git worktree root', async () => {
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
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
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n',
		)
		const nestedRepo = path.join(tempDir, 'linked')
		await fs.mkdir(nestedRepo)
		execFileSync('git', ['init', '-q', '-b', 'main', nestedRepo])

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
})
