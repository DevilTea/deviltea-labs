import type { Prompts } from '../prompts'
import type { ArtifactCreateCommandOptions } from './artifact-create'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runArtifactCreateCommand } from './artifact-create'

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
		execFileSync('git', ['init', '-q', '-b', 'main', root])
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
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

	it('exits 1 (identity collision) when the next allocated canonical path is physically occupied by an undecodable file', async () => {
		// An invalid file at the next-allocated path doesn't count as a "visible
		// ID" for allocation (its envelope never decodes), so `nextId` still
		// allocates REQ-001 -- but the canonical path is already physically
		// occupied, which `computeCreatePlan` must still refuse to overwrite.
		await writeFile(root, '.engineering/req/REQ-001.md', 'not a valid EF artifact file at all')
		const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-ID-004')
	})

	it('reports exit 2 when no EF project can be discovered', async () => {
		const bareDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-create-bare-')))
		execFileSync('git', ['init', '-q', '-b', 'main', bareDir])
		try {
			const outcome = await runArtifactCreateCommand(baseOptions({ yes: true }), { cwd: bareDir, executor: createGitExecutor(), prompts: neverPrompts() })
			expect(outcome.exitCode)
				.toBe(2)
		}
		finally {
			await fs.rm(bareDir, { recursive: true, force: true })
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
})
