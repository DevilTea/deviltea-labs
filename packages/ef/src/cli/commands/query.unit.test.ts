import type { GitExecOutcome, GitExecutor } from '../../git/executor'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runQueryCommand } from './query'

/** Wraps a real executor, forcing failure for `execIn` calls matching `shouldFail`; every other call passes through unchanged. */
function withSelectiveFailure(base: GitExecutor, shouldFail: (args: readonly string[]) => boolean, message: string): GitExecutor {
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (shouldFail(args))
				return Promise.resolve({ ok: false, failure: { kind: 'unavailable', message } })
			return base.execIn(root, args, options)
		},
	}
}

/**
 * Wraps a real executor, running `sideEffect` once, immediately BEFORE the
 * first `execIn` call matching `matches`, then passing that call through to
 * the real executor unchanged. Used to simulate an in-place rewrite of
 * `.engineering/ef.yaml` landing exactly in the window between project
 * discovery's own read of the file (which happens synchronously before
 * `discoverProject`'s `findWorktreeRoot` call) and a later, separate read
 * (`loadSnapshotFromWorkingTree`'s own) -- Finding 3.
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
summary: A minimal example project used for CLI query tests.
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

function requirementMd(id: string, title: string): string {
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: ${title}
status: active
summary: A minimal example requirement used for CLI query tests, mentioning filtering.
tags: []
relations: []
resources: []
---

## Requirement

The system must support filtering by supported criteria.

## Rationale

Because it is needed.

## Acceptance Criteria

- The system behaves as specified.
`
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

describe('runQueryCommand', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-query-')))
		git(root, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	function deps() {
		return { cwd: root, executor: createGitExecutor() }
	}

	it('reports EF-QRY-013 with exit 2 when no EF project can be discovered', async () => {
		const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.data)
			.toBeNull()
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-QRY-013'))
			.toBe(true)
	})

	it('produces exactly one JSON object followed by one LF and exit 0 for a found lookup', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT', projection: 'summary' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		expect(outcome.stdout)
			.toMatch(/\n$/)
		expect((outcome.stdout as string).match(/\n/g))
			.toHaveLength(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toEqual({
				schema: 'ef/query-result@1',
				kind: 'lookup',
				complete: true,
				data: {
					found: true,
					artifact: expect.objectContaining({ id: 'PROJECT', type: 'project' }),
				},
				diagnostics: [],
			})
	})

	it('exits 0 with found:false for a lookup that does not exist (not a failure)', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'lookup', id: 'REQ-999' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.data.found)
			.toBe(false)
	})

	it('exits 2 for relations on a non-existent Artifact ID', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'relations', id: 'REQ-999' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-014')
	})

	it('finds a search match by term across a real project snapshot', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'Search Result Filtering'))
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'search', terms: ['filtering'] }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.data.total)
			.toBe(1)
		expect(json.data.results[0].artifact.id)
			.toBe('REQ-001')
	})

	it('lists artifacts sorted by ID', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		await writeFile(root, '.engineering/req/REQ-002.md', requirementMd('REQ-002', 'Second'))
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'First'))
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'list' }, { format: 'json', noColor: false }, deps())
		const json = JSON.parse(outcome.stdout as string)
		expect(json.data.artifacts.map((a: { id: string }) => a.id))
			.toEqual(['PROJECT', 'REQ-001', 'REQ-002'])
	})

	it('renders human output as parseable JSON containing the same data', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT' }, { format: 'human', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const parsed = JSON.parse(outcome.stdout as string)
		expect(parsed.data.found)
			.toBe(true)
	})

	it('reports EF-QRY-010 with exit 2 for history when no history context can be established', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		// `main` (the configured integration_ref) never resolves in this
		// fixture: the working-tree content is uncommitted, so history context
		// cannot be established even though the Artifact itself is discoverable.
		const outcome = await runQueryCommand({ kind: 'history', id: 'PROJECT' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-010')
	})

	it('establishes history context and reports the bootstrap commit when the integration ref resolves', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		const bootstrapOid = commitAll(root, 'bootstrap')

		const outcome = await runQueryCommand({ kind: 'history', id: 'PROJECT' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(true)
		expect(json.data.artifact_id)
			.toBe('PROJECT')
		expect(json.data.commits)
			.toEqual([{ oid: bootstrapOid, changed_paths: expect.arrayContaining(['.engineering/PROJECT.md']) }])
	})

	it('reports EF-QRY-010 with the underlying Git failure surfaced, not a generic message, when the integration-ref probe itself fails', async () => {
		// `git show-ref` (used only by `GitRepository#resolveRef`) is forced to
		// fail here, simulating the `'error'`/`'git-unavailable'` `RefResolutionResult`
		// kinds -- distinct from the ref simply never having resolved
		// (`'proven-absent'`, already covered by the sibling "no history context
		// can be established" case above). Folding this distinct probe failure
		// into a silently-absent history context previously produced the exact
		// same generic "Required history context is unavailable." message as an
		// ordinary unresolved ref, discarding the actual Git failure detail
		// (parity with `validate.ts`'s `EF-VAL-006` messages, which do surface it).
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const flakyExecutor = withSelectiveFailure(createGitExecutor(), args => args[0] === 'show-ref', 'stub: show-ref transiently unavailable')
		const outcome = await runQueryCommand({ kind: 'history', id: 'PROJECT' }, { format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.data)
			.toBeNull()
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-010')
		expect(json.diagnostics[0].message)
			.toContain('stub: show-ref transiently unavailable')
	})

	it('reports EF-QRY-013 (project-resolution failure envelope) when the project snapshot cannot be loaded', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		// `.gitignore` is read unconditionally by `loadSnapshotFromWorkingTree`
		// but never inspected by project discovery/resolution, so replacing it
		// with a directory lets `resolveProject` succeed while the snapshot load
		// itself fails with `read-error`, folding into the same envelope as an
		// unresolvable project (10-query-and-trace.md "Invalid Graph and Partial
		// Results").
		await fs.mkdir(path.join(root, '.engineering', '.gitignore'))

		const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.data)
			.toBeNull()
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-013')
	})

	// ---- Finding 3: single observation for history's integration ref --------

	it('uses the integration ref materialized by the snapshot load for history, not project discovery\'s own earlier read of the same file', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML) // integration_ref: refs/heads/main
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		const rewrittenConfig = CONFIG_YAML.replace('refs/heads/main', 'refs/heads/does-not-exist')
		// Project discovery's OWN read of `.engineering/ef.yaml` happens
		// synchronously before `discoverProject` calls `findWorktreeRoot`
		// (`rev-parse --show-toplevel`); triggering the rewrite here simulates
		// an in-place rewrite landing exactly in the window between that read
		// and `loadSnapshotFromWorkingTree`'s own, later, separate read.
		const executor = withSideEffectBeforeCall(
			createGitExecutor(),
			args => args[0] === 'rev-parse' && args[1] === '--show-toplevel',
			async () => { await fs.writeFile(path.join(root, '.engineering', 'ef.yaml'), rewrittenConfig) },
		)

		const outcome = await runQueryCommand({ kind: 'history', id: 'PROJECT' }, { format: 'json', noColor: false }, { cwd: root, executor })
		// If discovery's stale `refs/heads/main` (which DOES resolve, since
		// the fixture committed to `main`) governed history's ref instead of
		// the snapshot load's fresher read, this would incorrectly succeed
		// (exit 0, EF-QRY-010 absent). The single observation this command
		// must use is the rewritten `refs/heads/does-not-exist`, which does
		// NOT resolve, so `EF-QRY-010` is required instead.
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-010')
	})

	// ---- Finding 11: immutable integration_ref (11-filesystem-and-config.md) --

	it('reports untrusted-data for history when the working-tree config is retargeted to a different existing ref whose own bootstrap declares the original ref', async () => {
		// Commit A is the bootstrap: it declares `integration_ref: refs/heads/main`
		// and is the ONLY commit, so it is trivially the walk's own boundary
		// commit. `refs/heads/other` is created pointing at that exact same
		// commit -- an existing ref whose history is entirely self-consistent
		// on its own terms.
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML) // integration_ref: refs/heads/main
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')
		git(root, ['branch', 'other'])

		// The working tree's OWN (uncommitted) config is retargeted to select
		// `refs/heads/other` instead -- a schema-valid edit to an existing ref.
		// Without Finding 11's check 1, `refs/heads/other` resolves fine and its
		// self-consistent history (a single bootstrap commit) would be accepted
		// even though that commit itself never declared `refs/heads/other` as
		// the integration ref.
		const rewrittenConfig = CONFIG_YAML.replace('refs/heads/main', 'refs/heads/other')
		await writeFile(root, '.engineering/ef.yaml', rewrittenConfig)

		const outcome = await runQueryCommand({ kind: 'history', id: 'PROJECT' }, { format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-013')
	})

	// ---- Finding 5: re-run working-directory association against the -------
	// ---- snapshot's fresher config, not project discovery's own earlier read

	it('reports EF-QRY-013 when an in-place ef.yaml rewrite revokes the linked-repository association that discovery itself relied on', async () => {
		// Config A declares `linked` as a linked repository, so a `cwd` inside
		// it is associated with the project. Discovery's OWN association check
		// uses this config; if nothing re-verified it later, the command would
		// proceed to completion from a `cwd` the CURRENT, authoritative
		// configuration no longer associates with the project at all.
		const configA = CONFIG_YAML.replace('linked_repositories: []', 'linked_repositories:\n  - id: linked\n    path: linked\n    role: implementation\n    required: true\n')
		await writeFile(root, '.engineering/ef.yaml', configA)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)

		const linkedDir = path.join(root, 'linked')
		await fs.mkdir(linkedDir)
		git(linkedDir, ['init', '-q', '-b', 'main'])

		// The rewrite (to config B, no linked repositories) lands during
		// discovery's own `findWorktreeRoot` probe -- strictly after discovery
		// already captured config A for its own (now stale) association
		// decision, and strictly before `loadSnapshotFromWorkingTree`'s later,
		// separate read, which will observe config B.
		const executor = withSideEffectBeforeCall(
			createGitExecutor(),
			args => args[0] === 'rev-parse' && args[1] === '--show-toplevel',
			async () => { await fs.writeFile(path.join(root, '.engineering', 'ef.yaml'), CONFIG_YAML) },
		)

		const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT' }, { format: 'json', noColor: false }, { cwd: linkedDir, executor })
		// Without re-running the association check against the snapshot's own,
		// fresher config, this would incorrectly succeed (exit 0) from a `cwd`
		// config B no longer declares as associated with the project.
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-013')
	})

	// ---- Finding 9: association is re-checked only for IMPLICIT discovery; ---
	// ---- an explicit --project is exempt (11-filesystem-and-config.md -------
	// ---- "Project Discovery") --------------------------------------------------

	it('succeeds with an explicit --project even when the current working directory is an unrelated, unassociated Git worktree', async () => {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'bootstrap')

		// `unrelatedCwd` is a wholly separate Git worktree that neither
		// contains the project nor is declared as one of its linked
		// repositories. Re-imposing the invocation-CWD requirement after an
		// explicit `--project` resolution (the exact bug this regression
		// guards against) would report `EF-QRY-013` here even though the
		// caller explicitly named this project -- defeating
		// 11-filesystem-and-config.md's exception that "an otherwise-rejected
		// nested worktree can supply another explicit project root instead."
		const unrelatedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-query-unrelated-')))
		git(unrelatedCwd, ['init', '-q', '-b', 'main'])
		try {
			const outcome = await runQueryCommand({ kind: 'lookup', id: 'PROJECT' }, { format: 'json', noColor: false, project: root }, { cwd: unrelatedCwd, executor: createGitExecutor() })
			expect(outcome.exitCode)
				.toBe(0)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(true)
			expect(json.data.found)
				.toBe(true)
		}
		finally {
			await fs.rm(unrelatedCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})
