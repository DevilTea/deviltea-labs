import type { GitRepository } from '../git/repository'
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

/** Applies the same background-maintenance lockdown as {@link git}'s `init` branch, for fixture repositories created outside that helper via a real clone. */
function disableBackgroundMaintenance(dir: string): void {
	execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
	execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
	execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
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

/** Writes a Git blob object (not a commit) and returns its OID, for "resolves to a non-commit object" fixtures. */
function hashBlob(dir: string, content: string): string {
	return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: { ...process.env, ...GIT_TEST_ENV }, input: content, encoding: 'utf8' })
		.trim()
}

/**
 * Delegates every {@link GitRepository} method to `real` except the ones
 * named in `overrides`, so a single low-level Git outcome can be forced
 * (`git-unavailable`, `missing`, etc.) without spawning a real Git failure.
 */
function wrapGitRepository(real: GitRepository, overrides: Partial<GitRepository>): GitRepository {
	return {
		root: real.root,
		findWorktreeRoot: overrides.findWorktreeRoot ?? real.findWorktreeRoot.bind(real),
		getObjectFormat: overrides.getObjectFormat ?? real.getObjectFormat.bind(real),
		resolveCommit: overrides.resolveCommit ?? real.resolveCommit.bind(real),
		resolveRef: overrides.resolveRef ?? real.resolveRef.bind(real),
		getFirstParent: overrides.getFirstParent ?? real.getFirstParent.bind(real),
		readTree: overrides.readTree ?? real.readTree.bind(real),
		readBlob: overrides.readBlob ?? real.readBlob.bind(real),
		listFirstParentHistory: overrides.listFirstParentHistory ?? real.listFirstParentHistory.bind(real),
		pathExistsInFirstParentHistory: overrides.pathExistsInFirstParentHistory ?? real.pathExistsInFirstParentHistory.bind(real),
		diffTrees: overrides.diffTrees ?? real.diffTrees.bind(real),
	}
}

