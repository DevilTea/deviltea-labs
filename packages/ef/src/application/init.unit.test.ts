import type { ComputeInitPlanDeps, InitValues } from './init'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import {
	applyInitPlan,
	computeInitPlan,
	defaultApplyInitPlanDeps,
} from './init'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
}

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

const BASE_VALUES: InitValues = {
	title: 'Engineering Files',
	summary: 'Engineering Files manages authoritative engineering knowledge as Git-native files.',
	vision: 'Deliver a well-governed engineering specification workflow for this repository.',
	projectScope: 'This project covers specification-driven engineering artifacts under .engineering.',
	nonGoals: 'This project does not manage unrelated deployment tooling.',
	context: 'The project operates as a single-repository workspace with no linked repositories.',
	integrationRef: 'refs/heads/main',
}

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target)
		.then(() => true, () => false)
}

describe('computeInitPlan', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-init-')))
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	function repoDeps(): ComputeInitPlanDeps {
		return createGitRepository(tempDir, createGitExecutor())
	}

	it('rejects a blank required value', async () => {
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, title: '   ' } }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('missing-value')
	})

	it('rejects a multi-line title', async () => {
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, title: 'Line one\nLine two' } }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('missing-value')
	})

	it('rejects a syntactically invalid integration ref', async () => {
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, integrationRef: 'main' } }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('invalid-integration-ref')
	})

	it('rejects a target that is not a Git worktree at all', async () => {
		const nonGitDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-init-nogit-')))
		try {
			const result = await computeInitPlan(
				{ targetRoot: nonGitDir, values: BASE_VALUES },
				createGitRepository(nonGitDir, createGitExecutor()),
			)
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('not-a-worktree-root')
		}
		finally {
			await fs.rm(nonGitDir, { recursive: true, force: true })
		}
	})

	it('rejects a target that is a subdirectory of the worktree root, not the root itself', async () => {
		const sub = path.join(tempDir, 'sub')
		await fs.mkdir(sub)
		const result = await computeInitPlan({ targetRoot: sub, values: BASE_VALUES }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('not-a-worktree-root')
	})

	it('accepts a target reached through a symlinked alias that resolves to the same worktree root', async () => {
		// Simulates the cross-platform condition this equality check must
		// tolerate (11-filesystem-and-config.md worktree-root identity): Git's
		// `rev-parse --show-toplevel` output and a filesystem-derived path can
		// denote the identical worktree root while differing in string form
		// (a symlinked alias here stands in for a Windows short-path/case
		// difference between the two sources). `deps.findWorktreeRoot` below
		// is real Git, so `-C aliasPath` resolves the symlink itself and
		// reports the real `tempDir`, distinct from `targetRoot` as a string.
		const aliasPath = path.join(os.tmpdir(), `ef-init-alias-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}`)
		await fs.symlink(tempDir, aliasPath, 'dir')
		try {
			const result = await computeInitPlan(
				{ targetRoot: aliasPath, values: BASE_VALUES },
				createGitRepository(aliasPath, createGitExecutor()),
			)
			expect(result.ok)
				.toBe(true)
		}
		finally {
			await fs.rm(aliasPath, { force: true })
		}
	})

	it('propagates git-unavailable from the worktree-root check', async () => {
		const deps: ComputeInitPlanDeps = {
			findWorktreeRoot: async () => ({ kind: 'git-unavailable', message: 'git is not installed' }),
			resolveRef: () => { throw new Error('must not be called') },
			pathExistsInFirstParentHistory: () => { throw new Error('must not be called') },
		}
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, deps)
		expect(result)
			.toEqual({ ok: false, reason: 'git-unavailable', message: 'git is not installed' })
	})

	it('rejects when the integration branch already has .engineering/ef.yaml in its first-parent history', async () => {
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')
		commitAll(tempDir, 'prior EF state')

		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('history-contains-ef-state')
	})

	it('accepts an unresolved (unborn) integration ref: the bootstrap no-baseline exception', async () => {
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, integrationRef: 'refs/heads/does-not-exist-yet' } }, repoDeps())
		expect(result.ok)
			.toBe(true)
	})

	it('propagates git-unavailable from the ref-resolution check', async () => {
		const repo = repoDeps()
		const deps: ComputeInitPlanDeps = {
			findWorktreeRoot: p => repo.findWorktreeRoot(p),
			resolveRef: async () => ({ kind: 'git-unavailable', message: 'git is not installed' }),
			pathExistsInFirstParentHistory: () => { throw new Error('must not be called') },
		}
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, deps)
		expect(result)
			.toEqual({ ok: false, reason: 'git-unavailable', message: 'git is not installed' })
	})

	// FINDING A regression: a fatal ref-resolution probe failure (Git ran but
	// could not conclusively determine whether `integration_ref` exists --
	// distinct from `git-unavailable`, where Git could not even be run) must
	// make the plan incomplete, not be silently treated as though the ref
	// simply does not exist (which would let bootstrap proceed by assumption
	// instead of reporting incomplete, per 09-validation.md "An inaccessible
	// ref ... makes the operation incomplete rather than eligible by
	// assumption").
	it('rejects with history-incomplete (not accepting-by-assumption) when the ref-resolution probe reports an execution error', async () => {
		const deps: ComputeInitPlanDeps = {
			findWorktreeRoot: async () => ({ kind: 'found', root: tempDir }),
			resolveRef: async () => ({ kind: 'error', message: 'git show-ref --verify --quiet exited with status 128.' }),
			pathExistsInFirstParentHistory: () => { throw new Error('must not be called') },
		}
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, deps)
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('history-incomplete')
		expect(result.ok === false && result.message)
			.toContain(BASE_VALUES.integrationRef)
	})

	it('propagates git-unavailable from the first-parent history check', async () => {
		await fs.writeFile(path.join(tempDir, 'README.md'), '# Test\n')
		commitAll(tempDir, 'seed commit')

		const repo = repoDeps()
		const deps: ComputeInitPlanDeps = {
			findWorktreeRoot: p => repo.findWorktreeRoot(p),
			resolveRef: r => repo.resolveRef(r),
			pathExistsInFirstParentHistory: async () => ({ kind: 'git-unavailable', message: 'git is not installed' }),
		}
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, deps)
		expect(result)
			.toEqual({ ok: false, reason: 'git-unavailable', message: 'git is not installed' })
	})

	it('accepts an integration branch whose first-parent history exists but never contains .engineering/ef.yaml', async () => {
		await fs.writeFile(path.join(tempDir, 'README.md'), '# Test\n')
		commitAll(tempDir, 'seed commit')

		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, repoDeps())
		expect(result.ok)
			.toBe(true)
	})

	it('rejects with history-incomplete (not accepting-by-assumption) when the history-absence check reports a shallow repository', async () => {
		await fs.writeFile(path.join(tempDir, 'README.md'), '# Test\n')
		commitAll(tempDir, 'seed commit')

		const repo = repoDeps()
		const deps: ComputeInitPlanDeps = {
			findWorktreeRoot: p => repo.findWorktreeRoot(p),
			resolveRef: r => repo.resolveRef(r),
			pathExistsInFirstParentHistory: async () => ({ kind: 'shallow' }),
		}
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, deps)
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('history-incomplete')
	})

	it('rejects with history-incomplete for a real shallow clone whose visible history hides an earlier .engineering/ef.yaml (bootstrap exception: inaccessible history is incomplete, not eligible by assumption)', async () => {
		// Build a real shallow clone so the regression exercises the actual
		// `git rev-parse --is-shallow-repository` detection, not a stub: the
		// path was present in an early commit that a `--depth 1` clone never
		// fetches, and was removed before the tip, so the visible history
		// alone would otherwise look like a clean, eligible bootstrap target.
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')
		commitAll(tempDir, 'bootstrap (hidden ancestor)')
		execFileSync('git', ['rm', '-q', '.engineering/ef.yaml'], { cwd: tempDir, env: { ...process.env, ...GIT_TEST_ENV } })
		commitAll(tempDir, 'remove ef.yaml before the shallow boundary')

		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-init-shallow-')))
		await fs.rm(shallowDir, { recursive: true, force: true })
		execFileSync('git', ['clone', '-q', '--depth', '1', `file://${tempDir}`, shallowDir], { stdio: 'pipe' })

		try {
			const result = await computeInitPlan(
				{ targetRoot: shallowDir, values: BASE_VALUES },
				createGitRepository(shallowDir, createGitExecutor()),
			)
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('history-incomplete')
		}
		finally {
			await fs.rm(shallowDir, { recursive: true, force: true })
		}
	})

	it('produces a complete, canonically sorted plan with the default header-only Terminology table', async () => {
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, repoDeps())
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return

		expect(result.plan.directories)
			.toEqual([
				'.engineering/adr',
				'.engineering/chg',
				'.engineering/pol',
				'.engineering/prd',
				'.engineering/req',
				'.engineering/resources',
			])
		expect(result.plan.files.map(f => f.path))
			.toEqual(['.engineering/.gitignore', '.engineering/PROJECT.md', '.engineering/ef.yaml'])
		expect(result.plan.changes.map(c => c.path))
			.toEqual([
				'.engineering/.gitignore',
				'.engineering/PROJECT.md',
				'.engineering/adr',
				'.engineering/chg',
				'.engineering/ef.yaml',
				'.engineering/pol',
				'.engineering/prd',
				'.engineering/req',
				'.engineering/resources',
			])
		expect(result.plan.changes.every(c => c.action === 'create'))
			.toBe(true)

		const gitignoreText = new TextDecoder()
			.decode(result.plan.files.find(f => f.path === '.engineering/.gitignore')!.bytes)
		expect(gitignoreText)
			.toBe('.cache/\n.generated/\n.tmp/\n.lock\n')

		const configText = new TextDecoder()
			.decode(result.plan.files.find(f => f.path === '.engineering/ef.yaml')!.bytes)
		expect(configText)
			.toBe('schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n')

		const projectText = new TextDecoder()
			.decode(result.plan.files.find(f => f.path === '.engineering/PROJECT.md')!.bytes)
		expect(projectText)
			.toContain('| Term | Definition | Avoid or aliases |\n|---|---|---|\n')
		expect(projectText)
			.toMatch(/^---\n/)
		expect(projectText.endsWith('\n') && !projectText.endsWith('\n\n'))
			.toBe(true)
	})

	it('embeds valid caller-supplied Terminology rows', async () => {
		const terminology = '| Term | Definition | Avoid or aliases |\n|---|---|---|\n| Artifact | A formal EF document with stable project-scoped identity. | record, entity |\n'
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, terminology } }, repoDeps())
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		const projectText = new TextDecoder()
			.decode(result.plan.files.find(f => f.path === '.engineering/PROJECT.md')!.bytes)
		expect(projectText)
			.toContain('| Artifact | A formal EF document with stable project-scoped identity. | record, entity |')
	})

	it('rejects structurally invalid caller-supplied Terminology (wrong columns)', async () => {
		const terminology = '| Term | Definition |\n|---|---|\n'
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, terminology } }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('invalid-plan')
		expect(result.ok === false && result.diagnostics?.some(d => d.code === 'EF-BODY-018'))
			.toBe(true)
	})

	it('rejects caller-supplied Terminology with a duplicate term', async () => {
		const terminology = '| Term | Definition | Avoid or aliases |\n|---|---|---|\n| Artifact | First definition. |  |\n| Artifact | Second definition. |  |\n'
		const result = await computeInitPlan({ targetRoot: tempDir, values: { ...BASE_VALUES, terminology } }, repoDeps())
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('invalid-plan')
	})
})

