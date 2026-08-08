import type { GitExecOutcome, GitExecutor } from '../../git/executor'
import type { Prompts } from '../prompts'
import type { InitCommandOptions, InitCommandValues } from './init'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runInitCommand } from './init'

// `openMock`/`lstatMock` let a test inject a real-filesystem failure strictly
// inside `applyInitPlan`'s own internals -- exercised here through the CLI's
// actual, non-injected dependency wiring (this command has no
// `applyInitPlan`-deps injection point of its own). Every test that does not
// explicitly arm one gets a plain passthrough to the real implementation.
const { openMock, lstatMock, realFns } = vi.hoisted(() => ({
	openMock: vi.fn(),
	lstatMock: vi.fn(),
	realFns: {
		open: undefined as unknown as typeof import('node:fs/promises').open,
		lstat: undefined as unknown as typeof import('node:fs/promises').lstat,
	},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	realFns.open = actual.open
	realFns.lstat = actual.lstat
	openMock.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args))
	lstatMock.mockImplementation((...args: Parameters<typeof actual.lstat>) => actual.lstat(...args))
	return { ...actual, open: openMock, lstat: lstatMock }
})

/** Wraps a real executor, forcing failure for every `execIn` call; used to simulate `computeInitPlan`'s own read-only Git checks becoming unavailable. */
function unavailableExecutor(message: string): GitExecutor {
	return {
		exec: async () => ({ ok: false, failure: { kind: 'unavailable', message } }),
		execIn: async () => ({ ok: false, failure: { kind: 'unavailable', message } }),
	}
}

/** Wraps a real executor, forcing `git symbolic-ref --short HEAD` to succeed with empty output (a branch name `detectCurrentBranch` must treat as absent). */
function emptyBranchNameExecutor(base: GitExecutor): GitExecutor {
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (args[0] === 'symbolic-ref')
				return Promise.resolve({ ok: true, result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, signal: null } })
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

/** Applies the same background-maintenance lockdown as {@link git}'s `init` branch, for fixture repositories created outside that helper (e.g. before it exists, or via a real clone). */
function disableBackgroundMaintenance(dir: string): void {
	execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
	execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
	execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
}

