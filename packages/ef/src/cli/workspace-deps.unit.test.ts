import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createWorkspaceDeps } from './workspace-deps'

describe('createWorkspaceDeps', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-workspace-')))
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it('reports a missing linked path as not existing', async () => {
		const deps = createWorkspaceDeps(root, createGitExecutor())
		const facts = await deps.pathFacts('repos/missing')
		expect(facts.exists)
			.toBe(false)
		expect(facts.isSymlink)
			.toBe(false)
	})

	it('reports an existing plain directory as existing and not a symlink', async () => {
		await fs.mkdir(path.join(root, 'repos', 'plain'), { recursive: true })
		const deps = createWorkspaceDeps(root, createGitExecutor())
		const facts = await deps.pathFacts('repos/plain')
		expect(facts.exists)
			.toBe(true)
		expect(facts.isSymlink)
			.toBe(false)
	})

	it('reports a symlinked path as a symlink', async () => {
		await fs.mkdir(path.join(root, 'repos'), { recursive: true })
		await fs.symlink(root, path.join(root, 'repos', 'linked'))
		const deps = createWorkspaceDeps(root, createGitExecutor())
		const facts = await deps.pathFacts('repos/linked')
		expect(facts.exists)
			.toBe(true)
		expect(facts.isSymlink)
			.toBe(true)
	})

	it('matches a real independent Git worktree checked out exactly at the configured path', async () => {
		execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'root'])
		const linkedPath = path.join(root, 'repos', 'linked')
		execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'linked-branch', linkedPath])

		const deps = createWorkspaceDeps(root, createGitExecutor())
		const association = await deps.checkWorktreeAssociation('repos/linked')
		expect(association.kind)
			.toBe('matches')
	})

	it('reports mismatched-root when the configured path is nested inside a worktree rather than being its root', async () => {
		execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'root'])
		const linkedPath = path.join(root, 'repos', 'linked')
		execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'linked-branch', linkedPath])
		await fs.mkdir(path.join(linkedPath, 'nested'))

		const deps = createWorkspaceDeps(root, createGitExecutor())
		const association = await deps.checkWorktreeAssociation('repos/linked/nested')
		expect(association.kind)
			.toBe('mismatched-root')
	})

	it('reports not-a-worktree for a plain directory outside any Git repository', async () => {
		const nonGitRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-workspace-nogit-')))
		try {
			await fs.mkdir(path.join(nonGitRoot, 'repos', 'plain'), { recursive: true })
			const deps = createWorkspaceDeps(nonGitRoot, createGitExecutor())
			const association = await deps.checkWorktreeAssociation('repos/plain')
			expect(association.kind)
				.toBe('not-a-worktree')
		}
		finally {
			await fs.rm(nonGitRoot, { recursive: true, force: true })
		}
	})
})
