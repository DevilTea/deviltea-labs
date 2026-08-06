import type { WorktreeRootResult } from '../git/repository'
import type { DiscoverProjectDeps } from './discovery'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { findWorktreeRoot } from '../git/repository'
import { discoverProject } from './discovery'

const SINGLE_REPO_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

function composeYaml(linkedRepoBlock: string): string {
	return `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
${linkedRepoBlock}
schemas:
  artifact_write_major: 1
`
}

function foundAt(root: string): WorktreeRootResult {
	return { kind: 'found', root }
}

describe('discoverProject (isolated, fake git)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('reports not-found when no .engineering exists ascending to the filesystem root', async () => {
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
		const result = await discoverProject({ cwd: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'not-found' })
	})

	it('reports not-found for an explicit root with no .engineering', async () => {
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
		const result = await discoverProject({ cwd: tempDir, explicitRoot: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'not-found' })
	})

	it('reports not-a-directory when .engineering exists but is a regular file', async () => {
		await fs.writeFile(path.join(tempDir, '.engineering'), 'not a directory')
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
		const result = await discoverProject({ cwd: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'not-a-directory', path: path.join(tempDir, '.engineering') })
	})

	it('selects the nearest .engineering even without ef.yaml, ascending from a nested cwd', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		const nestedCwd = path.join(tempDir, 'a', 'b', 'c')
		await fs.mkdir(nestedCwd, { recursive: true })
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
		const result = await discoverProject({ cwd: nestedCwd }, deps)
		expect(result)
			.toEqual({ kind: 'incomplete-initialization', root: tempDir })
	})

	describe('incomplete initialization', () => {
		it('classifies a directory .engineering with no ef.yaml as incomplete', async () => {
			await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result)
				.toEqual({ kind: 'incomplete-initialization', root: tempDir })
		})

		it('classifies a directory .engineering with ef.yaml but a live init marker as incomplete', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await fs.mkdir(path.join(engineeringDir, '.tmp'), { recursive: true })
			await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)
			await fs.writeFile(path.join(engineeringDir, '.tmp', 'init-state.json'), '{"schema":"ef/init-state@1","nonce":"a"}')
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result)
				.toEqual({ kind: 'incomplete-initialization', root: tempDir })
		})
	})

	it('reports not-project-worktree-root when the candidate root is not itself the Git worktree root', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(path.dirname(tempDir)) }
		const result = await discoverProject({ cwd: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'not-project-worktree-root', root: tempDir })
	})

	it('reports not-project-worktree-root when the candidate root is not a Git worktree at all', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => ({ kind: 'not-a-worktree' }) }
		const result = await discoverProject({ cwd: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'not-project-worktree-root', root: tempDir })
	})

	it('propagates git-unavailable from the project-root worktree check', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)
		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => ({ kind: 'git-unavailable', message: 'no git' }) }
		const result = await discoverProject({ cwd: tempDir }, deps)
		expect(result)
			.toEqual({ kind: 'git-unavailable', message: 'no git' })
	})

	describe('resolved: config loading', () => {
		async function setUpValidProject(yaml: string): Promise<void> {
			const engineeringDir = path.join(tempDir, '.engineering')
			await fs.mkdir(engineeringDir, { recursive: true })
			await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), yaml)
		}

		it('returns the decoded config on a fully valid single-repository project (cwd within its own worktree)', async () => {
			await setUpValidProject(SINGLE_REPO_YAML)
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			expect(result.root)
				.toBe(tempDir)
			expect(result.configDiagnostics)
				.toEqual([])
			expect(result.config)
				.toEqual({
					schema: 'ef/config@1',
					repository: { integrationRef: 'refs/heads/main' },
					linkedRepositories: [],
					schemas: { artifactWriteMajor: 1 },
				})
		})

		it('returns a null config with diagnostics for schema-invalid ef.yaml, without failing discovery', async () => {
			await setUpValidProject('schema: ef/config@1\n')
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			expect(result.config)
				.toBeNull()
			expect(result.configDiagnostics.length)
				.toBeGreaterThan(0)
		})

		it('does not check working-directory association for an explicit root', async () => {
			await setUpValidProject(SINGLE_REPO_YAML)
			let callCount = 0
			const deps: DiscoverProjectDeps = {
				findWorktreeRoot: async (p: string) => {
					callCount++
					return foundAt(p === tempDir ? tempDir : '/somewhere-else')
				},
			}
			const elsewhereCwd = path.join(tempDir, 'unrelated-does-not-matter')
			const result = await discoverProject({ cwd: elsewhereCwd, explicitRoot: tempDir }, deps)
			expect(result.kind)
				.toBe('resolved')
			expect(callCount)
				.toBe(1)
		})

		it('reports unassociated when cwd is inside an undeclared different worktree', async () => {
			await setUpValidProject(SINGLE_REPO_YAML)
			const nestedCwd = path.join(tempDir, 'vendor', 'undeclared')
			await fs.mkdir(nestedCwd, { recursive: true })
			const deps: DiscoverProjectDeps = {
				findWorktreeRoot: async (p: string) => (p === tempDir ? foundAt(tempDir) : foundAt('/some/other/worktree')),
			}
			const result = await discoverProject({ cwd: nestedCwd }, deps)
			expect(result)
				.toEqual({ kind: 'unassociated', root: tempDir })
		})

		it('associates cwd with a declared linked repository at its configured path', async () => {
			await setUpValidProject(composeYaml('  - id: frontend\n    path: repos/project-fe\n    role: implementation\n    required: true'))
			const linkedAbsolute = path.join(tempDir, 'repos', 'project-fe')
			const deps: DiscoverProjectDeps = {
				findWorktreeRoot: async (p: string) => (p === tempDir ? foundAt(tempDir) : foundAt(linkedAbsolute)),
			}
			const result = await discoverProject({ cwd: linkedAbsolute }, deps)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			expect(result.root)
				.toBe(tempDir)
		})

		it('propagates git-unavailable from the association check', async () => {
			await setUpValidProject(SINGLE_REPO_YAML)
			const nestedCwd = path.join(tempDir, 'vendor', 'undeclared')
			await fs.mkdir(nestedCwd, { recursive: true })
			const deps: DiscoverProjectDeps = {
				findWorktreeRoot: async (p: string) => (p === tempDir ? foundAt(tempDir) : { kind: 'git-unavailable', message: 'boom' }),
			}
			const result = await discoverProject({ cwd: nestedCwd }, deps)
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'boom' })
		})
	})
})