const VALUES: InitCommandValues = {
	title: 'Engineering Files',
	summary: 'Engineering Files manages authoritative engineering knowledge as Git-native files.',
	vision: 'Deliver a well-governed engineering specification workflow for this repository.',
	projectScope: 'This project covers specification-driven engineering artifacts under .engineering.',
	nonGoals: 'This project does not manage unrelated deployment tooling.',
	context: 'The project operates as a single-repository workspace with no linked repositories.',
	integrationRef: 'refs/heads/main',
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

function baseOptions(overrides: Partial<InitCommandOptions> = {}): InitCommandOptions {
	return {
		format: 'json',
		noColor: false,
		noInput: true,
		dryRun: false,
		yes: false,
		values: VALUES,
		...overrides,
	}
}

describe('runInitCommand', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-init-')))
		git(root, ['init', '-q', '-b', 'main'])
		openMock.mockImplementation((...args: Parameters<typeof realFns.open>) => realFns.open(...args))
		lstatMock.mockImplementation((...args: Parameters<typeof realFns.lstat>) => realFns.lstat(...args))
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		openMock.mockClear()
		lstatMock.mockClear()
	})

	function deps(prompts: Prompts = neverPrompts()) {
		return { cwd: root, executor: createGitExecutor(), prompts }
	}

	async function engineeringExists(): Promise<boolean> {
		return fs.stat(path.join(root, '.engineering'))
			.then(() => true, () => false)
	}

	it('applies the plan and exits 0 with --yes in no-input mode', async () => {
		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({ schema: 'ef/mutation-result@1', kind: 'init', complete: true, applied: true, dry_run: false })
		expect(json.artifact)
			.toMatchObject({ id: 'PROJECT', type: 'project' })
		expect(await engineeringExists())
			.toBe(true)
		await expect(fs.stat(path.join(root, '.engineering', 'ef.yaml'))).resolves.toBeTruthy()
	})

	it('--dry-run returns a complete unapplied plan and writes nothing', async () => {
		const outcome = await runInitCommand(baseOptions({ dryRun: true }), deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({ complete: true, applied: false, dry_run: true })
		expect(json.changes.length)
			.toBeGreaterThan(0)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('exits 2 without writing when authorization is missing in no-input mode', async () => {
		const outcome = await runInitCommand(baseOptions(), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('exits 2 when required non-interactive values are missing', async () => {
		const outcome = await runInitCommand(baseOptions({ yes: true, values: { ...VALUES, title: undefined } }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('exits 2 for a syntactically invalid integration ref', async () => {
		const outcome = await runInitCommand(baseOptions({ yes: true, values: { ...VALUES, integrationRef: 'main' } }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('exits 2 when --project is not exactly an existing Git worktree root', async () => {
		const sub = path.join(root, 'sub')
		await fs.mkdir(sub)
		const outcome = await runInitCommand(baseOptions({ yes: true, project: sub }), deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 1 when the configured integration branch already has EF state in its history', async () => {
		await fs.mkdir(path.join(root, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(root, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')
		git(root, ['add', '-A'])
		git(root, ['commit', '-q', '-m', 'prior state'])

		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-009')
	})

	// ---- Interactive confirmation ------------------------------------------------

	it('applies the plan after an accepted interactive confirmation', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async () => { throw new Error('unexpected text prompt') },
			confirm: async (opts) => {
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => true,
		}
		const outcome = await runInitCommand(baseOptions({ format: 'human', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		expect(await engineeringExists())
			.toBe(true)
	})

	it('declining the interactive confirmation writes nothing and exits 2', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async () => { throw new Error('unexpected text prompt') },
			confirm: async (opts) => {
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => false,
		}
		const outcome = await runInitCommand(baseOptions({ format: 'human', noInput: false }), deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('collects missing values interactively and confirms the suggested integration ref', async () => {
		const answers: Record<string, string> = {
			'Project title': 'Interactive Title',
			'One-line project summary': 'Interactive summary sentence.',
			'Vision (markdown)': 'Interactive vision.',
			'Scope (markdown)': 'Interactive scope.',
			'Non-goals (markdown)': 'Interactive non-goals.',
			'Context (markdown)': 'Interactive context.',
		}
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async (opts) => {
				const answer = answers[opts.message]
				if (answer === undefined)
					throw new Error(`unexpected text prompt: ${opts.message}`)
				return answer
			},
			confirm: async (opts) => {
				if (opts.message.includes('integration ref'))
					return true
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => true,
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: {} }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		expect(await engineeringExists())
			.toBe(true)
	})

	it('cancelling an interactive text prompt aborts without writing, exit 2', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async () => undefined,
			confirm: async () => { throw new Error('unexpected confirm prompt') },
			confirmMutation: async () => { throw new Error('confirmMutation must not be reached') },
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: {} }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	// ---- detectCurrentBranch edge cases ------------------------------------------

	it('falls back to a plain text prompt for the integration ref when HEAD is detached (no current branch)', async () => {
		await fs.writeFile(path.join(root, 'README.md'), '# placeholder\n')
		git(root, ['add', '-A'])
		git(root, ['commit', '-q', '-m', 'placeholder'])
		git(root, ['checkout', '-q', '--detach'])

		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async (opts) => {
				if (opts.message === 'Integration ref (full local branch ref, e.g. refs/heads/main)')
					return 'refs/heads/main'
				throw new Error(`unexpected text prompt: ${opts.message}`)
			},
			confirm: async (opts) => {
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => true,
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: { ...VALUES, integrationRef: undefined } }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		expect(await engineeringExists())
			.toBe(true)
	})

	it('treats an empty resolved branch name the same as no current branch', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async (opts) => {
				if (opts.message === 'Integration ref (full local branch ref, e.g. refs/heads/main)')
					return 'refs/heads/main'
				throw new Error(`unexpected text prompt: ${opts.message}`)
			},
			confirm: async (opts) => {
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => true,
		}
		const outcome = await runInitCommand(
			{ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: { ...VALUES, integrationRef: undefined } },
			{ cwd: root, executor: emptyBranchNameExecutor(createGitExecutor()), prompts },
		)
		expect(outcome.exitCode)
			.toBe(0)
		expect(await engineeringExists())
			.toBe(true)
	})

	it('cancelling the suggested-integration-ref confirmation aborts without writing, exit 2', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async () => { throw new Error('unexpected text prompt') },
			confirm: async (opts) => {
				if (opts.message.includes('integration ref'))
					return undefined
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => { throw new Error('confirmMutation must not be reached') },
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: { ...VALUES, integrationRef: undefined } }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	it('declining (not cancelling) the suggested integration ref falls back to a plain text prompt', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async (opts) => {
				if (opts.message === 'Integration ref (full local branch ref, e.g. refs/heads/main)')
					return 'refs/heads/main'
				throw new Error(`unexpected text prompt: ${opts.message}`)
			},
			confirm: async (opts) => {
				if (opts.message.includes('integration ref'))
					return false
				if (opts.message.includes('Terminology'))
					return false
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => true,
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: { ...VALUES, integrationRef: undefined } }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(0)
		expect(await engineeringExists())
			.toBe(true)
	})

	it('suggests the resolved target root\'s current branch, not the CWD\'s, when --project points to a different worktree (two-worktree regression)', async () => {
		// 13-cli-contract.md "Project Initialization": interactive init MAY
		// suggest the currently checked-out branch _of the target_, and MUST
		// display the full `refs/heads/...` value. With `ef init --project B`
		// invoked while CWD is A, the branch-suggestion probe must run
		// against resolved target root B, not process CWD A -- otherwise A's
		// branch name could be suggested and persisted into B's
		// immutable-after-bootstrap `integration_ref`.
		git(root, ['checkout', '-q', '-b', 'branch-a'])
		await fs.writeFile(path.join(root, 'a.txt'), 'a\n')
		git(root, ['add', '-A'])
		git(root, ['commit', '-q', '-m', 'commit on branch-a'])

		const otherRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-init-other-')))
		try {
			git(otherRoot, ['init', '-q', '-b', 'branch-b'])
			await fs.writeFile(path.join(otherRoot, 'b.txt'), 'b\n')
			git(otherRoot, ['add', '-A'])
			git(otherRoot, ['commit', '-q', '-m', 'commit on branch-b'])

			let suggestionMessage: string | undefined
			const prompts: Prompts = {
				intro: () => {},
				outro: () => {},
				note: () => {},
				text: async () => { throw new Error('unexpected text prompt') },
				confirm: async (opts) => {
					if (opts.message.includes('integration ref')) {
						suggestionMessage = opts.message
						return true
					}
					if (opts.message.includes('Terminology'))
						return false
					throw new Error(`unexpected confirm prompt: ${opts.message}`)
				},
				confirmMutation: async () => true,
			}

			const outcome = await runInitCommand(
				{ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, project: otherRoot, values: { ...VALUES, integrationRef: undefined } },
				{ cwd: root, executor: createGitExecutor(), prompts },
			)

			expect(outcome.exitCode)
				.toBe(0)
			expect(suggestionMessage)
				.toContain('refs/heads/branch-b')
			expect(suggestionMessage)
				.not.toContain('branch-a')
			await expect(fs.stat(path.join(otherRoot, '.engineering', 'ef.yaml'))).resolves.toBeTruthy()
			const persistedConfig = await fs.readFile(path.join(otherRoot, '.engineering', 'ef.yaml'), 'utf8')
			expect(persistedConfig)
				.toContain('refs/heads/branch-b')
			await expect(fs.stat(path.join(root, '.engineering'))).rejects.toThrow()
		}
		finally {
			await fs.rm(otherRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	// ---- Terminology collection edge cases ---------------------------------------

	it('skips the Terminology prompt entirely when terminology is already provided, and preserves it verbatim', async () => {
		const customTerminology = '| Term | Definition | Avoid or aliases |\n|---|---|---|\n| Widget | A thing. | Gadget |\n'
		const outcome = await runInitCommand(
			{ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: { ...VALUES, terminology: customTerminology } },
			deps({ intro: () => {}, outro: () => {}, note: () => {}, text: neverPrompts().text, confirm: neverPrompts().confirm, confirmMutation: async () => true }),
		)
		expect(outcome.exitCode)
			.toBe(0)
		const written = await fs.readFile(path.join(root, '.engineering', 'PROJECT.md'), 'utf8')
		expect(written)
			.toContain('| Widget | A thing. | Gadget |')
	})

	it('cancelling the "Add Terminology rows now?" confirmation aborts without writing, exit 2', async () => {
		const prompts: Prompts = {
			intro: () => {},
			outro: () => {},
			note: () => {},
			text: async () => { throw new Error('unexpected text prompt') },
			confirm: async (opts) => {
				if (opts.message.includes('Terminology'))
					return undefined
				throw new Error(`unexpected confirm prompt: ${opts.message}`)
			},
			confirmMutation: async () => { throw new Error('confirmMutation must not be reached') },
		}
		const outcome = await runInitCommand({ format: 'human', noColor: true, noInput: false, dryRun: false, yes: false, values: VALUES }, deps(prompts))
		expect(outcome.exitCode)
			.toBe(2)
		expect(await engineeringExists())
			.toBe(false)
	})

	// ---- Target selection: worktree resolution failure -----------------------

	it('exits 2 when cwd (no --project) is not inside any Git worktree at all', async () => {
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-init-outside-')))
		try {
			const outcome = await runInitCommand(baseOptions({ yes: true }), { cwd: outsideDir, executor: createGitExecutor(), prompts: neverPrompts() })
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.diagnostics[0].code)
				.toBe('EF-VAL-001')
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	// ---- computeInitPlan failure reasons ---------------------------------------

	it('exits 2 with EF-VAL-006 when Git becomes unavailable during plan computation', async () => {
		const outcome = await runInitCommand(
			baseOptions({ yes: true, project: root }),
			{ cwd: root, executor: unavailableExecutor('stub: git unavailable'), prompts: neverPrompts() },
		)
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: git unavailable')
	})

	it('exits 2 with EF-VAL-007 (history-incomplete) for a real shallow clone whose visible history hides an earlier .engineering/ef.yaml', async () => {
		// 09-validation.md Bootstrap exception: an inaccessible/incomplete
		// history makes the operation incomplete, not eligible by
		// assumption. Build a real shallow clone (not a stub) so the
		// regression exercises the actual shallow-repository detection: an
		// early commit had `.engineering/ef.yaml`, a later commit removed
		// it, and only that later commit is fetched by the shallow clone.
		await fs.mkdir(path.join(root, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(root, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')
		git(root, ['add', '-A'])
		git(root, ['commit', '-q', '-m', 'bootstrap (hidden ancestor)'])
		git(root, ['rm', '-rq', '.engineering'])
		git(root, ['commit', '-q', '-m', 'remove ef.yaml before the shallow boundary'])

		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-init-shallow-')))
		await fs.rm(shallowDir, { recursive: true, force: true })
		execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, shallowDir], { stdio: 'pipe' })
		disableBackgroundMaintenance(shallowDir)

		try {
			const outcome = await runInitCommand(
				baseOptions({ yes: true, project: shallowDir }),
				{ cwd: shallowDir, executor: createGitExecutor(), prompts: neverPrompts() },
			)
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.diagnostics[0].code)
				.toBe('EF-VAL-007')
			expect(await fs.stat(path.join(shallowDir, '.engineering'))
				.then(() => true, () => false))
				.toBe(false)
		}
		finally {
			await fs.rm(shallowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('exits 2 (missing-value) when title is non-blank but contains a newline', async () => {
		const outcome = await runInitCommand(baseOptions({ yes: true, values: { ...VALUES, title: 'Line one\nLine two' } }), deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
		expect(json.diagnostics[0].message)
			.toContain('single line')
	})

	it('exits 1 (invalid-plan) when a value carries a CRLF line ending into the computed content', async () => {
		const outcome = await runInitCommand(baseOptions({ yes: true, values: { ...VALUES, vision: 'Line one.\r\nLine two.' } }), deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(true)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-FS-005'))
			.toBe(true)
		expect(await engineeringExists())
			.toBe(false)
	})

	// ---- applyInitPlan outcomes: raced vs. a non-raced apply failure -----------

	it('exits 1 (raced) when `.engineering` already exists by the time the plan is applied', async () => {
		await fs.mkdir(path.join(root, '.engineering'))
		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(true)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
	})

	it('exits 2 (incomplete, not raced) when the claim itself fails, e.g. an unwritable target root', async () => {
		await fs.chmod(root, 0o555)
		try {
			const outcome = await runInitCommand(baseOptions({ yes: true }), deps())
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(false)
			expect(json.applied)
				.toBe(false)
			expect(json.diagnostics[0].code)
				.toBe('EF-VAL-001')
		}
		finally {
			await fs.chmod(root, 0o755)
		}
	})

	// FINDING 2 (P1, sixteenth round, matching `cli/commands/artifact-create.ts`'s
	// own regression; corrected in the seventeenth round -- see
	// `application/init.ts`'s own Finding 1, seventeenth round): a rejection
	// from a tracked file's own `handle.close()` (now
	// `OwnedFileLease.release()`, which itself never throws) must never
	// escape as an uncaught rejection. Initialization genuinely, physically
	// completed here -- the marker was verified and removed -- before the
	// release failure occurred, so 13-cli-contract.md's "publication succeeds
	// but a later cleanup or internal operation fails" rule applies:
	// `complete: false`, `applied: true`, exit `3`, `EF-VAL-008` (matching
	// `cli/commands/artifact-create.ts`'s own mapping) -- never `applied:
	// false` (the sixteenth round's own mistake, which misreported a
	// completed publication as never having happened), and never a plain
	// success. Reproduced here through the CLI's real, non-injected
	// `applyInitPlan` wiring by mocking the real `open()` call itself: the
	// marker's own handle is genuinely written exactly as production code
	// does, but its `close` is made to reject, downgrading an otherwise fully
	// successful `ef init` from exit `0` to exit `3`.
	it('exits 3 (applied:true, complete:false, cleanup-failed, EF-VAL-008) -- never applied:false, never exit 2, never a plain success -- when a tracked file\'s handle close() fails', async () => {
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.endsWith(path.join('.tmp', 'init-state.json'))) {
				return {
					writeFile: real.writeFile.bind(real),
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

		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(true)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-008')

		// The initialization genuinely, fully completed on disk -- only
		// releasing the marker's lease afterward failed.
		await expect(fs.stat(path.join(root, '.engineering', 'ef.yaml'))).resolves.toBeTruthy()
	})

	// FINDING A (P1, eighteenth round): `applyInitPlan`'s internal
	// ownership-proof probes (`verifyClaimIntact`'s own
	// `directoryIdentity(plan.targetRoot)` call, among others) can rethrow a
	// non-`ENOENT` `lstat` failure exactly like any other `lstat`-based check
	// in this package -- once the marker's own lease was already tracked (the
	// marker having already been written for real), an un-guarded `await`
	// chain in `applyInitPlan` let such a failure escape as an uncaught
	// rejection entirely, and this command's own generic top-level `catch`
	// then reported exit `3` (an internal implementation defect) for what is,
	// in fact, an ordinary execution/permission failure -- 13-cli-contract.md
	// exit `2`'s own class. Reproduced here through the CLI's real,
	// non-injected `applyInitPlan` wiring by forcing the real `lstat`
	// primitive to fail exactly once, immediately after the real marker
	// `open()` call has already succeeded.
	it('exits 2 (applied:false, complete:false, incomplete) -- never exit 3 -- when a non-ENOENT identity probe throws immediately after the marker is written for real', async () => {
		let armed = false
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.endsWith(path.join('.tmp', 'init-state.json')))
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

		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
	})

	// Control: a genuine programmer/invariant error (never carrying an fs
	// `.code`) from the exact same call site must still be reported as exit
	// `3` -- the classification distinguishes an ordinary execution/permission
	// failure from a real internal defect, it does not blanket-contain every
	// exception.
	it('control: still exits 3 (an internal defect) when a genuine programmer error is thrown from the same identity-probe call site', async () => {
		let armed = false
		openMock.mockImplementation(async (...args: Parameters<typeof realFns.open>) => {
			const [target] = args as [string]
			const real = await realFns.open(...args)
			if (typeof target === 'string' && target.endsWith(path.join('.tmp', 'init-state.json')))
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

		const outcome = await runInitCommand(baseOptions({ yes: true }), deps())

		expect(outcome.exitCode)
			.toBe(3)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
	})
})
