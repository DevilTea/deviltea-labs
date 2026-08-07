import type { GitExecOutcome, GitExecutor } from '../git/executor'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { directoryIdentity } from '../platform/fs-facts'
import { loadWorkingTreeContext } from './working-tree-context'

/**
 * Wraps a real executor, running `sideEffect` once, immediately BEFORE the
 * first `execIn` call matching `matches`, then passing that call through to
 * the real executor unchanged. Used to simulate an in-place rewrite of
 * `.engineering/ef.yaml` landing exactly in the window between project
 * discovery's own read of the file and this module's later, separate
 * snapshot load.
 */
function withSideEffectBeforeCall(base: GitExecutor, matches: (args: readonly string[]) => boolean, sideEffect: () => Promise<void>): GitExecutor {
	let triggered = false
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: async (root, args, options): Promise<GitExecOutcome> => {
			if (!triggered && matches(args)) {
				triggered = true
				await sideEffect()
			}
			return base.execIn(root, args, options)
		},
	}
}

/**
 * Wraps a real executor, failing only the `n`th `execIn` call matching
 * `matches` (1-indexed); every other call (matching or not) passes through
 * unchanged. Used to fail specifically the association re-check's OWN
 * `findWorktreeRoot` probe (the second `rev-parse --show-toplevel` call)
 * while leaving discovery's own, earlier probe (the first) untouched.
 */
function withNthMatchingCallFailure(base: GitExecutor, matches: (args: readonly string[]) => boolean, n: number, message: string): GitExecutor {
	let count = 0
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (matches(args)) {
				count += 1
				if (count === n)
					return Promise.resolve({ ok: false, failure: { kind: 'unavailable', message } })
			}
			return base.execIn(root, args, options)
		},
	}
}

function isRevParseShowToplevel(args: readonly string[]): boolean {
	return args[0] === 'rev-parse' && args[1] === '--show-toplevel'
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

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`
const GITIGNORE = '.cache/\n.generated/\n.tmp/\n.lock\n'
const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for working-tree-context tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering specification workflow for this repository.

## Scope

This project covers specification-driven engineering artifacts under .engineering.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

The project operates as a single-repository workspace with no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
`

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

async function writeMinimalProject(root: string): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/.gitignore', GITIGNORE)
	await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
}