describe('discoverProject (real filesystem and Git)', () => {
	let tempDir: string
	const executor = createGitExecutor()
	const deps: DiscoverProjectDeps = { findWorktreeRoot: absolutePath => findWorktreeRoot(executor, absolutePath) }

	async function git(cwd: string, args: string[]): Promise<void> {
		execFileSync('git', args, { cwd, stdio: 'ignore' })
	}

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('resolves a single-repository project from a nested working directory inside its own worktree', async () => {
		await git(tempDir, ['init', '--quiet'])
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), SINGLE_REPO_YAML)
		const nestedCwd = path.join(tempDir, 'src')
		await fs.mkdir(nestedCwd, { recursive: true })

		const result = await discoverProject({ cwd: nestedCwd }, deps)
		expect(result.kind)
			.toBe('resolved')
		if (result.kind === 'resolved') {
			expect(result.root)
				.toBe(tempDir)
		}
	})

	it('rejects an undeclared nested Git worktree as unassociated', async () => {
		await git(tempDir, ['init', '--quiet'])
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), SINGLE_REPO_YAML)
		const nestedWorktree = path.join(tempDir, 'vendor', 'undeclared')
		await fs.mkdir(nestedWorktree, { recursive: true })
		await git(nestedWorktree, ['init', '--quiet'])

		const result = await discoverProject({ cwd: nestedWorktree }, deps)
		expect(result)
			.toEqual({ kind: 'unassociated', root: tempDir })
	})

	it('crosses a declared linked-repository worktree boundary and resolves the outer project', async () => {
		await git(tempDir, ['init', '--quiet'])
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			composeYaml('  - id: frontend\n    path: repos/project-fe\n    role: implementation\n    required: true'),
		)
		const linkedRoot = path.join(tempDir, 'repos', 'project-fe')
		await fs.mkdir(linkedRoot, { recursive: true })
		await git(linkedRoot, ['init', '--quiet'])
		const linkedSrc = path.join(linkedRoot, 'src')
		await fs.mkdir(linkedSrc, { recursive: true })

		const result = await discoverProject({ cwd: linkedSrc }, deps)
		expect(result.kind)
			.toBe('resolved')
		if (result.kind === 'resolved') {
			expect(result.root)
				.toBe(tempDir)
		}
	})

	it('lets the nearer independent EF project inside a linked repository win over the outer one', async () => {
		await git(tempDir, ['init', '--quiet'])
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(
			path.join(tempDir, '.engineering', 'ef.yaml'),
			composeYaml('  - id: frontend\n    path: repos/project-fe\n    role: implementation\n    required: true'),
		)
		const innerRoot = path.join(tempDir, 'repos', 'project-fe')
		await fs.mkdir(path.join(innerRoot, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(innerRoot, '.engineering', 'ef.yaml'), SINGLE_REPO_YAML)
		await git(innerRoot, ['init', '--quiet'])
		const innerSrc = path.join(innerRoot, 'src')
		await fs.mkdir(innerSrc, { recursive: true })

		const result = await discoverProject({ cwd: innerSrc }, deps)
		expect(result.kind)
			.toBe('resolved')
		if (result.kind === 'resolved') {
			expect(result.root)
				.toBe(innerRoot)
		}
	})
})
