import type { Prompts } from '../prompts'
import type { InitCommandOptions, InitCommandValues } from './init'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runInitCommand } from './init'

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
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
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
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
})
