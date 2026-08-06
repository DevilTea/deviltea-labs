import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { validateBootstrap } from './bootstrap-validation'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const GITIGNORE = `.cache/
.generated/
.tmp/
.lock
`

const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for bootstrap validation tests.
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

interface RequirementOptions {
	id: string
	status?: string
	lifecycle?: string
}

function requirementMd(options: RequirementOptions): string {
	const status = options.status ?? 'active'
	const lifecycleSection = options.lifecycle !== undefined ? `\n\n## Lifecycle\n\n${options.lifecycle}` : ''
	return `---
schema: ef/requirement@1
type: requirement
id: ${options.id}
title: Example Requirement
status: ${status}
summary: A minimal example requirement used for bootstrap validation tests.
tags: []
relations: []
resources: []
---

## Requirement

The system must behave as specified by this requirement.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

- The system behaves as specified.${lifecycleSection}
`
}

const COMPLETED_CHG_BODY = `## Rationale

This transaction consolidates the example fixture for the test suite.

## Sources

- Direct maintainer decision to exercise this fixture.

## Changes

- Updated the example fixture.

## Verification

Result: passed

- EF schema, relation, lifecycle, and graph validation passed.
`

function changeMd(id: string): string {
	return `---
schema: ef/change@1
type: change
id: ${id}
title: Example Change
status: completed
summary: A minimal example change used for bootstrap validation tests.
tags: []
relations: []
resources: []
---

${COMPLETED_CHG_BODY}`
}

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

function codesOf(diagnostics: readonly { code: string }[]): string[] {
	return diagnostics.map(d => d.code)
		.sort()
}

describe('validateBootstrap', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-bootstrap-')))
		git(tempDir, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	function repo() {
		return createGitRepository(tempDir, createGitExecutor())
	}

	it('is valid for a minimal root-commit bootstrap with an unresolved ref', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(true)
		expect(result.exitCode)
			.toBe(0)
		expect(result.scope)
			.toBe('bootstrap')
		expect(result.proposedOid)
			.toBe(proposedOid)
		expect(result.integrationRef)
			.toBe('refs/heads/main')
		expect(result.expectedRefOid)
			.toBeNull()
	})

	it('is valid for a bootstrap state with draft and active knowledge Artifacts and no CHG', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'bootstrap with draft and active REQs')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.valid)
			.toBe(true)
	})

	it('is valid when the ref was previously unresolved and the bootstrap commit has a non-EF first parent', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary repository content\n')
		commitAll(tempDir, 'ordinary pre-EF history')

		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap on top of ordinary history')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.valid)
			.toBe(true)
	})

	it('reports EF-VAL-009 when the ref already resolves to a commit whose history contains .engineering/ef.yaml', async () => {
		await writeMinimalProject(tempDir)
		const existingEfStateOid = commitAll(tempDir, 'pre-existing EF state')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'attempted re-bootstrap')

		const result = await validateBootstrap({
			git: repo(),
			proposedOid,
			operationStartRefState: { resolved: true, oid: existingEfStateOid },
		})

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-009'])
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(1)
	})

	it('reports EF-VAL-009 when a previously-unresolved ref\'s bootstrap parent history already contains .engineering/ef.yaml', async () => {
		await writeMinimalProject(tempDir)
		const existingEfStateOid = commitAll(tempDir, 'pre-existing EF state')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'attempted re-bootstrap on an unresolved candidate ref')
		void existingEfStateOid

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-009'])
		expect(result.valid)
			.toBe(false)
	})

	it('reports EF-VAL-010 for a terminal (retired) knowledge Artifact in the bootstrap tree', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'retired', lifecycle: 'Retired before activation.' }))
		const proposedOid = commitAll(tempDir, 'bootstrap with a retired REQ')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-010')
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(1)
	})

	it('reports EF-VAL-010 for a CHG Artifact present in the bootstrap tree', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd('CHG-001'))
		const proposedOid = commitAll(tempDir, 'bootstrap with a CHG present')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-010')
	})

	it('reports EF-VAL-011 for a proposed OID that does not resolve to any object', async () => {
		await writeMinimalProject(tempDir)
		commitAll(tempDir, 'bootstrap')

		const result = await validateBootstrap({ git: repo(), proposedOid: 'f'.repeat(40), operationStartRefState: { resolved: false } })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
		expect(result.proposedOid)
			.toBeNull()
	})

	it('reports EF-VAL-011 when the proposed commit does not use the captured ref tip as its first parent', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary pre-EF history, never touched by EF\n')
		const firstOid = commitAll(tempDir, 'ordinary first commit on main, no EF state ever')

		git(tempDir, ['checkout', '-q', '--orphan', 'unrelated'])
		git(tempDir, ['rm', '-rq', '--cached', '.'])
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'unrelated root bootstrap commit')

		const result = await validateBootstrap({
			git: repo(),
			proposedOid,
			operationStartRefState: { resolved: true, oid: firstOid },
		})

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
	})
})
