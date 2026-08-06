import type { LinkedRepositoryDescriptor } from './config'
import type { ValidateWorkspaceDeps, WorktreeAssociationResult } from './workspace'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { findWorktreeRoot } from '../git/repository'
import { validateWorkspace } from './workspace'

function descriptor(overrides: Partial<LinkedRepositoryDescriptor> = {}): LinkedRepositoryDescriptor {
	return { id: 'backend', path: 'repos/be', role: 'implementation', required: true, ...overrides }
}

function fakeDeps(overrides: Partial<ValidateWorkspaceDeps> = {}): ValidateWorkspaceDeps {
	return {
		pathFacts: () => ({ exists: true, isSymlink: false }),
		checkWorktreeAssociation: () => ({ kind: 'matches' }),
		...overrides,
	}
}

describe('validateWorkspace', () => {
	it('returns no diagnostics and complete: true when there are no linked repositories', async () => {
		const result = await validateWorkspace({ linkedRepositories: [] }, fakeDeps())
		expect(result)
			.toEqual({ diagnostics: [], complete: true })
	})

	it('passes for a present, non-symlinked, correctly associated required repository', async () => {
		const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, fakeDeps())
		expect(result)
			.toEqual({ diagnostics: [], complete: true })
	})

	describe('eF-FS-007 required presence', () => {
		it('reports a missing required linked repository', async () => {
			const deps = fakeDeps({ pathFacts: () => ({ exists: false, isSymlink: false }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor({ required: true })] }, deps)
			expect(result.complete)
				.toBe(true)
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-007', severity: 'error' }),
				])
		})

		it('permits a missing optional linked repository', async () => {
			const deps = fakeDeps({ pathFacts: () => ({ exists: false, isSymlink: false }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor({ required: false })] }, deps)
			expect(result)
				.toEqual({ diagnostics: [], complete: true })
		})

		it('does not check worktree association or symlinks for a missing repository', async () => {
			let associationCalled = false
			const deps = fakeDeps({
				pathFacts: () => ({ exists: false, isSymlink: false }),
				checkWorktreeAssociation: () => {
					associationCalled = true
					return { kind: 'matches' }
				},
			})
			await validateWorkspace({ linkedRepositories: [descriptor({ required: true })] }, deps)
			expect(associationCalled)
				.toBe(false)
		})
	})

	describe('eF-FS-008 worktree association', () => {
		it('reports a present repository whose root does not match the configured path', async () => {
			const deps = fakeDeps({ checkWorktreeAssociation: () => ({ kind: 'mismatched-root', actualRoot: '/elsewhere' }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, deps)
			expect(result.complete)
				.toBe(true)
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-008', severity: 'error' }),
				])
		})

		it('reports a present path that is not a Git worktree at all', async () => {
			const deps = fakeDeps({ checkWorktreeAssociation: () => ({ kind: 'not-a-worktree' }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, deps)
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-008' }),
				])
		})

		it('marks the result incomplete, without an EF-FS-008 finding, when Git is unavailable', async () => {
			const deps = fakeDeps({ checkWorktreeAssociation: () => ({ kind: 'git-unavailable', message: 'git not found' } satisfies WorktreeAssociationResult) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, deps)
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics)
				.toEqual([])
		})
	})

	describe('eF-FS-004 symlinked slot path', () => {
		it('reports a symlinked configured path', async () => {
			const deps = fakeDeps({ pathFacts: (p: string) => ({ exists: true, isSymlink: p === 'repos/be' }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, deps)
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-004', path: 'repos/be' }),
				])
		})

		it('reports a symlinked intermediate path component', async () => {
			const deps = fakeDeps({ pathFacts: (p: string) => ({ exists: true, isSymlink: p === 'repos' }) })
			const result = await validateWorkspace({ linkedRepositories: [descriptor()] }, deps)
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-004', path: 'repos' }),
				])
		})

		it('does not check symlinks or worktree association for a top-level (single-segment) path beyond the leaf itself', async () => {
			const calledComponents: string[] = []
			const deps = fakeDeps({
				pathFacts: (p: string) => {
					calledComponents.push(p)
					return { exists: true, isSymlink: false }
				},
			})
			await validateWorkspace({ linkedRepositories: [descriptor({ path: 'vendor' })] }, deps)
			expect(calledComponents)
				.toEqual(['vendor'])
		})
	})

	it('aggregates findings across multiple linked repositories', async () => {
		const deps = fakeDeps({
			pathFacts: (p: string) => ({ exists: p !== 'repos/missing', isSymlink: false }),
			checkWorktreeAssociation: (p: string) => (p === 'repos/be' ? { kind: 'matches' } : { kind: 'not-a-worktree' }),
		})
		const result = await validateWorkspace({
			linkedRepositories: [
				descriptor({ id: 'backend', path: 'repos/be', required: true }),
				descriptor({ id: 'missing', path: 'repos/missing', required: true }),
				descriptor({ id: 'bad', path: 'repos/bad', required: true }),
			],
		}, deps)
		expect(result.diagnostics.map(d => d.code)
			.sort())
			.toEqual(['EF-FS-007', 'EF-FS-008'])
	})
})

