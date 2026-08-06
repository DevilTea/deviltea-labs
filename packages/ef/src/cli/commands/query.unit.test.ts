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
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
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
})