describe('validateBootstrap', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-bootstrap-')))
		git(tempDir, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

	// FINDING A regression: a failed ref probe (Git ran but could not
	// conclusively determine whether `integration_ref` resolves -- distinct
	// from `resolved: false`, which is a PROVEN absence) must make bootstrap
	// incomplete, not validate as though the ref does not exist. Otherwise
	// this "eligible bootstrap target" conclusion (and `expected_ref_oid:
	// null`) would rest on an unproven assumption
	// (09-validation.md "An inaccessible ref ... makes the operation
	// incomplete rather than eligible by assumption").
	it('reports incomplete with EF-VAL-006 (not a valid bootstrap) when the operation-start ref probe failed', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const result = await validateBootstrap({
			git: repo(),
			proposedOid,
			operationStartRefState: { resolved: 'error', message: 'git show-ref --verify --quiet exited with status 128.' },
		})

		expect(result.complete)
			.toBe(false)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
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

	it('reports EF-VAL-006 when git is unavailable while resolving the proposed commit', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const git = wrapGitRepository(repo(), {
			resolveCommit: async () => ({ kind: 'git-unavailable', message: 'simulated resolve failure' }),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated resolve failure')
		expect(result.complete)
			.toBe(false)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-011 for a proposed OID that is not a full commit OID (malformed)', async () => {
		await writeMinimalProject(tempDir)
		commitAll(tempDir, 'bootstrap')

		const result = await validateBootstrap({ git: repo(), proposedOid: 'deadbeef', operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('is not a full commit OID')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-011 when the proposed OID resolves to a non-commit object (a blob)', async () => {
		await writeMinimalProject(tempDir)
		commitAll(tempDir, 'bootstrap')
		const blobOid = hashBlob(tempDir, 'not a commit')

		const result = await validateBootstrap({ git: repo(), proposedOid: blobOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('resolves to a blob, not a commit')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-006 when git is unavailable while materializing the proposed commit', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const real = repo()
		const git = wrapGitRepository(real, {
			readTree: async oid => (oid === proposedOid ? { kind: 'git-unavailable', message: 'simulated readTree failure' } : real.readTree(oid)),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated readTree failure')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-011 when the proposed commit could not be materialized for a reason other than git-unavailable', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const real = repo()
		const git = wrapGitRepository(real, {
			readTree: async oid => (oid === proposedOid ? { kind: 'missing' } : real.readTree(oid)),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('could not be materialized')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-007 when the proposed tree has no ef.yaml to establish an integration_ref', async () => {
		await writeFile(tempDir, '.engineering/.gitignore', GITIGNORE)
		await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
		const proposedOid = commitAll(tempDir, 'bootstrap without ef.yaml')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		// The snapshot-level "no ef.yaml found" diagnostic and this function's own
		// "does not name a valid integration_ref" diagnostic share the same code
		// and location (no path/artifactId), so they dedupe to a single entry
		// (domain/diagnostics.ts dedupeDiagnostics: code + location, excluding
		// message text) -- the control-flow branch under test still runs either way.
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-007'])
		expect(result.diagnostics[0]?.message)
			.toContain('No \'.engineering/ef.yaml\' configuration was found')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('is valid when the ref already resolves to a pre-existing non-EF commit that is the bootstrap commit\'s first parent', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary pre-EF history\n')
		const refTipOid = commitAll(tempDir, 'ordinary pre-EF commit')

		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap on top of the resolved ref tip')

		const result = await validateBootstrap({
			git: repo(),
			proposedOid,
			operationStartRefState: { resolved: true, oid: refTipOid },
		})

		expect(result.diagnostics)
			.toEqual([])
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(true)
		expect(result.exitCode)
			.toBe(0)
		expect(result.expectedRefOid)
			.toBe(refTipOid)
	})

	it('reports EF-VAL-006 when git is unavailable while checking proposed parentage', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'git-unavailable', message: 'simulated parentage failure' }),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated parentage failure')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-011 when the ref was previously unresolved and the proposed commit has inapplicable parentage', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'missing' }),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('has inapplicable parentage')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	// FINDING (bootstrap-validation.ts parentage if-chain): `getFirstParent`'s
	// `error` kind (the commit was proven to exist but its parentage could not
	// be read) is not `missing`/`not-a-commit`/`resolved` -- with an
	// unresolved ref, the parentage if-chain previously handled only those
	// three kinds explicitly and let anything else silently fall through to
	// the trailing "'root-commit': fine" comment, treating an unproven
	// parentage read failure as though it were a root commit with nothing to
	// check. This must instead report incomplete.
	it('reports EF-VAL-011 (not a silent proceed-as-root-commit) when the ref was previously unresolved and the parentage read itself fails', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'error', message: 'simulated parentage read failure' }),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated parentage read failure')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	// Same defect, captured OID branch: `firstParent.kind !== 'resolved'`
	// already folds `error` into the mismatch report, but the message text
	// must not claim a proven mismatch that was never actually established.
	// `refTipOid` must be a real, resolvable commit whose own history has no
	// prior EF state -- otherwise the bootstrap history check (which runs
	// before the parentage check under test) would itself fail to walk a
	// bogus OID and report EF-VAL-011 for an unrelated reason first.
	it('reports EF-VAL-011 when the ref already resolved and the parentage read itself fails', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary pre-EF history\n')
		const refTipOid = commitAll(tempDir, 'ordinary pre-EF commit')

		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap on top of the resolved ref tip')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'error', message: 'simulated parentage read failure' }),
		})
		const result = await validateBootstrap({
			git,
			proposedOid,
			operationStartRefState: { resolved: true, oid: refTipOid },
		})

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated parentage read failure')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-006 when git is unavailable checking bootstrap history for a resolved ref', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')
		const refTipOid = 'd'.repeat(40)

		const real = repo()
		const git = wrapGitRepository(real, {
			pathExistsInFirstParentHistory: async (startOid, p) => (startOid === refTipOid ? { kind: 'git-unavailable', message: 'simulated history-walk failure' } : real.pathExistsInFirstParentHistory(startOid, p)),
		})
		const result = await validateBootstrap({
			git,
			proposedOid,
			operationStartRefState: { resolved: true, oid: refTipOid },
		})

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated history-walk failure')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(result.expectedRefOid)
			.toBe(refTipOid)
	})

	it('reports EF-VAL-011 when an unresolved ref\'s prior-parent history cannot be walked', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary pre-EF history\n')
		const baseOid = commitAll(tempDir, 'ordinary pre-EF commit')

		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap on top of ordinary history')

		const real = repo()
		const git = wrapGitRepository(real, {
			pathExistsInFirstParentHistory: async (startOid, p) => (startOid === baseOid ? { kind: 'unresolved' } : real.pathExistsInFirstParentHistory(startOid, p)),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('could not be walked to establish the bootstrap history condition')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-007 (incomplete, not eligible-by-assumption) when the bootstrap history check reports a shallow repository for a resolved ref', async () => {
		// 09-validation.md Bootstrap exception: "An inaccessible ref or
		// required history makes the operation incomplete rather than
		// eligible by assumption." A shallow repository's visible
		// first-parent history cannot prove absence of a hidden
		// `.engineering/ef.yaml` ancestor, so this must not be treated the
		// same as a genuine not-found.
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')
		const refTipOid = 'd'.repeat(40)

		const real = repo()
		const git = wrapGitRepository(real, {
			pathExistsInFirstParentHistory: async (startOid, p) => (startOid === refTipOid ? { kind: 'shallow' } : real.pathExistsInFirstParentHistory(startOid, p)),
		})
		const result = await validateBootstrap({
			git,
			proposedOid,
			operationStartRefState: { resolved: true, oid: refTipOid },
		})

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-007'])
		expect(result.diagnostics[0]?.message)
			.toContain('shallow repository')
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-007 when an unresolved ref\'s prior-parent history check reports a shallow repository', async () => {
		await writeFile(tempDir, 'README.md', '# Ordinary pre-EF history\n')
		const baseOid = commitAll(tempDir, 'ordinary pre-EF commit')

		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap on top of ordinary history')

		const real = repo()
		const git = wrapGitRepository(real, {
			pathExistsInFirstParentHistory: async (startOid, p) => (startOid === baseOid ? { kind: 'shallow' } : real.pathExistsInFirstParentHistory(startOid, p)),
		})
		const result = await validateBootstrap({ git, proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-007'])
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
	})

	it('reports EF-VAL-007 for a real shallow clone whose visible history hides an earlier .engineering/ef.yaml (real-fixture regression for the shallow-history bootstrap exception)', async () => {
		// Build a real shallow clone rather than stubbing
		// `pathExistsInFirstParentHistory`, so the regression exercises the
		// actual `git rev-parse --is-shallow-repository` detection end to
		// end: an early commit had `.engineering/ef.yaml`, a later commit
		// removed it, and only that later commit is fetched by the shallow
		// clone -- the visible history alone would otherwise look like a
		// clean, eligible bootstrap target.
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		commitAll(tempDir, 'bootstrap (hidden ancestor)')
		git(tempDir, ['rm', '-rq', '.engineering'])
		const originTipOid = commitAll(tempDir, 'remove ef.yaml before the shallow boundary')

		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-bootstrap-shallow-')))
		await fs.rm(shallowDir, { recursive: true, force: true })
		execFileSync('git', ['clone', '-q', '--depth', '1', `file://${tempDir}`, shallowDir], { stdio: 'pipe' })
		disableBackgroundMaintenance(shallowDir)

		try {
			await writeMinimalProject(shallowDir)
			const proposedOid = commitAll(shallowDir, 'proposed bootstrap on top of the shallow tip')

			const result = await validateBootstrap({
				git: createGitRepository(shallowDir, createGitExecutor()),
				proposedOid,
				operationStartRefState: { resolved: true, oid: originTipOid },
			})

			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
			expect(result.complete)
				.toBe(false)
			expect(result.valid)
				.toBe(false)
			expect(result.exitCode)
				.toBe(2)
		}
		finally {
			await fs.rm(shallowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('reports EF-FS-009 when the bootstrap tree is missing the required .engineering/.gitignore control file', async () => {
		// Missing/non-canonical '.engineering/.gitignore' is reported by
		// `validateSnapshot` itself (`EF-FS-009`, unconditionally -- not a
		// bootstrap-only rule), which `validateBootstrap` surfaces via its
		// `validation.diagnostics` spread. There is no separate bootstrap-only
		// `EF-VAL-010` for this condition (see the code comment).
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
		const proposedOid = commitAll(tempDir, 'bootstrap without .gitignore')

		const result = await validateBootstrap({ git: repo(), proposedOid, operationStartRefState: { resolved: false } })

		expect(codesOf(result.diagnostics))
			.toContain('EF-FS-009')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-VAL-010')
		expect(result.diagnostics.find(d => d.message.includes('.gitignore'))?.message)
			.toContain('missing')
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(1)
	})
})