describe('validateWorkspace with a real nested Git worktree', () => {
	let projectRoot: string
	const executor = createGitExecutor()

	async function git(cwd: string, args: string[]): Promise<void> {
		execFileSync('git', args, { cwd, stdio: 'ignore' })
	}

	function realCheckWorktreeAssociation(relativePath: string): (r: string) => Promise<WorktreeAssociationResult> {
		return async (r: string) => {
			const absolute = path.join(projectRoot, r)
			const outcome = await findWorktreeRoot(executor, absolute)
			if (outcome.kind === 'git-unavailable')
				return outcome
			if (outcome.kind === 'not-a-worktree')
				return { kind: 'not-a-worktree' }
			const expected = path.join(projectRoot, relativePath)
			return outcome.root === expected ? { kind: 'matches' } : { kind: 'mismatched-root', actualRoot: outcome.root }
		}
	}

	beforeEach(async () => {
		// Resolve to the real path: on macOS, `os.tmpdir()` is itself a symlink
		// (`/tmp` -> `/private/tmp`), and Git's `rev-parse --show-toplevel`
		// reports the resolved real path, not the symlinked one.
		projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-')))
		await git(projectRoot, ['init', '--quiet'])
	})

	afterEach(async () => {
		await fs.rm(projectRoot, { recursive: true, force: true })
	})

	it('passes for a linked repository that is an independent worktree exactly at its configured root', async () => {
		const slot = path.join(projectRoot, 'repos', 'project-fe')
		await fs.mkdir(slot, { recursive: true })
		await git(slot, ['init', '--quiet'])

		const result = await validateWorkspace(
			{ linkedRepositories: [descriptor({ id: 'frontend', path: 'repos/project-fe' })] },
			{
				pathFacts: async (r: string) => {
					const absolute = path.join(projectRoot, r)
					try {
						const stats = await fs.lstat(absolute)
						return { exists: true, isSymlink: stats.isSymbolicLink() }
					}
					catch {
						return { exists: false, isSymlink: false }
					}
				},
				checkWorktreeAssociation: realCheckWorktreeAssociation('repos/project-fe'),
			},
		)

		expect(result)
			.toEqual({ diagnostics: [], complete: true })
	})

	it('reports EF-FS-008 when the configured path is nested inside a Git worktree rather than being its own root', async () => {
		const nestedRepoRoot = path.join(projectRoot, 'repos')
		await fs.mkdir(nestedRepoRoot, { recursive: true })
		await git(nestedRepoRoot, ['init', '--quiet'])
		await fs.mkdir(path.join(nestedRepoRoot, 'project-fe'), { recursive: true })

		const result = await validateWorkspace(
			{ linkedRepositories: [descriptor({ id: 'frontend', path: 'repos/project-fe', required: true })] },
			{
				pathFacts: async (r: string) => {
					const absolute = path.join(projectRoot, r)
					try {
						const stats = await fs.lstat(absolute)
						return { exists: true, isSymlink: stats.isSymbolicLink() }
					}
					catch {
						return { exists: false, isSymlink: false }
					}
				},
				checkWorktreeAssociation: realCheckWorktreeAssociation('repos/project-fe'),
			},
		)

		expect(result.complete)
			.toBe(true)
		expect(result.diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-008' }),
			])
	})

	it('reports EF-FS-004 for a real symlinked configured path', async () => {
		const realTarget = path.join(projectRoot, 'real-be')
		await fs.mkdir(realTarget, { recursive: true })
		await git(realTarget, ['init', '--quiet'])
		await fs.mkdir(path.join(projectRoot, 'repos'), { recursive: true })
		await fs.symlink(realTarget, path.join(projectRoot, 'repos', 'be'), 'dir')

		const result = await validateWorkspace(
			{ linkedRepositories: [descriptor({ id: 'backend', path: 'repos/be' })] },
			{
				pathFacts: async (r: string) => {
					const absolute = path.join(projectRoot, r)
					const stats = await fs.lstat(absolute)
					return { exists: true, isSymlink: stats.isSymbolicLink() }
				},
				checkWorktreeAssociation: realCheckWorktreeAssociation('repos/be'),
			},
		)

		expect(result.diagnostics.some(d => d.code === 'EF-FS-004' && d.path === 'repos/be'))
			.toBe(true)
	})
})