describe('applyInitPlan', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-init-apply-')))
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function computeValidPlan() {
		const repo = createGitRepository(tempDir, createGitExecutor())
		const result = await computeInitPlan({ targetRoot: tempDir, values: BASE_VALUES }, repo)
		if (!result.ok)
			throw new Error(`unexpected computeInitPlan failure: ${result.reason} - ${result.message}`)
		return result.plan
	}

	it('performs zero writes when only the plan is computed (dry run)', async () => {
		await computeValidPlan()
		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('applies the full bootstrap byte-for-byte, and the resulting project passes snapshot validation', async () => {
		const plan = await computeValidPlan()
		const result = await applyInitPlan(plan)

		expect(result.applied)
			.toBe(true)
		if (!result.applied)
			return
		expect(result.changes)
			.toEqual(plan.changes)

		expect(await pathExists(path.join(tempDir, '.engineering/.tmp/init-state.json')))
			.toBe(false)

		for (const dir of plan.directories) {
			const stat = await fs.stat(path.join(tempDir, dir))
			expect(stat.isDirectory())
				.toBe(true)
		}
		for (const file of plan.files) {
			const bytes = await fs.readFile(path.join(tempDir, file.path))
			expect(new Uint8Array(bytes))
				.toEqual(file.bytes)
		}

		const snapshotResult = await loadSnapshotFromWorkingTree(tempDir)
		expect(snapshotResult.ok)
			.toBe(true)
		if (!snapshotResult.ok)
			return
		const validation = validateSnapshot(snapshotResult.snapshot)
		expect(validation.diagnostics.filter(d => d.severity === 'error'))
			.toEqual([])
		expect(validation.byId.has('PROJECT'))
			.toBe(true)
	})

	it('rejects (raced) without modifying a pre-existing .engineering path', async () => {
		const plan = await computeValidPlan()
		await fs.mkdir(path.join(tempDir, '.engineering'))
		await fs.writeFile(path.join(tempDir, '.engineering', 'sentinel.txt'), 'do-not-touch')

		const result = await applyInitPlan(plan)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('raced')

		const sentinel = await fs.readFile(path.join(tempDir, '.engineering', 'sentinel.txt'), 'utf8')
		expect(sentinel)
			.toBe('do-not-touch')
	})

	it('reports incomplete without touching the filesystem when claiming .engineering itself fails', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			claimDirectory: async () => ({ outcome: 'failed' as const, error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) }),
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Failed to claim '${path.join(tempDir, '.engineering')}': permission denied`)

		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('removes the whole claim (no marker to prove ownership yet) when the marker itself cannot be created', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			writeInitMarker: async () => ({ outcome: 'failed' as const, error: Object.assign(new Error('simulated crash'), { code: 'EIO' }) }),
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Failed to create the initialization marker at '${path.join(tempDir, '.engineering', '.tmp', 'init-state.json')}'.`)

		// No marker was ever created, so ownership is proven by the claim alone;
		// cleanup removes the whole claimed directory unconditionally.
		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('cleans up the whole claim when a directory silently fails to materialize', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			isDirectory: async (targetPath: string) => {
				if (targetPath.endsWith(path.join('.engineering', 'chg')))
					return false
				return defaultApplyInitPlanDeps.isDirectory(targetPath)
			},
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe('Directory \'.engineering/chg\' was not materialized.')

		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('cleans up the whole claim when a materialized file is a different length than the planned bytes', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			readFileBytes: async (targetPath: string) => {
				if (targetPath.endsWith('PROJECT.md')) {
					const bytes = plan.files.find(f => f.path === '.engineering/PROJECT.md')!.bytes
					return bytes.slice(0, bytes.length - 1)
				}
				return defaultApplyInitPlanDeps.readFileBytes(targetPath)
			},
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe('File \'.engineering/PROJECT.md\' was not materialized with the planned bytes.')

		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('cleans up the whole claim when a materialized file is the same length but different content than the planned bytes', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			readFileBytes: async (targetPath: string) => {
				if (targetPath.endsWith('PROJECT.md')) {
					const bytes = plan.files.find(f => f.path === '.engineering/PROJECT.md')!.bytes.slice()
					bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256
					return bytes
				}
				return defaultApplyInitPlanDeps.readFileBytes(targetPath)
			},
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')

		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('leaves the fully-materialized bootstrap in place when the final marker no longer matches the invocation nonce', async () => {
		const plan = await computeValidPlan()
		const deps = {
			...defaultApplyInitPlanDeps,
			readInitMarker: async () => ({
				outcome: 'found' as const,
				marker: { schema: 'ef/init-state@1' as const, nonce: '0'.repeat(32) },
			}),
		}

		const result = await applyInitPlan(plan, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe('The initialization marker no longer contains the invocation\'s nonce.')

		// Every planned file and directory was actually, fully materialized;
		// only the final marker check (post-completion) failed, and cleanup
		// correctly refused to remove a claim it can no longer prove it owns.
		for (const dir of plan.directories) {
			const stat = await fs.stat(path.join(tempDir, dir))
			expect(stat.isDirectory())
				.toBe(true)
		}
		for (const file of plan.files) {
			const bytes = await fs.readFile(path.join(tempDir, file.path))
			expect(new Uint8Array(bytes))
				.toEqual(file.bytes)
		}
		expect(await pathExists(path.join(tempDir, '.engineering', '.tmp', 'init-state.json')))
			.toBe(true)
	})

	it('cleans up the whole claim when a step fails mid-protocol (nonce proves ownership)', async () => {
		const plan = await computeValidPlan()
		const failingDeps = {
			...defaultApplyInitPlanDeps,
			createExclusive: async (targetPath: string, bytes: Uint8Array) => {
				if (targetPath.endsWith('PROJECT.md'))
					return { outcome: 'failed' as const, error: Object.assign(new Error('simulated crash'), { code: 'EIO' }) }
				return defaultApplyInitPlanDeps.createExclusive(targetPath, bytes)
			},
		}

		const result = await applyInitPlan(plan, failingDeps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')

		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)
	})

	it('does not remove the claim when the marker no longer contains the invocation nonce', async () => {
		const plan = await computeValidPlan()
		const tamperedDeps = {
			...defaultApplyInitPlanDeps,
			mkdir: async (targetPath: string) => {
				if (targetPath.endsWith(path.join('.engineering', 'prd')))
					throw Object.assign(new Error('simulated crash'), { code: 'EIO' })
				await defaultApplyInitPlanDeps.mkdir(targetPath)
			},
			readInitMarker: async () => ({
				outcome: 'found' as const,
				marker: { schema: 'ef/init-state@1' as const, nonce: '0'.repeat(32) },
			}),
		}

		const result = await applyInitPlan(plan, tamperedDeps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')

		// Cleanup was correctly skipped because the (faked) marker nonce did not
		// match this invocation's own nonce: the claimed directory is left behind.
		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(true)
	})

	it('recovers after a fully-cleaned failed attempt: a fresh apply on the same target succeeds', async () => {
		const plan = await computeValidPlan()
		const failingDeps = {
			...defaultApplyInitPlanDeps,
			createExclusive: async (targetPath: string, bytes: Uint8Array) => {
				if (targetPath.endsWith('.gitignore'))
					return { outcome: 'failed' as const, error: Object.assign(new Error('simulated crash'), { code: 'EIO' }) }
				return defaultApplyInitPlanDeps.createExclusive(targetPath, bytes)
			},
		}

		const failed = await applyInitPlan(plan, failingDeps)
		expect(failed.applied)
			.toBe(false)
		expect(await pathExists(path.join(tempDir, '.engineering')))
			.toBe(false)

		const succeeded = await applyInitPlan(plan)
		expect(succeeded.applied)
			.toBe(true)
	})

	it('leaves a leftover crashed claim (with its marker) completely untouched on a restarted invocation', async () => {
		await fs.mkdir(path.join(tempDir, '.engineering', '.tmp'), { recursive: true })
		const leftoverMarker = JSON.stringify({ schema: 'ef/init-state@1', nonce: 'deadbeefdeadbeefdeadbeefdeadbeef' })
		await fs.writeFile(path.join(tempDir, '.engineering', '.tmp', 'init-state.json'), leftoverMarker)

		const plan = await computeValidPlan()
		const result = await applyInitPlan(plan)

		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('raced')

		const stillThere = await fs.readFile(path.join(tempDir, '.engineering', '.tmp', 'init-state.json'), 'utf8')
		expect(stillThere)
			.toBe(leftoverMarker)
	})

	// FINDING 2 (P0): the exclusive claim proves ownership only at that one
	// instant. Every step after it is pathname-based, so renaming the claimed
	// `.engineering` directory outside the project and symlinking the
	// original path back to it makes every subsequent write land outside,
	// while byte/nonce verification alone can still pass and `applied: true`
	// still be reported. `verifyClaimIntact` must catch this before every
	// remaining write/read step.
	describe('claimed-directory identity binding (Finding 2 regression)', () => {
		function outsidePath(): string {
			return path.join(os.tmpdir(), `ef-init-swap-outside-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2)}`)
		}

		it('aborts without writing outside when the claim is swapped for a symlink immediately before marker creation', async () => {
			const plan = await computeValidPlan()
			const engineeringPath = path.join(tempDir, '.engineering')
			const tmpPath = path.join(engineeringPath, '.tmp')
			const outsideDir = outsidePath()

			const deps = {
				...defaultApplyInitPlanDeps,
				mkdir: async (targetPath: string) => {
					await defaultApplyInitPlanDeps.mkdir(targetPath)
					if (targetPath === tmpPath) {
						// The reviewer's exact reproduction, timed to land the instant
						// after `.tmp` exists, strictly before the marker would be
						// written: rename the whole claimed directory outside the
						// project, then symlink the original path back to it.
						await fs.rename(engineeringPath, outsideDir)
						await fs.symlink(outsideDir, engineeringPath, 'dir')
					}
				},
			}

			try {
				const result = await applyInitPlan(plan, deps)

				expect(result.applied)
					.toBe(false)
				expect(result.applied === false && result.outcome)
					.toBe('incomplete')

				// The marker -- and every planned file -- must never have been
				// written outside: the swap is caught before `writeInitMarker` (and
				// everything after it) is ever invoked.
				expect(await fs.readdir(outsideDir))
					.toEqual(['.tmp'])
				expect(await fs.readdir(path.join(outsideDir, '.tmp')))
					.toEqual([])

				// Cleanup removed only the dangling symlink left at the claimed
				// path; the relocated original directory was never touched.
				await expect(fs.lstat(engineeringPath))
					.rejects.toThrow()
			}
			finally {
				await fs.rm(outsideDir, { recursive: true, force: true })
			}
		})

		it('aborts without publishing any file outside when the claim is swapped for a symlink immediately before file publication', async () => {
			const plan = await computeValidPlan()
			const engineeringPath = path.join(tempDir, '.engineering')
			const lastDir = plan.directories[plan.directories.length - 1]!
			const lastDirPath = path.join(tempDir, lastDir)
			const outsideDir = outsidePath()

			const deps = {
				...defaultApplyInitPlanDeps,
				mkdir: async (targetPath: string) => {
					await defaultApplyInitPlanDeps.mkdir(targetPath)
					if (targetPath === lastDirPath) {
						// Timed to land the instant after every planned directory
						// exists, strictly before the first file is published.
						await fs.rename(engineeringPath, outsideDir)
						await fs.symlink(outsideDir, engineeringPath, 'dir')
					}
				},
			}

			try {
				const result = await applyInitPlan(plan, deps)

				expect(result.applied)
					.toBe(false)
				expect(result.applied === false && result.outcome)
					.toBe('incomplete')

				// Every planned directory (created before the swap) and the marker
				// (written before the swap) are present outside -- but no planned
				// file is: the swap is caught before the first `createExclusive`
				// call.
				const expectedOutsideEntries = [...plan.directories.map(d => d.replace('.engineering/', '')), '.tmp'].sort()
				expect((await fs.readdir(outsideDir)).sort())
					.toEqual(expectedOutsideEntries)
				for (const file of plan.files) {
					await expect(fs.stat(path.join(outsideDir, file.path.replace('.engineering/', ''))))
						.rejects.toThrow()
				}

				await expect(fs.lstat(engineeringPath))
					.rejects.toThrow()
			}
			finally {
				await fs.rm(outsideDir, { recursive: true, force: true })
			}
		})
	})
})
