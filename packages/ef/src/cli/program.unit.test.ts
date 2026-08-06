import type { GitExecutor } from '../git/executor'
import type { Prompts } from './prompts'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { runCli } from './program'

/** Every method throws, simulating an unexpected internal exception rather than a `GitExecutor` failure result. */
function throwingExecutor(): GitExecutor {
	return {
		exec: async () => { throw new Error('boom-exec') },
		execIn: async () => { throw new Error('boom-execIn') },
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
summary: A minimal example project used for CLI program tests.
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

async function writeFile(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
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

describe('runCli', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-program-')))
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	function ctx() {
		return { version: '9.9.9', executor: createGitExecutor(), prompts: neverPrompts() }
	}

	async function setupProject(): Promise<void> {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
	}

	// ---- Pre-envelope failures --------------------------------------------------

	it('rejects an unknown top-level command: empty stdout, exit 2', async () => {
		const outcome = await runCli(['bogus'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
		expect(outcome.stderr.length)
			.toBeGreaterThan(0)
	})

	it('rejects an unknown query subcommand (kind discriminator): empty stdout, exit 2', async () => {
		const outcome = await runCli(['query', 'bogus'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})

	it('rejects an invalid --format value: empty stdout, exit 2', async () => {
		const outcome = await runCli(['validate', '--format', 'xml'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})

	it('rejects an invalid --scope discriminator value: empty stdout, exit 2', async () => {
		const outcome = await runCli(['validate', '--scope', 'bogus'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})

	it('rejects --dry-run on the read-only validate command (option does not apply): exit 2', async () => {
		const outcome = await runCli(['validate', '--dry-run'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})

	it('rejects --format on resource read (the command never accepts it): exit 2', async () => {
		const outcome = await runCli(['resource', 'read', 'PROJECT', '.engineering/resources/x', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('rejects --yes on a query command (mutation-only option): exit 2', async () => {
		const outcome = await runCli(['query', 'list', '--yes'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('rejects --project on ef version (not a project command): exit 2', async () => {
		const outcome = await runCli(['version', '--project', root], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
	})

	// ---- JSON transport guarantee ------------------------------------------------

	it('produces exactly one JSON object followed by one LF for ef version --format json', async () => {
		const outcome = await runCli(['version', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const stdout = outcome.stdout as string
		expect(stdout.endsWith('\n'))
			.toBe(true)
		expect(stdout.match(/\n/g))
			.toHaveLength(1)
		expect(JSON.parse(stdout))
			.toEqual({ schema: 'ef/version-result@1', version: '9.9.9', ef_core_major: 1 })
	})

	it('produces exactly one JSON object followed by one LF for ef validate --format json', async () => {
		await setupProject()
		execFileSync('git', ['-C', root, 'add', '-A'])
		execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'bootstrap'], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } })

		const outcome = await runCli(['validate', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const stdout = outcome.stdout as string
		expect(stdout.match(/\n/g))
			.toHaveLength(1)
		const json = JSON.parse(stdout)
		expect(json.schema)
			.toBe('ef/validation-result@1')
		expect(json.valid)
			.toBe(true)
	})

	it('produces exactly one JSON object followed by one LF for ef query lookup --format json', async () => {
		await setupProject()
		const outcome = await runCli(['query', 'lookup', 'PROJECT', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const stdout = outcome.stdout as string
		expect(stdout.match(/\n/g))
			.toHaveLength(1)
		const json = JSON.parse(stdout)
		expect(json.schema)
			.toBe('ef/query-result@1')
		expect(json.data.found)
			.toBe(true)
	})

	// ---- Resource read byte-exactness through the full CLI ----------------------

	it('writes exact raw bytes for a successful resource read, with no format option involved', async () => {
		await setupProject()
		const location = '.engineering/resources/req/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Example
status: active
summary: Example.
tags: []
relations: []
resources:
  - type: example
    location: ${location}
    role: evidence
    media_type: application/json
    normative: false
    description: An example resource.
---

## Requirement

Text.

## Rationale

Text.

## Acceptance Criteria

- Text.
`)
		const rawBytes = Buffer.from('{"raw":true}', 'utf8')
		await writeFile(root, location, rawBytes)

		const outcome = await runCli(['resource', 'read', 'REQ-001', location], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		expect(Buffer.from(outcome.stdout as Uint8Array))
			.toEqual(rawBytes)
		expect(outcome.stderr)
			.toBe('')
	})

	// ---- Mutation authorization matrix through the full CLI ----------------------

	it('ef artifact create req --dry-run --format json returns a complete unapplied plan, exit 0', async () => {
		await setupProject()
		const outcome = await runCli(['artifact', 'create', 'req', '--title', 'T', '--summary', 'S', '--dry-run', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({ complete: true, applied: false, dry_run: true })
	})

	it('ef artifact create req --format json without --yes or --dry-run exits 2 (JSON implies --no-input)', async () => {
		await setupProject()
		const outcome = await runCli(['artifact', 'create', 'req', '--title', 'T', '--summary', 'S', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.applied)
			.toBe(false)
	})

	it('ef artifact create req --yes --format json applies the plan, exit 0', async () => {
		await setupProject()
		const outcome = await runCli(['artifact', 'create', 'req', '--title', 'T', '--summary', 'S', '--yes', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.applied)
			.toBe(true)
		await expect(fs.stat(path.join(root, '.engineering/req/REQ-001.md'))).resolves.toBeTruthy()
	})

	// ---- ef init through the full CLI (target selection, value collection) ------

	it('ef init --no-input without --yes or --dry-run declines: exit 2, not applied', async () => {
		const outcome = await runCli([
			'init',
			'--no-input',
			'--title',
			'T',
			'--summary',
			'S',
			'--vision',
			'V',
			'--project-scope',
			'PS',
			'--non-goals',
			'NG',
			'--context',
			'C',
			'--integration-ref',
			'refs/heads/main',
			'--format',
			'json',
		], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.applied)
			.toBe(false)
	})

	it('ef init --yes --format json applies a full initialization plan, exit 0', async () => {
		const outcome = await runCli([
			'init',
			'--yes',
			'--title',
			'T',
			'--summary',
			'S',
			'--vision',
			'V',
			'--project-scope',
			'PS',
			'--non-goals',
			'NG',
			'--context',
			'C',
			'--integration-ref',
			'refs/heads/main',
			'--format',
			'json',
		], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.applied)
			.toBe(true)
		await expect(fs.stat(path.join(root, '.engineering', 'ef.yaml'))).resolves.toBeTruthy()
	})

	// ---- ef query list: request-builder rejection routed through both formats ---

	it('ef query list with valid options routes to the application layer and succeeds, exit 0', async () => {
		await setupProject()
		const outcome = await runCli(['query', 'list', '--resource-normative', 'true', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(true)
	})

	it('ef query list --resource-normative <bogus> --format json returns an incomplete EF-QRY-002 result, exit 2', async () => {
		await setupProject()
		const outcome = await runCli(['query', 'list', '--resource-normative', 'maybe', '--format', 'json'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-002')
	})

	it('ef query list --resource-normative <bogus> in human mode renders indented JSON, exit 2', async () => {
		await setupProject()
		const outcome = await runCli(['query', 'list', '--resource-normative', 'maybe'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toContain('\n  ')
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-QRY-002')
	})

	// ---- Group command with no matching leaf: Commander outputs help then throws ---
	// (caught as a CommanderError in runCli's try/catch, not the `outcome ?? ...`
	// fallback -- `query`'s own Command has no .action(), so Commander's
	// exitOverride rejects before any leaf action can call setOutcome.)

	it('ef query with no subcommand rejects as invalid invocation via Commander\'s own exitOverride: exit 2', async () => {
		const outcome = await runCli(['query'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})

	// ---- An unexpected (non-Commander) exception is a distinct exit-3 failure ---

	it('an unhandled exception thrown by a dependency (not a CommanderError) is reported as internal failure, exit 3', async () => {
		await setupProject()
		const outcome = await runCli(['validate'], { cwd: root }, { version: '9.9.9', executor: throwingExecutor(), prompts: neverPrompts() })
		expect(outcome.exitCode)
			.toBe(3)
		expect(outcome.stdout)
			.toBe('')
		expect(outcome.stderr)
			.toContain('Internal CLI failure')
		expect(outcome.stderr)
			.toContain('boom-execIn')
	})

	// ---- ef help / ef version ------------------------------------------------------

	it('ef help exits 0 with non-empty human text', async () => {
		const outcome = await runCli(['help'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		expect((outcome.stdout as string).length)
			.toBeGreaterThan(0)
	})

	it('ef help <unknown> exits 2', async () => {
		const outcome = await runCli(['help', 'bogus'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('ef help validate (an existing topic) exits 0', async () => {
		const outcome = await runCli(['help', 'validate'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
	})

	it('ef version --format human prints the version for people, exit 0', async () => {
		const outcome = await runCli(['version'], { cwd: root }, ctx())
		expect(outcome.exitCode)
			.toBe(0)
		expect(outcome.stdout)
			.toContain('9.9.9')
	})
})