describe('loadWorkingTreeContext', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-wtc-')))
		git(root, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	it('resolves an ordinary implicit project, returning a snapshot/validation/config bound to the discovered root', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		const result = await loadWorkingTreeContext({ cwd: root }, createGitExecutor())
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.context.root)
			.toBe(root)
		expect(result.context.config?.repository.integrationRef)
			.toBe('refs/heads/main')
		expect(result.context.snapshot.artifacts.some(a => a.envelope?.envelope?.id === 'PROJECT'))
			.toBe(true)
		expect(result.context.validation.byId.has('PROJECT'))
			.toBe(true)
	})

	// FINDING 2 (P1, tenth round): `artifact create`'s `applyCreatePlan` binds
	// its own later, separate re-verifications back to discovery's OWN
	// `.engineering` identity observation -- exposed here on `WorkingTreeContext`
	// so that later call site can carry it through its plan (see
	// `application/artifact-create.ts`).
	it('exposes `.engineering`\'s discovery-time identity on the returned context', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		const result = await loadWorkingTreeContext({ cwd: root }, createGitExecutor())
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return

		const expectedIdentity = await directoryIdentity(path.join(root, '.engineering'))
		expect(expectedIdentity)
			.not.toBeUndefined()
		expect(result.context.engineeringIdentity)
			.toEqual(expectedIdentity)
	})

	it('reports stage "resolve" when no EF project can be discovered', async () => {
		const result = await loadWorkingTreeContext({ cwd: root }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.stage)
			.toBe('resolve')
		expect(result.reason)
			.toBe('not-found')
	})

	it('reports stage "load" when project resolution succeeds but the snapshot itself fails to load (read-error)', async () => {
		// `.gitignore` is read unconditionally by `loadSnapshotFromWorkingTree`
		// but never inspected by project discovery/resolution, so replacing it
		// with a directory lets `resolveProject` succeed while the snapshot
		// load itself fails with `read-error`.
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		await fs.mkdir(path.join(root, '.engineering', '.gitignore'))

		const result = await loadWorkingTreeContext({ cwd: root }, createGitExecutor())
		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.stage)
			.toBe('load')
		expect(result.reason)
			.toBe('read-error')
	})

	// ---- Finding 9: explicit --project is exempt from association re-checking

	it('skips the association re-check entirely for an explicit project root, even from an unrelated, unassociated cwd', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		// `cwd` is a wholly separate Git worktree that neither contains the
		// project nor is declared as one of its linked repositories -- ordinary
		// implicit discovery from this `cwd` would never even find `.engineering`
		// (it cannot ascend into an unrelated sibling tree), and if association
		// WERE (wrongly) re-checked for an explicit root, it would report
		// `unassociated` even though the caller explicitly named this project.
		const unrelatedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-wtc-unrelated-')))
		git(unrelatedCwd, ['init', '-q', '-b', 'main'])
		try {
			const result = await loadWorkingTreeContext({ cwd: unrelatedCwd, explicitProject: root }, createGitExecutor())
			expect(result.ok)
				.toBe(true)
			if (!result.ok)
				return
			expect(result.context.root)
				.toBe(root)
		}
		finally {
			await fs.rm(unrelatedCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	// ---- Finding 5 (re-verified here at the shared-helper level): implicit ---
	// ---- discovery re-checks association against the snapshot's OWN, --------
	// ---- freshest config, not project resolution's separate, earlier read ----

	it('implicit discovery reports stage "association" when an in-place ef.yaml rewrite revokes the linked-repository association discovery itself relied on', async () => {
		const configWithLinked = CONFIG_YAML.replace('linked_repositories: []', 'linked_repositories:\n  - id: linked\n    path: linked\n    role: implementation\n    required: true\n')
		await writeFile(root, '.engineering/ef.yaml', configWithLinked)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)

		const linkedDir = path.join(root, 'linked')
		await fs.mkdir(linkedDir)
		git(linkedDir, ['init', '-q', '-b', 'main'])

		// The rewrite (to a config with no linked repositories) lands during
		// discovery's own `findWorktreeRoot` probe -- strictly after discovery
		// already captured the linked-repository config for its own (now
		// stale) association decision, and strictly before this module's
		// later, separate snapshot load, which will observe the rewritten
		// config.
		const executor = withSideEffectBeforeCall(
			createGitExecutor(),
			isRevParseShowToplevel,
			async () => { await fs.writeFile(path.join(root, '.engineering', 'ef.yaml'), CONFIG_YAML) },
		)

		const result = await loadWorkingTreeContext({ cwd: linkedDir }, executor)
		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.stage)
			.toBe('association')
		expect(result.reason)
			.toBe('unassociated')
	})

	it('implicit discovery reports stage "association" with reason "git-unavailable" when the re-check probe itself fails', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		// Discovery itself makes TWO `rev-parse --show-toplevel` calls that must
		// both succeed for `resolveProject` to resolve at all: its own
		// worktree-root verification (1st), then its own (implicit-discovery)
		// association check (2nd, `discoverProject`'s inline
		// `checkWorkingDirectoryAssociation` call). This module's OWN,
		// independent re-check is the THIRD matching call -- the one that must
		// fail here.
		const executor = withNthMatchingCallFailure(createGitExecutor(), isRevParseShowToplevel, 3, 'stub: rev-parse transiently unavailable')

		const result = await loadWorkingTreeContext({ cwd: root }, executor)
		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.stage)
			.toBe('association')
		expect(result.reason)
			.toBe('git-unavailable')
		expect(result.message)
			.toContain('stub: rev-parse transiently unavailable')
	})
})
