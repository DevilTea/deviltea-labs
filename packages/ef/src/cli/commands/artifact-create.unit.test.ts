import type { GitExecOutcome, GitExecutor } from '../../git/executor'
import type { Prompts } from '../prompts'
import type { ArtifactCreateCommandOptions } from './artifact-create'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runArtifactCreateCommand } from './artifact-create'

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

/**
 * Wraps a real executor, running `sideEffect` once, immediately BEFORE the
 * first `execIn` call matching `matches`, then passing that call through to
 * the real executor unchanged. Used to simulate `.engineering` being replaced
 * by a DIFFERENT real directory landing exactly in the window between
 * project resolution's own `.engineering` identity observation (captured
 * during `discoverProject`'s `findWorktreeRoot` probe, matched here) and this
 * command's later, separate snapshot walk (Finding 4/11).
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

// `unlinkMock`/`linkMock`/`lstatMock`/`openMock` let a test inject a
// real-filesystem failure/race strictly inside `applyCreatePlan`'s own
// internals -- exercised here through the CLI's actual, non-injected
// dependency wiring (this command has no `applyCreatePlan`-deps injection
// point of its own; see the exit-mapping regressions below). Every test that
// does not explicitly arm one gets a plain passthrough to the real
// implementation.
const { unlinkMock, linkMock, lstatMock, openMock, realFns } = vi.hoisted(() => ({
	unlinkMock: vi.fn(),
	linkMock: vi.fn(),
	lstatMock: vi.fn(),
	openMock: vi.fn(),
	realFns: {
		unlink: undefined as unknown as typeof import('node:fs/promises').unlink,
		link: undefined as unknown as typeof import('node:fs/promises').link,
		lstat: undefined as unknown as typeof import('node:fs/promises').lstat,
		open: undefined as unknown as typeof import('node:fs/promises').open,
	},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	realFns.unlink = actual.unlink
	realFns.link = actual.link
	realFns.lstat = actual.lstat
	realFns.open = actual.open
	unlinkMock.mockImplementation((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args))
	linkMock.mockImplementation((...args: Parameters<typeof actual.link>) => actual.link(...args))
	lstatMock.mockImplementation((...args: Parameters<typeof actual.lstat>) => actual.lstat(...args))
	openMock.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args))
	return { ...actual, unlink: unlinkMock, link: linkMock, lstat: lstatMock, open: openMock }
})

/** Every `execIn` call fails; simulates Git becoming unavailable during project resolution. */
function unavailableExecutor(message: string): GitExecutor {
	return {
		exec: async () => ({ ok: false, failure: { kind: 'unavailable', message } }),
		execIn: async () => ({ ok: false, failure: { kind: 'unavailable', message } }),
	}
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
summary: A minimal example project used for CLI artifact-create tests.
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

function neverPrompts(): Prompts {
	return {
		intro: () => {},
		outro: () => {},
		note: () => {},
		text: async () => { throw new Error('text prompt must not be called') },
		confirm: async () => { throw new Error('confirm prompt must not be called') },
		confirmMutation: async () => { throw new Error('confirmMutation must not be called') },
	}
}

function baseOptions(overrides: Partial<ArtifactCreateCommandOptions> = {}): ArtifactCreateCommandOptions {
	return {
		type: 'req',
		title: 'Search Result Filtering',
		summary: 'Search results must support filtering by supported criteria.',
		format: 'json',
		noColor: false,
		noInput: true,
		dryRun: false,
		yes: false,
		...overrides,
	}
}

describe('runArtifactCreateCommand', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-')))
		initGitFixture(root)
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		unlinkMock.mockImplementation((...args: Parameters<typeof realFns.unlink>) => realFns.unlink(...args))
		linkMock.mockImplementation((...args: Parameters<typeof realFns.link>) => realFns.link(...args))
		lstatMock.mockImplementation((...args: Parameters<typeof realFns.lstat>) => realFns.lstat(...args))
		openMock.mockImplementation((...args: Parameters<typeof realFns.open>) => realFns.open(...args))
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		unlinkMock.mockClear()
		linkMock.mockClear()
		lstatMock.mockClear()
		openMock.mockClear()
	})

	function deps(prompts: Prompts = neverPrompts()) {
		return { cwd: root, executor: createGitExecutor(), prompts }
	}

	it('applies the plan and exits 0 with --yes in no-input mode', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({ schema: 'ef/mutation-result@1', kind: 'artifact-create', complete: true, applied: true, dry_run: false })
		expect(json.artifact.id)
			.toBe('REQ-001')
		expect(json.changes)
			.toEqual([{ action: 'create', path: '.engineering/req/REQ-001.md' }])
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).resolves.toBeTruthy()
	})

	it('--dry-run returns a complete unapplied plan and writes nothing', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ dryRun: true }), deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({ complete: true, applied: false, dry_run: true })
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	it('exits 2 without writing when authorization is missing in no-input mode', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions(), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	it('exits 2 for an unsupported type token', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true, type: 'bogus' }), deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 2 for the project type token (PROJECT is created only by ef init)', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true, type: 'project' }), deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 2 when required non-interactive values are missing', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true, title: undefined }), deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 2 (allocation incomplete) when an undecodable file occupies the canonical directory for the requested prefix', async () => {
		// An invalid file inside the requested prefix's canonical directory is
		// identity-uncertain: its envelope never decodes, so its greatest
		// visible component cannot be determined and `computeCreatePlan` must
		// refuse to allocate at all (02-identity.md Allocation), rather than
		// silently skip it and allocate REQ-001 as if it weren't there.
		await writeFile(root, '.engineering/req/REQ-999.md', 'not a valid EF artifact file at all')
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	it('reports exit 2 when no EF project can be discovered', async () => {
		const bareDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-bare-')))
		initGitFixture(bareDir)
		try {
			const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), { cwd: bareDir, executor: createGitExecutor(), prompts: neverPrompts() })
			expect(outcome.exitCode)
				.toBe(2)
		}
		finally {
			await fs.rm(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	// ---- Interactive confirmation ------------------------------------------------

	it('applies the plan after an accepted interactive confirmation', async () => {
		const prompts: Prompts = { ...neverPrompts(), confirmMutation: async () => true }
		const outcome = await runArtifactCreateCommand(baseOptions({ format: 'human', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).resolves.toBeTruthy()
	})

	it('declining the interactive confirmation writes nothing and exits 2', async () => {
		const prompts: Prompts = { ...neverPrompts(), confirmMutation: async () => false }
		const outcome = await runArtifactCreateCommand(baseOptions({ format: 'human', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	it('collects missing title/summary interactively', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async (opts) => {
				if (opts.message === 'Title')
					return 'Interactive Title'
				if (opts.message === 'Summary')
					return 'Interactive summary sentence.'
				throw new Error(`unexpected text prompt: ${opts.message}`)
			},
			confirm: async () => { throw new Error('unexpected confirm prompt') },
			confirmMutation: async () => true,
		}
		const outcome = await runArtifactCreateCommand({ type: 'req', format: 'human', noColor: true, noInput: false, dryRun: false, yes: false }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		const written = await fs.readFile(path.join(root, '.engineering/req/REQ-001.md'), 'utf8')
		expect(written)
			.toContain('Interactive Title')
		expect(written)
			.toContain('Interactive summary sentence.')
	})

	// ---- Project resolution / snapshot-load failure reasons --------------------

	it('reports EF-VAL-012 (incomplete-initialization) when .engineering exists without ef.yaml', async () => {
		const bareDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-incomplete-')))
		initGitFixture(bareDir)
		await fs.mkdir(path.join(bareDir, '.engineering'))
		try {
			const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), { cwd: bareDir, executor: createGitExecutor(), prompts: neverPrompts() })
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.diagnostics[0].code)
				.toBe('EF-VAL-012')
		}
		finally {
			await fs.rm(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('reports EF-VAL-006 (git-unavailable) when project resolution itself cannot use Git', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), { cwd: root, executor: unavailableExecutor('stub: git unavailable'), prompts: neverPrompts() })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
	})

	it('reports EF-VAL-001 (not EF-VAL-006) when the project snapshot itself fails to load with a read-error', async () => {
		// `.gitignore` is read unconditionally by `loadSnapshotFromWorkingTree`
		// but never inspected by project discovery/resolution, so replacing it
		// with a directory lets `resolveProject` succeed while the snapshot load
		// itself fails with `read-error` -- the only failure reason that
		// function can actually produce (it never calls Git).
		await fs.rm(path.join(root, '.engineering', '.gitignore'))
		await fs.mkdir(path.join(root, '.engineering', '.gitignore'))

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
	})

	// ---- Non-interactive value collection: summary specifically ----------------

	it('exits 2 naming only "summary" when title is present but summary is missing non-interactively', async () => {
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true, summary: undefined }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].message)
			.toBe('Missing required non-interactive value(s): summary.')
	})

	// ---- Interactive cancellation: title vs. summary ---------------------------

	it('cancelling the interactive Title prompt aborts without writing, exit 2', async () => {
		const prompts: Prompts = { ...neverPrompts(), text: async () => undefined }
		const outcome = await runArtifactCreateCommand({ type: 'req', format: 'json', noColor: true, noInput: false, dryRun: false, yes: false }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].message)
			.toBe('Interactive Artifact creation was cancelled.')
	})

	it('cancelling the interactive Summary prompt (after a supplied Title) aborts without writing, exit 2', async () => {
		const prompts: Prompts = {
			...neverPrompts(),
			text: async (opts) => {
				if (opts.message === 'Summary')
					return undefined
				throw new Error(`unexpected text prompt: ${opts.message}`)
			},
		}
		const outcome = await runArtifactCreateCommand({ type: 'req', title: 'Provided Title', format: 'json', noColor: true, noInput: false, dryRun: false, yes: false }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	// ---- applyCreatePlan outcomes: raced vs. a non-raced apply failure ---------

	it('exits 1 (raced, EF-ID-004) when the target path is created concurrently between confirmation and publication', async () => {
		// Simulates a genuine race: another process creates the exact
		// next-allocated path during the async gap between the plan being
		// computed and the interactive mutation confirmation resolving.
		const prompts: Prompts = {
			...neverPrompts(),
			confirmMutation: async () => {
				await fs.mkdir(path.join(root, '.engineering/req'), { recursive: true })
				await fs.writeFile(path.join(root, '.engineering/req/REQ-001.md'), 'raced content')
				return true
			},
		}
		const outcome = await runArtifactCreateCommand(baseOptions({ format: 'json', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(true)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-ID-004')
		const content = await fs.readFile(path.join(root, '.engineering/req/REQ-001.md'), 'utf8')
		expect(content)
			.toBe('raced content')
	})

	// FINDING 3 (P1, twelfth round): `applyCreatePlan`'s pre-write re-
	// verification reload can fail with `read-error` (an I/O failure), not
	// only a proven race -- and a read/permission/I/O failure does not
	// establish that another writer invalidated the plan. This must map to
	// exit `2` (`EF-VAL-001`, `complete: false`), never exit `1`
	// (`EF-ID-004`/`raced`, `complete: true`) as a proven race would.
	// Reproduced through the CLI's real, non-injected `applyCreatePlan`
	// wiring (this command has no dependency-injection seam of its own for
	// it): `.gitignore` is read unconditionally by
	// `loadSnapshotFromWorkingTree` but never inspected by project
	// resolution, so replacing it with a directory strictly between
	// interactive confirmation and `applyCreatePlan`'s own internal reload
	// forces that LATER reload -- not the command's initial project load --
	// to fail with `read-error`.
	it('exits 2 (incomplete, EF-VAL-001 -- not exit 1/raced) when the pre-write re-verification reload inside applyCreatePlan itself fails with a read-error', async () => {
		const prompts: Prompts = {
			...neverPrompts(),
			confirmMutation: async () => {
				await fs.rm(path.join(root, '.engineering/.gitignore'))
				await fs.mkdir(path.join(root, '.engineering/.gitignore'))
				return true
			},
		}
		const outcome = await runArtifactCreateCommand(baseOptions({ format: 'json', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')

		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	// ---- Symlinked managed-directory chain (EF-FS-004 domain rejection) -------

	it('exits 1 (EF-FS-004) and writes nothing outside the project when the canonical type directory is a symlink', async () => {
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-outside-')))
		try {
			await fs.mkdir(path.join(root, '.engineering'), { recursive: true })
			await fs.symlink(outsideDir, path.join(root, '.engineering/req'))

			const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
			expect(outcome.exitCode)
				.toBe(1)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(true)
			expect(json.applied)
				.toBe(false)
			expect(json.diagnostics[0].code)
				.toBe('EF-FS-004')

			// Nothing was written into the symlink's external target.
			expect(await fs.readdir(outsideDir))
				.toEqual([])
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('exits 2 (incomplete, not raced) when the temporary file cannot be written (unwritable canonical directory)', async () => {
		// The canonical type directory exists (so `ensureDirectory` and the
		// initial target-existence check both succeed cleanly) but is
		// unwritable, so `writeTempFileComplete` itself fails -- distinct from
		// the already-exists ("raced") outcome, since the target path was
		// never occupied.
		await fs.mkdir(path.join(root, '.engineering/req'), { recursive: true })
		await fs.chmod(path.join(root, '.engineering/req'), 0o555)
		try {
			const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(false)
			expect(json.applied)
				.toBe(false)
			expect(json.diagnostics[0].code)
				.toBe('EF-VAL-001')
			expect(json.diagnostics[0].message)
				.toContain('Failed to write the temporary file')
		}
		finally {
			await fs.chmod(path.join(root, '.engineering/req'), 0o755)
		}
	})

	// ---- FINDING 3 (P1): every `applied: true` outcome other than a plain
	// verified success maps to `complete: false, applied: true`, exit `3` --
	// never exit `2` (reserved for missing/declined authorization) and never a
	// plain success (13-cli-contract.md "the implementation MUST NOT
	// misreport the published state as unapplied"). Both regressions below
	// exercise the CLI's real, non-injected `applyCreatePlan` wiring (this
	// command has no dependency-injection seam of its own for it), reproduced
	// through a real filesystem failure/race rather than a mocked
	// `applyCreatePlan` result. --------------------------------------------

	it('exits 3 (applied:true, complete:false, EF-VAL-008) when the verified temporary file cannot be unlinked after a successful publish', async () => {
		// Finding 2's cleanup-failure outcome: the publish itself, and every
		// post-publication verification, succeeds -- only the final,
		// otherwise-best-effort removal of the now-superfluous temporary file
		// fails.
		unlinkMock.mockImplementation(async (...args: Parameters<typeof realFns.unlink>) => {
			const target = args[0]
			if (typeof target === 'string' && target.includes('.tmp-'))
				throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
			return realFns.unlink(...args)
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(true)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-008')

		// The publication itself is genuine and must not be misreported as
		// unapplied: the file is on disk with the planned ID.
		const written = await fs.readFile(path.join(root, '.engineering/req/REQ-001.md'), 'utf8')
		expect(written)
			.toContain('id: REQ-001')
	})

	it('exits 3 (applied:true, complete:false, EF-VAL-008) when the published file cannot be verified intact immediately after publication', async () => {
		// The existing (pre-Finding-2) post-publication recovery state: the
		// managed chain is swapped for a different real directory from inside
		// the real `link()` call itself, strictly after that call genuinely
		// succeeds, so `applyCreatePlan`'s post-publication re-verification
		// cannot confirm the published file's identity and cannot safely
		// retract it either. Reproduced here through the CLI's real dependency
		// wiring, not a mocked `applyCreatePlan` result.
		linkMock.mockImplementation(async (...args: Parameters<typeof realFns.link>) => {
			const [tempPathArg, targetPathArg] = args as [string, string]
			await realFns.link(tempPathArg, targetPathArg)
			const typeDirPath = path.dirname(targetPathArg)
			const shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-shadow-'))
			await fs.rm(typeDirPath, { recursive: true, force: true })
			await fs.rename(shadowDir, typeDirPath)
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(true)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-008')
	})

	// FINDING 2 (P1, sixteenth round): a rejection from the temporary file's
	// own `handle.close()` (now `OwnedFileLease.release()`, which itself never
	// throws) must never escape as an uncaught rejection and must never be
	// misreported as exit `3` (internal defect) when it happens BEFORE any
	// canonical publication -- it belongs to exit `2`'s execution/permission-
	// inability class instead. Reproduced here through the CLI's real,
	// non-injected `applyCreatePlan` wiring by mocking the real `open()` call
	// itself: the temporary file's handle is genuinely written and fsynced
	// exactly as production code does, but its `close` is made to reject, and
	// a genuine race (the canonical target created for real, from inside the
	// SAME hook) drives a natural pre-publication rejection that the release
	// failure then overrides.
	it('exits 2 (applied:false, complete:false, incomplete) -- never exit 3 -- when the temporary file\'s handle close() fails before any canonical publication', async () => {
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string, string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.includes('.tmp-')) {
				// Simulate a genuine race, from inside this same hook, strictly
				// after the temporary file's own handle is opened: the
				// canonical target is created for real, so the post-write
				// `targetExists` re-check reports a genuine race -- a natural
				// pre-publication rejection this test's close failure then
				// overrides.
				const targetPath = path.join(path.dirname(target), 'REQ-001.md')
				await fs.writeFile(targetPath, 'raced-in-from-elsewhere')
				return {
					writeFile: real.writeFile.bind(real),
					sync: real.sync.bind(real),
					stat: real.stat.bind(real),
					read: real.read.bind(real),
					close: async () => {
						await real.close()
						throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })
					},
				}
			}
			return real
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
	})

	// FINDING (P1, fourteenth round): the post-publication re-verification's
	// own observation calls (`lstat`, via `deps.fileIdentity`) can rethrow an
	// unexpected, non-`ENOENT` error exactly like any other `lstat`-based
	// check -- an unguarded `await` there previously let such an error escape
	// `applyCreatePlan` entirely after publication had ALREADY physically
	// occurred, and this command's own outer `catch` then reported
	// `applied: false`, misreporting a genuine publication as unapplied.
	// Reproduced here through the CLI's real, non-injected `applyCreatePlan`
	// wiring by forcing the real `lstat` primitive to fail for the published
	// path itself, immediately after the real `link()` call has already
	// succeeded.
	it('exits 3 (applied:true, complete:false, EF-VAL-008) -- never applied:false -- when the post-publication identity re-check itself throws an unexpected error after a real, successful hard link', async () => {
		let targetPath: string | undefined
		let armed = false
		lstatMock.mockImplementation(async (...args: Parameters<typeof realFns.lstat>) => {
			const [target] = args as [string]
			if (armed && target === targetPath) {
				armed = false
				throw Object.assign(new Error('input/output error'), { code: 'EIO' })
			}
			return realFns.lstat(...args)
		})
		linkMock.mockImplementation(async (...args: Parameters<typeof realFns.link>) => {
			const [tempPathArg, targetPathArg] = args as [string, string]
			await realFns.link(tempPathArg, targetPathArg)
			targetPath = targetPathArg
			armed = true
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(true)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-008')

		// The publication itself genuinely happened and must not be
		// misreported as unapplied: the file is on disk with the planned ID.
		const written = await fs.readFile(path.join(root, '.engineering/req/REQ-001.md'), 'utf8')
		expect(written)
			.toContain('id: REQ-001')
	})

	// FINDING B (P1, eighteenth round): `applyCreatePlan`'s pre-publication
	// re-checks (`verifyManagedDirectoryChain`'s own `isSymlink`/`directoryIdentity`
	// calls, among others) can rethrow a non-`ENOENT` `lstat` failure exactly
	// like any other `lstat`-based check in this package -- once the
	// temporary file's own lease was already acquired (the temp file having
	// already been written for real), an un-guarded `await` chain in
	// `applyCreatePlan` let such a failure escape as an uncaught rejection
	// entirely, and this command's own generic top-level `catch` then
	// reported exit `3` (an internal implementation defect) for what is, in
	// fact, an ordinary execution/permission failure -- 13-cli-contract.md
	// exit `2`'s own class. Reproduced here through the CLI's real,
	// non-injected `applyCreatePlan` wiring by forcing the real `lstat`
	// primitive to fail exactly once, immediately after the real temporary
	// file `open()` call has already succeeded.
	it('exits 2 (applied:false, complete:false, incomplete) -- never exit 3 -- when the first post-write managed-chain probe throws immediately after a real temp write succeeds', async () => {
		let armed = false
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.includes('.tmp-'))
				armed = true
			return real
		})
		lstatMock.mockImplementation(async (...args: Parameters<typeof realFns.lstat>) => {
			if (armed) {
				armed = false
				throw Object.assign(new Error('permission denied'), { code: 'EACCES', syscall: 'lstat' })
			}
			return realFns.lstat(...args)
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)

		// No canonical publication occurred.
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).rejects.toThrow()
	})

	// Control: a genuine programmer/invariant error (never carrying an fs
	// `.code`) from the exact same call site must still be reported as exit
	// `3` -- the classification distinguishes an ordinary execution/permission
	// failure from a real internal defect, it does not blanket-contain every
	// exception.
	it('control: still exits 3 (an internal defect) when a genuine programmer error is thrown from the same post-write chain-probe call site', async () => {
		let armed = false
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.includes('.tmp-'))
				armed = true
			return real
		})
		lstatMock.mockImplementation(async (...args: Parameters<typeof realFns.lstat>) => {
			if (armed) {
				armed = false
				throw new TypeError('invariant violated: unreachable state')
			}
			return realFns.lstat(...args)
		})

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
	})

	// ---- Finding 11: bound-load -- `.engineering` identity threaded into ------
	// ---- the snapshot walk, exactly like query/validate ------------------------

	it('reports a typed incomplete failure, without allocating, when `.engineering` is replaced by a substitute directory hiding the highest REQ between project resolution and the snapshot walk', async () => {
		// `REQ-001` already exists, so the correct next allocation is
		// `REQ-002`. The substitute directory below carries the SAME
		// `ef.yaml`/`.gitignore`/`PROJECT.md` but OMITS `req/REQ-001.md`
		// entirely -- if this command failed to bind the snapshot walk to
		// project resolution's own `.engineering` identity observation
		// (Finding 4/11), it would silently enumerate the substitute instead
		// and allocate `REQ-001` again, corrupting the project with two
		// files both claiming that ID.
		await writeFile(root, '.engineering/req/REQ-001.md', 'placeholder existing REQ-001, must never be duplicated')

		const originalEngineeringPath = path.join(root, '.engineering')
		const executor = withSideEffectBeforeCall(
			createGitExecutor(),
			args => args[0] === 'rev-parse' && args[1] === '--show-toplevel',
			async () => {
				const asideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-orig-'))
				await fs.rename(originalEngineeringPath, path.join(asideDir, '.engineering'))
				await fs.mkdir(originalEngineeringPath)
				await fs.copyFile(path.join(asideDir, '.engineering', 'ef.yaml'), path.join(originalEngineeringPath, 'ef.yaml'))
				await fs.copyFile(path.join(asideDir, '.engineering', '.gitignore'), path.join(originalEngineeringPath, '.gitignore'))
				await fs.copyFile(path.join(asideDir, '.engineering', 'PROJECT.md'), path.join(originalEngineeringPath, 'PROJECT.md'))
				// `req/REQ-001.md` is deliberately never copied into the substitute.
			},
		)

		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), { cwd: root, executor, prompts: neverPrompts() })

		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
		expect(json.artifact)
			.toBeNull()

		// No allocation happened at all: the substitute `.engineering/req/`
		// gained no new file.
		await expect(fs.readdir(path.join(originalEngineeringPath, 'req'))
			.catch(() => [])).resolves.toEqual([])
	})
})
