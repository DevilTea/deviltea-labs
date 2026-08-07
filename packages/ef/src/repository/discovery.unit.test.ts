import type { WorktreeRootResult } from '../git/repository'
import type { DiscoverProjectDeps } from './discovery'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { findWorktreeRoot } from '../git/repository'
import { directoryIdentity } from '../platform/fs-facts'
import { decodeConfig } from './config'
import { checkWorkingDirectoryAssociation, discoverProject } from './discovery'

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

	it('resolves when the injected Git worktree root reaches the same location as the fs-ascended candidate through a different path form', async () => {
		// Stands in for the cross-platform condition the worktree-root check
		// must tolerate (Windows: Git's forward-slash/long-form output vs. a
		// short-name or differently-cased fs-derived path denoting the same
		// directory). Here a symlinked alias plays the role of "a differently
		// shaped path to the identical location": `.engineering` lives under
		// the real directory, `cwd` ascends through the symlinked alias, and
		// the injected Git dependency reports the *real* (unaliased) root --
		// exactly as real Git would after resolving the symlink itself.
		const realRoot = path.join(tempDir, 'real-project')
		const engineeringDir = path.join(realRoot, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)

		const aliasRoot = path.join(tempDir, 'alias-project')
		await fs.symlink(realRoot, aliasRoot, 'dir')
		const nestedCwd = path.join(aliasRoot, 'src')
		await fs.mkdir(nestedCwd, { recursive: true })

		const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(realRoot) }
		const result = await discoverProject({ cwd: nestedCwd }, deps)
		expect(result.kind)
			.toBe('resolved')
		if (result.kind === 'resolved') {
			// The candidate root returned is still the fs-ascended (aliased)
			// form: canonicalization is for the equality check only, never for
			// the reported/serialized path.
			expect(result.root)
				.toBe(aliasRoot)
		}
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

	// FINDING 1 (discovery.ts): `pathExists` only proves an entry exists via
	// `lstat`; the previous implementation then called `readFile` on
	// `ef.yaml`'s path, which follows a symlink at the final component. A
	// project whose `.engineering/ef.yaml` is a symlink to a file outside the
	// project root would have that external file's content silently decoded
	// and used for worktree/linked-repository association, before the
	// (separate) snapshot validator could ever report `EF-FS-004`.
	describe('a symlinked ef.yaml pointing outside the project root', () => {
		let outsideDir: string
		let outsideConfigPath: string

		beforeEach(async () => {
			outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-outside-')))
			outsideConfigPath = path.join(outsideDir, 'config.yaml')
			await fs.writeFile(outsideConfigPath, SINGLE_REPO_YAML)
		})

		afterEach(async () => {
			await fs.rm(outsideDir, { recursive: true, force: true })
		})

		it('refuses to follow it and read the external config (explicit discovery)', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await fs.mkdir(engineeringDir, { recursive: true })
			await fs.symlink(outsideConfigPath, path.join(engineeringDir, 'ef.yaml'))
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }

			const result = await discoverProject({ cwd: tempDir, explicitRoot: tempDir }, deps)

			expect(result.kind)
				.toBe('read-error')
			expect(result.kind === 'resolved')
				.toBe(false)
		})

		it('refuses to follow it and read the external config (implicit discovery)', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await fs.mkdir(engineeringDir, { recursive: true })
			await fs.symlink(outsideConfigPath, path.join(engineeringDir, 'ef.yaml'))
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }

			const result = await discoverProject({ cwd: tempDir }, deps)

			expect(result.kind)
				.toBe('read-error')
			expect(result.kind === 'resolved')
				.toBe(false)
		})
	})

	// Wiring regression (`discoverProject` -> `readRegularFileNoFollow`'s
	// `containmentRoot`): the exact move-out-then-symlink-back reproduction
	// from `fs-facts.unit.test.ts`'s own `containmentRoot` tests, applied to
	// `.engineering/.tmp` -- the one ancestor between `candidateRoot` and
	// `initMarkerPath` that no other check in `discoverProject` independently
	// verifies (unlike `.engineering` itself, which the earlier `isDirectory`
	// call already covers). `.tmp` genuinely exists (as a real directory)
	// before the swap, so `discoverProject`'s `pathExists(tmpPath)` gate --
	// required because an ENTIRELY ABSENT `.tmp` must fall back to an
	// unguarded read (see the comment above `tmpAncestorExists` in
	// `discovery.ts`: otherwise the overwhelmingly common "no `.tmp` at all"
	// case would be misreported as `identity-mismatch` instead of
	// `not-found`) -- is satisfied here, so the init-marker read DOES receive
	// `containmentRoot`. `.tmp` never actually contains `init-state.json`
	// either before or after the swap, so without `containmentRoot` wired,
	// `readRegularFileNoFollow` simply `lstat`s straight through the
	// symlinked ancestor to a genuinely absent file and reports `not-found`
	// -- silently ignoring that the ancestor itself is a forbidden symlink and
	// letting the project resolve normally. With `containmentRoot` wired,
	// PRE-verification `lstat`s `.engineering/.tmp`, finds a symlink rather
	// than a directory, and refuses before ever checking whether
	// `init-state.json` exists -- forcing `incomplete-initialization` instead.
	it('treats a `.engineering/.tmp` ancestor renamed out and symlinked back to itself as incomplete initialization, even though no init-state.json exists through it', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), SINGLE_REPO_YAML)
		await fs.mkdir(path.join(engineeringDir, '.tmp'), { recursive: true })

		const outsideTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-discovery-outside-tmp-')))
		try {
			await fs.rm(outsideTmp, { recursive: true, force: true })
			await fs.rename(path.join(engineeringDir, '.tmp'), outsideTmp)
			await fs.symlink(outsideTmp, path.join(engineeringDir, '.tmp'), 'dir')

			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result)
				.toEqual({ kind: 'incomplete-initialization', root: tempDir })
		}
		finally {
			await fs.rm(outsideTmp, { recursive: true, force: true })
		}
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

		// Finding 4: `.engineering`'s identity is threaded into the resolved
		// result, for a later caller (`application/snapshot.ts`'s
		// `loadSnapshotFromWorkingTree`) to bind its own, separate walk to the
		// EXACT directory this discovery observed.
		it('threads .engineering\'s lstat-derived identity into the resolved result', async () => {
			await setUpValidProject(SINGLE_REPO_YAML)
			const deps: DiscoverProjectDeps = { findWorktreeRoot: async () => foundAt(tempDir) }
			const result = await discoverProject({ cwd: tempDir }, deps)
			expect(result.kind)
				.toBe('resolved')
			if (result.kind !== 'resolved')
				return
			const expected = await directoryIdentity(path.join(tempDir, '.engineering'))
			expect(expected)
				.toBeDefined()
			expect(result.engineeringIdentity)
				.toEqual(expected)
		})
	})

	// ---- Finding 5: the association decision, extracted for reuse ------------

	describe('checkWorkingDirectoryAssociation', () => {
		it('reports associated when cwd is within the project\'s own worktree', async () => {
			const result = await checkWorkingDirectoryAssociation(
				{ cwd: tempDir, candidateRoot: tempDir, config: null },
				{ findWorktreeRoot: async () => foundAt(tempDir) },
			)
			expect(result)
				.toEqual({ kind: 'associated' })
		})

		it('reports unassociated when cwd is inside an undeclared different worktree', async () => {
			const result = await checkWorkingDirectoryAssociation(
				{ cwd: '/nested', candidateRoot: tempDir, config: null },
				{ findWorktreeRoot: async (p: string) => (p === tempDir ? foundAt(tempDir) : foundAt('/some/other/worktree')) },
			)
			expect(result)
				.toEqual({ kind: 'unassociated' })
		})

		it('propagates git-unavailable from its own findWorktreeRoot probe', async () => {
			const result = await checkWorkingDirectoryAssociation(
				{ cwd: '/nested', candidateRoot: tempDir, config: null },
				{ findWorktreeRoot: async () => ({ kind: 'git-unavailable', message: 'boom' }) },
			)
			expect(result)
				.toEqual({ kind: 'git-unavailable', message: 'boom' })
		})

		// This is the exact primitive a caller needs to close Finding 5's
		// in-place-rewrite race: re-running this SAME decision against a LATER,
		// fresher config (e.g. a project snapshot's own `config.config`) than
		// the one `discoverProject` itself used reverses a stale `associated`
		// verdict once the declaring linked-repository entry is gone.
		it('re-run against a different, later config reverses an earlier associated verdict for the identical cwd/candidateRoot', async () => {
			const configA = decodeConfig(
				composeYaml('  - id: frontend\n    path: repos/project-fe\n    role: implementation\n    required: true'),
				'.engineering/ef.yaml',
			).config
			const configB = decodeConfig(SINGLE_REPO_YAML, '.engineering/ef.yaml').config
			expect(configA).not.toBeNull()
			expect(configB).not.toBeNull()

			const linkedAbsolute = path.join(tempDir, 'repos', 'project-fe')
			const deps: DiscoverProjectDeps = {
				findWorktreeRoot: async (p: string) => (p === tempDir ? foundAt(tempDir) : foundAt(linkedAbsolute)),
			}

			const withConfigA = await checkWorkingDirectoryAssociation({ cwd: linkedAbsolute, candidateRoot: tempDir, config: configA }, deps)
			expect(withConfigA)
				.toEqual({ kind: 'associated' })

			// Config B (no `linked_repositories` at all) is what an in-place
			// rewrite between `discoverProject`'s own read and a later, fresher
			// read would leave on disk; re-running the association check against
			// it, rather than trusting config A's stale verdict, is what a
			// caller must do.
			const withConfigB = await checkWorkingDirectoryAssociation({ cwd: linkedAbsolute, candidateRoot: tempDir, config: configB }, deps)
			expect(withConfigB)
				.toEqual({ kind: 'unassociated' })
		})
	})
})

describe('discoverProject (real filesystem and Git)', () => {
	let tempDir: string
	const executor = createGitExecutor()
	const deps: DiscoverProjectDeps = { findWorktreeRoot: absolutePath => findWorktreeRoot(executor, absolutePath) }

	async function git(cwd: string, args: string[]): Promise<void> {
		execFileSync('git', args, { cwd, stdio: 'ignore' })
		// A freshly initialized fixture repository must not run background
		// maintenance (`gc --auto`'s detached repack, or `maintenance.auto`'s
		// scheduled runs): a stray background process can still be writing
		// `.git/objects/pack` when this file's teardown removes the fixture,
		// racing the rmdir and intermittently failing with `ENOTEMPTY`
		// (observed in CI). Disabling it right after `init` removes the writer
		// instead of just tolerating the race.
		if (args[0] === 'init') {
			execFileSync('git', ['config', 'gc.auto', '0'], { cwd, stdio: 'ignore' })
			execFileSync('git', ['config', 'gc.autoDetach', 'false'], { cwd, stdio: 'ignore' })
			execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd, stdio: 'ignore' })
		}
	}

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
