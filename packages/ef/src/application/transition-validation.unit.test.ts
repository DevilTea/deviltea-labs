import type { GitRepository } from '../git/repository'
import type { TransitionBoundarySide } from './transition-validation'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { loadSnapshotFromCommit } from './snapshot'
import { validateSnapshot } from './snapshot-validation'
import { evaluateTransitionBoundary, validateTransition } from './transition-validation'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const CONFIG_YAML_OTHER_REF = `schema: ef/config@1
repository:
  integration_ref: refs/heads/develop
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
summary: A minimal example project used for transition validation tests.
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
	relations?: string
	resources?: string
	title?: string
	lifecycle?: string
}

function requirementMd(options: RequirementOptions): string {
	const status = options.status ?? 'active'
	const relations = options.relations ?? '[]'
	const resources = options.resources ?? '[]'
	const title = options.title ?? 'Example Requirement'
	const lifecycleSection = options.lifecycle !== undefined ? `\n\n## Lifecycle\n\n${options.lifecycle}` : ''
	return `---
schema: ef/requirement@1
type: requirement
id: ${options.id}
title: ${title}
status: ${status}
summary: A minimal example requirement used for transition validation tests.
tags: []
relations: ${relations}
resources: ${resources}
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

const DRAFT_CHG_BODY = `## Rationale

Planned work for this fixture.
`

interface DecisionOptions {
	id: string
	status?: string
	relations?: string
	title?: string
}

function decisionMd(options: DecisionOptions): string {
	const status = options.status ?? 'active'
	const relations = options.relations ?? '[]'
	const title = options.title ?? 'Example Decision'
	return `---
schema: ef/decision@1
type: decision
id: ${options.id}
title: ${title}
status: ${status}
summary: A minimal example decision used for transition validation tests.
tags: []
relations: ${relations}
resources: []
---

## Context

Some context.

## Decision

Some decision.

## Alternatives

Some alternatives.

## Consequences

Some consequences.
`
}

interface ChangeOptions {
	id: string
	status?: string
	relations?: string
	body?: string
}

function changeMd(options: ChangeOptions): string {
	const status = options.status ?? 'completed'
	const relations = options.relations ?? '[]'
	const body = options.body ?? (status === 'draft' ? DRAFT_CHG_BODY : COMPLETED_CHG_BODY)
	return `---
schema: ef/change@1
type: change
id: ${options.id}
title: Example Change
status: ${status}
summary: A minimal example change used for transition validation tests.
tags: []
relations: ${relations}
resources: []
---

${body}`
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

async function removeFile(root: string, relativePath: string): Promise<void> {
	await fs.rm(path.join(root, relativePath), { force: true })
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

/** Writes a Git blob object (not a commit) and returns its OID, for "resolves to a non-commit object" fixtures. */
function hashBlob(dir: string, content: string): string {
	return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: { ...process.env, ...GIT_TEST_ENV }, input: content, encoding: 'utf8' })
		.trim()
}

function codesOf(diagnostics: readonly { code: string }[]): string[] {
	return diagnostics.map(d => d.code)
		.sort()
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

describe('validateTransition', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-transition-')))
		git(tempDir, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	function repo() {
		return createGitRepository(tempDir, createGitExecutor())
	}

	// -------------------------------------------------------------------------
	// Happy paths
	// -------------------------------------------------------------------------

	it('is valid for a draft-only Artifact creation requiring no CHG', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(true)
		expect(result.exitCode)
			.toBe(0)
		expect(result.scope)
			.toBe('transition')
		expect(result.baselineOid)
			.toBe(baselineOid)
		expect(result.proposedOid)
			.toBe(proposedOid)
		expect(result.integrationRef)
			.toBe('refs/heads/main')
	})

	it('is valid for draft -> active activation covered by a completed CHG "modifies" effect', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + draft REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'activate REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.valid)
			.toBe(true)
	})

	it('is valid for a one-to-one supersession transaction per the 05/07 examples', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({ id: 'REQ-031', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-031')

		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070',
			lifecycle: 'Superseded by REQ-070.',
		}))
		await writeFile(tempDir, '.engineering/req/REQ-070.md', requirementMd({ id: 'REQ-070', status: 'active' }))
		await writeFile(tempDir, '.engineering/chg/CHG-182.md', changeMd({
			id: 'CHG-182',
			relations: '\n  - type: introduces\n    target: REQ-070\n  - type: modifies\n    target: REQ-031',
		}))
		const proposedOid = commitAll(tempDir, 'supersede REQ-031 with REQ-070')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.diagnostics)
			.toEqual([])
		expect(result.valid)
			.toBe(true)
	})

	// -------------------------------------------------------------------------
	// Protocol / incompleteness
	// -------------------------------------------------------------------------

	it('reports EF-VAL-002 and complete: false for a lexically malformed baseline OID', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const result = await validateTransition({ git: repo(), baselineOid: 'not-a-real-oid', proposedOid, operationStartRefOid: 'not-a-real-oid' })

		expect(result.complete)
			.toBe(false)
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
		expect(result.baselineOid)
			.toBeNull()
	})

	it('reports EF-VAL-002 and complete: false when the baseline snapshot itself is invalid', async () => {
		// Baseline is missing the required PROJECT Artifact.
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(tempDir, '.engineering/.gitignore', GITIGNORE)
		const baselineOid = commitAll(tempDir, 'invalid bootstrap')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	it('reports EF-VAL-002 and complete: false when the operation-start ref OID does not match the baseline', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: proposedOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	// FINDING A regression: a failed operation-start ref probe (Git ran but
	// could not conclusively resolve `integration_ref` -- distinct from a
	// genuine mismatch, which is a PROVEN fact) must be reported as
	// incomplete with EF-VAL-006, not misclassified as an ordinary
	// baseline-mismatch EF-VAL-002 (09-validation.md "An inaccessible ref ...
	// makes the operation incomplete rather than eligible by assumption").
	it('reports EF-VAL-006 (not EF-VAL-002 baseline-mismatch) when the operation-start ref probe failed', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const result = await validateTransition({
			git: repo(),
			baselineOid,
			proposedOid,
			operationStartRefOid: { kind: 'ref-probe-error', message: 'git show-ref --verify --quiet exited with status 128.' },
		})

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
	})

	it('reports EF-VAL-002 when the proposed configuration changes the fixed integration_ref', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML_OTHER_REF)
		const proposedOid = commitAll(tempDir, 'change integration_ref')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	it('reports EF-VAL-011 for a proposed OID that does not resolve to any object', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid: 'f'.repeat(40), operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
		expect(result.proposedOid)
			.toBeNull()
	})

	it('reports EF-VAL-011 when the proposed commit\'s first parent is not the baseline', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		git(tempDir, ['checkout', '-q', '-b', 'side', baselineOid])
		await writeFile(tempDir, '.engineering/req/REQ-999.md', requirementMd({ id: 'REQ-999', status: 'draft' }))
		const sideOid = commitAll(tempDir, 'side commit')
		git(tempDir, ['checkout', '-q', 'main'])

		git(tempDir, ['checkout', '-q', '-b', 'wrong-parent', sideOid])
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'wrong parent proposed')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
	})

	it('reports EF-VAL-002 for a baseline OID that does not resolve to any object', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')

		const result = await validateTransition({ git: repo(), baselineOid: 'f'.repeat(40), proposedOid, operationStartRefOid: null })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
		expect(result.baselineOid)
			.toBeNull()
	})

	it('reports EF-VAL-002 when the baseline OID resolves to a non-commit object', async () => {
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'bootstrap')
		const blobOid = hashBlob(tempDir, 'not a commit')

		const result = await validateTransition({ git: repo(), baselineOid: blobOid, proposedOid, operationStartRefOid: null })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	it('reports EF-VAL-011 for a lexically malformed proposed OID', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid: 'not-a-real-oid', operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
		expect(result.proposedOid)
			.toBeNull()
	})

	it('reports EF-VAL-011 when the proposed OID resolves to a non-commit object', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const blobOid = hashBlob(tempDir, 'not a commit either')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid: blobOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
	})

	it('reports EF-VAL-002 when the trusted baseline has no .engineering directory at all', async () => {
		await writeFile(tempDir, 'README.md', '# no engineering directory here\n')
		const baselineOid = commitAll(tempDir, 'no .engineering')
		await writeMinimalProject(tempDir)
		const proposedOid = commitAll(tempDir, 'add .engineering')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	// -------------------------------------------------------------------------
	// Git-unavailable propagation
	// -------------------------------------------------------------------------

	it('reports EF-VAL-006 when git is unavailable while resolving the trusted baseline', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		const git = wrapGitRepository(repo(), {
			resolveCommit: async () => ({ kind: 'git-unavailable', message: 'simulated failure' }),
		})
		const result = await validateTransition({ git, baselineOid, proposedOid: baselineOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	it('reports EF-VAL-006 when git is unavailable while materializing the trusted baseline', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const realGit = repo()
		const git = wrapGitRepository(realGit, {
			readTree: async oid => (oid === baselineOid ? { kind: 'git-unavailable', message: 'tree read failed' } : realGit.readTree(oid)),
		})

		const result = await validateTransition({ git, baselineOid, proposedOid: baselineOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	it('reports EF-VAL-002 when the trusted baseline commit tree cannot be read', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const realGit = repo()
		const git = wrapGitRepository(realGit, {
			readTree: async oid => (oid === baselineOid ? { kind: 'missing' } : realGit.readTree(oid)),
		})

		const result = await validateTransition({ git, baselineOid, proposedOid: baselineOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	// FINDING (repository.ts readTree -> transition-validation.ts materialize):
	// `readTree`'s `error` kind (the commit was proven to exist but its tree
	// could not be read) must still be reported as incomplete (EF-VAL-002),
	// exactly like `missing` -- both mean the baseline cannot be
	// materialized -- rather than being accessed as though `treeResult` were
	// `resolved` (which would throw on `.entries`).
	it('reports EF-VAL-002 when the trusted baseline commit tree exists but cannot be read (execution error, not missing)', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const realGit = repo()
		const git = wrapGitRepository(realGit, {
			readTree: async oid => (oid === baselineOid ? { kind: 'error', message: 'simulated ls-tree failure' } : realGit.readTree(oid)),
		})

		const result = await validateTransition({ git, baselineOid, proposedOid: baselineOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
		expect(result.diagnostics.some(d => d.message.includes('simulated ls-tree failure')))
			.toBe(true)
	})

	it('reports EF-VAL-006 when git becomes unavailable on the second, snapshot-loading read of the trusted baseline tree', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const realGit = repo()
		let baselineReadTreeCalls = 0
		const git = wrapGitRepository(realGit, {
			readTree: async (oid) => {
				if (oid !== baselineOid)
					return realGit.readTree(oid)
				baselineReadTreeCalls += 1
				return baselineReadTreeCalls === 1 ? realGit.readTree(oid) : { kind: 'git-unavailable', message: 'boom on second read' }
			},
		})

		const result = await validateTransition({ git, baselineOid, proposedOid: baselineOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	it('reports EF-VAL-011 when the proposed commit tree becomes unreadable on the second, snapshot-loading read', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const realGit = repo()
		let proposedReadTreeCalls = 0
		const git = wrapGitRepository(realGit, {
			readTree: async (oid) => {
				if (oid !== proposedOid)
					return realGit.readTree(oid)
				proposedReadTreeCalls += 1
				return proposedReadTreeCalls === 1 ? realGit.readTree(oid) : { kind: 'missing' }
			},
		})

		const result = await validateTransition({ git, baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
	})

	it('reports EF-VAL-011 when the proposed commit tree exists but cannot be read on the second, snapshot-loading read (execution error, not missing)', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const realGit = repo()
		let proposedReadTreeCalls = 0
		const git = wrapGitRepository(realGit, {
			readTree: async (oid) => {
				if (oid !== proposedOid)
					return realGit.readTree(oid)
				proposedReadTreeCalls += 1
				return proposedReadTreeCalls === 1 ? realGit.readTree(oid) : { kind: 'error', message: 'simulated ls-tree failure' }
			},
		})

		const result = await validateTransition({ git, baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-011')
		expect(result.diagnostics.some(d => d.message.includes('simulated ls-tree failure')))
			.toBe(true)
	})

	it('reports EF-VAL-002 with a "nothing" fallback message when the operation-start ref was unresolved', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid: baselineOid, operationStartRefOid: null })

		expect(result.complete)
			.toBe(false)
		const val002 = result.diagnostics.find(d => d.code === 'EF-VAL-002' && d.message.includes('resolved to'))
		expect(val002?.message)
			.toContain('resolved to \'nothing\'')
	})

	it('reports EF-VAL-006 when git is unavailable while resolving the proposed commit', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		const realGit = repo()
		const git = wrapGitRepository(realGit, {
			resolveCommit: async oid => (oid === baselineOid ? realGit.resolveCommit(oid) : { kind: 'git-unavailable', message: 'boom' }),
		})

		const result = await validateTransition({ git, baselineOid, proposedOid: 'f'.repeat(40), operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	it('reports EF-VAL-006 when git is unavailable while checking proposed parentage', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'git-unavailable', message: 'boom' }),
		})
		const result = await validateTransition({ git, baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	// FINDING (repository.ts getFirstParent -> transition-validation.ts):
	// `getFirstParent`'s `error` kind (the proposed commit was proven to exist
	// but its parentage could not be read) must be reported as incomplete
	// (EF-VAL-011), not silently folded into an ordinary "wrong parent"
	// mismatch message that claims a proof that was never established.
	it('reports EF-VAL-011 when the proposed commit\'s parentage cannot be read (neither a proven match nor a proven mismatch)', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const git = wrapGitRepository(repo(), {
			getFirstParent: async () => ({ kind: 'error', message: 'simulated parentage read failure' }),
		})
		const result = await validateTransition({ git, baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-011'])
		expect(result.diagnostics[0]?.message)
			.toContain('simulated parentage read failure')
	})

	it('reports EF-VAL-006 when git is unavailable while materializing the proposed commit', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'draft REQ-001')

		const realGit = repo()
		const git = wrapGitRepository(realGit, {
			readTree: async oid => (oid === proposedOid ? { kind: 'git-unavailable', message: 'boom' } : realGit.readTree(oid)),
		})
		const result = await validateTransition({ git, baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-006')
	})

	// -------------------------------------------------------------------------
	// Lifecycle: frozen preservation and deletion
	// -------------------------------------------------------------------------

	it('reports EF-LIFE-004 when a frozen terminal Artifact is modified', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'retired', lifecycle: 'Retired without a replacement.' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + retired REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'retired', title: 'Renamed Requirement', lifecycle: 'Retired without a replacement.' }))
		const proposedOid = commitAll(tempDir, 'illegally edit frozen REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-LIFE-004')
		expect(result.valid)
			.toBe(false)
		expect(result.exitCode)
			.toBe(1)
	})

	it('reports EF-LIFE-009 when an issued Artifact is physically deleted', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await removeFile(tempDir, '.engineering/req/REQ-001.md')
		const proposedOid = commitAll(tempDir, 'delete REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-LIFE-009')
	})

	it('does not also report EF-LIFE-004 or EF-RES-013 for a frozen terminal Artifact that was physically deleted', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
			id: 'REQ-001',
			status: 'retired',
			lifecycle: 'Retired without a replacement.',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		}))
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + retired REQ-001 with a Resource')

		await removeFile(tempDir, '.engineering/req/REQ-001.md')
		await removeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv')
		const proposedOid = commitAll(tempDir, 'delete the frozen Artifact and its Resource')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-LIFE-009')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-LIFE-004')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-RES-013')
	})

	// -------------------------------------------------------------------------
	// Identity immutability
	// -------------------------------------------------------------------------

	it('reports EF-ID-010 when the id at an unchanged path is changed', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		// Overwrite the same path's frontmatter id without renaming the file
		// (an illegitimate identity change, distinct from EF-ID-005's filename
		// mismatch, which also fires here since the basename no longer matches).
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-045', status: 'draft' }))
		const proposedOid = commitAll(tempDir, 'change id in place')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-ID-010')
	})

	it('reports EF-ID-009 when an issued ID reappears at a different path', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await removeFile(tempDir, '.engineering/req/REQ-001.md')
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'move REQ-001 identity to a new path')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-ID-009')
	})

	it('reports EF-ID-012 for a provisional collision between two freshly introduced candidates', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/req/REQ-045.md', requirementMd({ id: 'REQ-045', status: 'draft', title: 'First Candidate' }))
		await writeFile(tempDir, '.engineering/req/REQ-045-b.md', requirementMd({ id: 'REQ-045', status: 'draft', title: 'Second Candidate' }))
		const proposedOid = commitAll(tempDir, 'colliding provisional candidates')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-ID-004')
		expect(codesOf(result.diagnostics))
			.toContain('EF-ID-012')
	})

	it('does not report EF-ID-012 for a duplicate ID that already exists in the baseline', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-045.md', requirementMd({ id: 'REQ-045', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-045')

		await writeFile(tempDir, '.engineering/req/REQ-045-dup.md', requirementMd({ id: 'REQ-045', status: 'active', title: 'Duplicate Claim' }))
		const proposedOid = commitAll(tempDir, 'introduce a duplicate claim on an already-issued ID')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-ID-004')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-ID-012')
	})

	// -------------------------------------------------------------------------
	// Resource freeze
	// -------------------------------------------------------------------------

	it('reports EF-RES-013 when a frozen owner\'s local Resource content is modified', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
			id: 'REQ-001',
			status: 'retired',
			lifecycle: 'Retired without a replacement.',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		}))
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + retired REQ-001 with a Resource')

		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n9,9\n')
		const proposedOid = commitAll(tempDir, 'illegally modify frozen Resource content')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-RES-013')
	})

	it('reports EF-RES-013 for a mutated local Resource even when an external Resource is also present and unchanged', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
			id: 'REQ-001',
			status: 'retired',
			lifecycle: 'Retired without a replacement.',
			resources: '\n  - type: reference\n    location: https://example.com/spec\n    role: reference\n    media_type: text/plain\n    normative: false\n    description: External specification reference.\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		}))
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + retired REQ-001 with external and local Resources')

		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n9,9\n')
		const proposedOid = commitAll(tempDir, 'illegally modify frozen local Resource content')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-RES-013')
	})

	// -------------------------------------------------------------------------
	// CHG net-effect classification, coverage, and truthfulness
	// -------------------------------------------------------------------------

	it('reports EF-CHG-002 for a completed CHG with no effects when no required target changed', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '[]' }))
		const proposedOid = commitAll(tempDir, 'empty completed CHG')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-002')
	})

	it('reports EF-CHG-005 for a changed CHG-required target with no covering effect', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active', title: 'Edited Without CHG' }))
		const proposedOid = commitAll(tempDir, 'edit REQ-001 without CHG')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-005')
	})

	it('reports EF-CHG-006 for a completed CHG effect declared on an unchanged target', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'declare effect on unchanged REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-006')
	})

	it('reports EF-CHG-006 for an effect declared on a target that never existed in the transition, without suppressing EF-CHG-002', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/chg/CHG-004.md', changeMd({ id: 'CHG-004', relations: '\n  - type: retires\n    target: REQ-999' }))
		const proposedOid = commitAll(tempDir, 'CHG effect on a target that never exists anywhere')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-006')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-002')
	})

	it('does not misclassify a non-effect relation on a completed CHG as an effect declaration', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active', title: 'Edited With A References Relation Too' }))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({
			id: 'CHG-001',
			relations: '\n  - type: modifies\n    target: REQ-001\n  - type: references\n    target: REQ-001',
		}))
		const proposedOid = commitAll(tempDir, 'completed CHG with one effect relation and one non-effect relation to the same target')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-003')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-004')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-005')
	})

	it('reports EF-CHG-005 for the PROJECT Artifact itself, with no artifactId, when changed without CHG coverage', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD.replace('Example Project', 'Renamed Project'))
		const proposedOid = commitAll(tempDir, 'edit PROJECT.md without any covering CHG')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		const chg005 = result.diagnostics.find(d => d.code === 'EF-CHG-005' && d.path === '.engineering/PROJECT.md')
		expect(chg005)
			.toBeDefined()
		expect(chg005?.artifactId)
			.toBeUndefined()
	})

	it('reports EF-CHG-003 when a declared effect does not match the actual net-effect classification', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + draft REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: introduces\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'misclassify activation as introduces')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-003')
	})

	it('does not report EF-CHG-003 when a declared effect targets an Artifact that was physically deleted (EF-LIFE-009 owns that finding)', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await removeFile(tempDir, '.engineering/req/REQ-001.md')
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'delete REQ-001 while a CHG still claims to modify it')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-LIFE-009')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-003')
	})

	it('reports EF-CHG-003 with an actual net effect of "retires" when a retirement is misclassified', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'retired', lifecycle: 'Retired without a replacement.' }))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'misclassify a retirement as modifies')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		const chg003 = result.diagnostics.find(d => d.code === 'EF-CHG-003')
		expect(chg003?.message)
			.toContain('actual net effect is \'retires\'')
	})

	it('reports EF-CHG-004 when one CHG declares conflicting effects for one target', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({
			id: 'CHG-001',
			relations: '\n  - type: modifies\n    target: REQ-001\n  - type: retires\n    target: REQ-001',
		}))
		const proposedOid = commitAll(tempDir, 'conflicting effects for one target')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-004')
	})

	it('reports EF-CHG-007 when multiple completing CHGs claim the same target', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active', title: 'Edited Twice' }))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		await writeFile(tempDir, '.engineering/chg/CHG-002.md', changeMd({ id: 'CHG-002', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'two CHGs claim REQ-001')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		const chg007 = result.diagnostics.filter(d => d.code === 'EF-CHG-007')
		expect(chg007.length)
			.toBe(2)
	})

	it('reports EF-CHG-008 for a draft CHG that declares a factual effect relation', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', status: 'draft', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'draft CHG with a factual effect')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-008')
	})

	it('reports EF-CHG-008 for a retired CHG declaring a "retires" effect, and not for a draft CHG with no effect relations', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001')

		await writeFile(tempDir, '.engineering/chg/CHG-002.md', changeMd({ id: 'CHG-002', status: 'retired', relations: '\n  - type: retires\n    target: REQ-001' }))
		await writeFile(tempDir, '.engineering/chg/CHG-003.md', changeMd({ id: 'CHG-003', status: 'draft', relations: '[]' }))
		const proposedOid = commitAll(tempDir, 'one retired CHG with a factual effect, one draft CHG with none')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		const chg008 = result.diagnostics.filter(d => d.code === 'EF-CHG-008')
		expect(chg008.length)
			.toBe(1)
		expect(chg008[0]!.artifactId)
			.toBe('CHG-002')
		expect(chg008[0]!.message)
			.toBe('Retired CHG \'CHG-002\' declares a factual effect relation.')
	})

	it('reports EF-CHG-017 when a CHG declares an effect on another CHG', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '[]' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + existing completed CHG-001')

		await writeFile(tempDir, '.engineering/chg/CHG-002.md', changeMd({ id: 'CHG-002', relations: '\n  - type: modifies\n    target: CHG-001' }))
		const proposedOid = commitAll(tempDir, 'CHG effect on a CHG')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-017')
	})

	it('reports EF-CHG-012 instead of EF-CHG-003 for a Resource-only change with the wrong declared effect', async () => {
		const req = requirementMd({
			id: 'REQ-001',
			status: 'active',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		})
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', req)
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001 with a Resource')

		// REQ-001.md itself is byte-identical; only its owned Resource changes.
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n9,9\n')
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: introduces\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'resource-only change misclassified as introduces')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-012')
		expect(codesOf(result.diagnostics)).not.toContain('EF-CHG-003')
	})

	it('does not report EF-CHG-012 when a Resource-only change is correctly declared as "modifies"', async () => {
		const req = requirementMd({
			id: 'REQ-001',
			status: 'active',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		})
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', req)
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001 with a Resource')

		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n9,9\n')
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'resource-only change correctly declared as modifies')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-012')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-003')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-005')
	})

	it('reports EF-CHG-012 when a declared Resource file is deleted while its declaration stays byte-identical', async () => {
		const req = requirementMd({
			id: 'REQ-001',
			status: 'active',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Supporting evidence data.',
		})
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', req)
		await writeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv', 'a,b\n1,2\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001 with a local Resource')

		// REQ-001.md itself (and its resources: declaration) is byte-identical;
		// only the referenced Resource file is physically deleted.
		await removeFile(tempDir, '.engineering/resources/REQ-001/evidence.csv')
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: introduces\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'delete the declared Resource file without editing REQ-001.md')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-CHG-012')
	})

	it('does not treat reordering unchanged Resource declarations as a spurious classification (fingerprint sort order-independence)', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
			id: 'REQ-001',
			status: 'active',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/z-evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Z evidence.\n  - type: data\n    location: .engineering/resources/REQ-001/a-evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: A evidence.',
		}))
		await writeFile(tempDir, '.engineering/resources/REQ-001/z-evidence.csv', 'z\n')
		await writeFile(tempDir, '.engineering/resources/REQ-001/a-evidence.csv', 'a\n')
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-001 with two Resources declared z-then-a')

		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
			id: 'REQ-001',
			status: 'active',
			resources: '\n  - type: data\n    location: .engineering/resources/REQ-001/a-evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: A evidence.\n  - type: data\n    location: .engineering/resources/REQ-001/z-evidence.csv\n    role: evidence\n    media_type: text/csv\n    normative: false\n    description: Z evidence.',
		}))
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: modifies\n    target: REQ-001' }))
		const proposedOid = commitAll(tempDir, 'reorder Resource declarations only, correctly covered by a CHG modifies effect')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-003')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-005')
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-CHG-012')
	})

	// -------------------------------------------------------------------------
	// Supersession atomicity
	// -------------------------------------------------------------------------

	it('reports EF-SUP-004 when a supersession replacement is not active at completion', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({ id: 'REQ-031', status: 'active' }))
		await writeFile(tempDir, '.engineering/req/REQ-070.md', requirementMd({ id: 'REQ-070', status: 'draft' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-031 active, REQ-070 draft')

		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070',
			lifecycle: 'Superseded by REQ-070.',
		}))
		await writeFile(tempDir, '.engineering/chg/CHG-183.md', changeMd({ id: 'CHG-183', relations: '\n  - type: modifies\n    target: REQ-031' }))
		const proposedOid = commitAll(tempDir, 'supersede to a non-active replacement')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-SUP-004')
	})

	it('reports EF-SUP-007 when a frozen replacement set is later modified', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070',
			lifecycle: 'Superseded by REQ-070.',
		}))
		await writeFile(tempDir, '.engineering/req/REQ-070.md', requirementMd({ id: 'REQ-070', status: 'active' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + already-superseded REQ-031')

		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070\n  - type: superseded-by\n    target: REQ-071',
			lifecycle: 'Superseded by REQ-070.',
		}))
		await writeFile(tempDir, '.engineering/req/REQ-071.md', requirementMd({ id: 'REQ-071', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'illegally widen the frozen replacement set')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-SUP-007')
	})

	it('reports EF-SUP-013 when an existing relation is implicitly retargeted during supersession', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({ id: 'REQ-031', status: 'active' }))
		await writeFile(tempDir, '.engineering/adr/ADR-001.md', `---
schema: ef/decision@1
type: decision
id: ADR-001
title: Example Decision
status: active
summary: A minimal example decision used for transition validation tests.
tags: []
relations:
  - type: addresses
    target: REQ-031
resources: []
---

## Context

Some context.

## Decision

Some decision.

## Alternatives

Some alternatives.

## Consequences

Some consequences.
`)
		const baselineOid = commitAll(tempDir, 'bootstrap + ADR-001 addressing REQ-031')

		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070',
			lifecycle: 'Superseded by REQ-070.',
		}))
		await writeFile(tempDir, '.engineering/req/REQ-070.md', requirementMd({ id: 'REQ-070', status: 'active' }))
		await writeFile(tempDir, '.engineering/adr/ADR-001.md', `---
schema: ef/decision@1
type: decision
id: ADR-001
title: Example Decision
status: active
summary: A minimal example decision used for transition validation tests.
tags: []
relations:
  - type: addresses
    target: REQ-070
resources: []
---

## Context

Some context.

## Decision

Some decision.

## Alternatives

Some alternatives.

## Consequences

Some consequences.
`)
		await writeFile(tempDir, '.engineering/chg/CHG-182.md', changeMd({
			id: 'CHG-182',
			relations: '\n  - type: introduces\n    target: REQ-070\n  - type: modifies\n    target: REQ-031\n  - type: modifies\n    target: ADR-001',
		}))
		const proposedOid = commitAll(tempDir, 'implicitly retarget ADR-001 during supersession')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		expect(codesOf(result.diagnostics))
			.toContain('EF-SUP-013')
	})

	it('reports exactly one EF-SUP-013 for a one-to-many supersession with one retargeted edge and one preserved edge', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({ id: 'REQ-031', status: 'active' }))
		await writeFile(tempDir, '.engineering/req/REQ-032.md', requirementMd({ id: 'REQ-032', status: 'active' }))
		await writeFile(tempDir, '.engineering/adr/ADR-001.md', decisionMd({
			id: 'ADR-001',
			relations: '\n  - type: addresses\n    target: REQ-031\n  - type: references\n    target: REQ-032',
		}))
		await writeFile(tempDir, '.engineering/adr/ADR-002.md', decisionMd({ id: 'ADR-002', relations: '\n  - type: addresses\n    target: REQ-031' }))
		const baselineOid = commitAll(tempDir, 'bootstrap + REQ-031/REQ-032/ADR-001/ADR-002')

		await writeFile(tempDir, '.engineering/req/REQ-031.md', requirementMd({
			id: 'REQ-031',
			status: 'superseded',
			relations: '\n  - type: superseded-by\n    target: REQ-070\n  - type: superseded-by\n    target: REQ-071',
			lifecycle: 'Superseded by REQ-070 and REQ-071.',
		}))
		await writeFile(tempDir, '.engineering/req/REQ-070.md', requirementMd({ id: 'REQ-070', status: 'active' }))
		await writeFile(tempDir, '.engineering/req/REQ-071.md', requirementMd({ id: 'REQ-071', status: 'active' }))
		// ADR-001's `addresses` edge is retargeted from REQ-031 to REQ-070 only
		// (not REQ-071); its unrelated `references` edge to REQ-032 is untouched.
		await writeFile(tempDir, '.engineering/adr/ADR-001.md', decisionMd({
			id: 'ADR-001',
			relations: '\n  - type: addresses\n    target: REQ-070\n  - type: references\n    target: REQ-032',
		}))
		// ADR-002 keeps its historical edge to the source untouched (no violation).
		await writeFile(tempDir, '.engineering/chg/CHG-182.md', changeMd({
			id: 'CHG-182',
			relations: '\n  - type: introduces\n    target: REQ-070\n  - type: introduces\n    target: REQ-071\n  - type: modifies\n    target: REQ-031\n  - type: modifies\n    target: ADR-001',
		}))
		const proposedOid = commitAll(tempDir, 'one-to-many supersession with one retargeted and one preserved edge')

		const result = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })

		const sup013 = result.diagnostics.filter(d => d.code === 'EF-SUP-013')
		expect(sup013.length)
			.toBe(1)
		expect(sup013[0]!.artifactId)
			.toBe('ADR-001')
		expect(sup013[0]!.message)
			.toContain('REQ-070')
	})
})

describe('evaluateTransitionBoundary (twelfth-round review Finding 1: exported pure graph-wide core)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-transition-boundary-')))
		git(tempDir, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	function repo() {
		return createGitRepository(tempDir, createGitExecutor())
	}

	/**
	 * Assembles a {@link TransitionBoundarySide} for `oid` using ONLY the same
	 * exported, general-purpose building blocks `transition-validation.ts`'s
	 * own (private) `materialize` helper uses internally
	 * (`loadSnapshotFromCommit` + `validateSnapshot` + a blob-OID tree index) --
	 * proving `evaluateTransitionBoundary` is usable standalone, by a caller
	 * with no access to this module's own ref/parentage orchestration (exactly
	 * `query-history.ts`'s own position, walking historical commits it
	 * resolved itself).
	 */
	async function boundarySideAt(git: GitRepository, oid: string): Promise<TransitionBoundarySide> {
		const treeResult = await git.readTree(oid)
		if (treeResult.kind !== 'resolved')
			throw new Error(`expected a resolved tree at '${oid}', got '${treeResult.kind}'`)
		const oidByPath = new Map<string, string>()
		for (const entry of treeResult.entries) {
			if (entry.type === 'blob')
				oidByPath.set(entry.path, entry.oid)
		}
		const loadResult = await loadSnapshotFromCommit(git, oid)
		if (!loadResult.ok)
			throw new Error(`expected to load a snapshot at '${oid}', got reason '${loadResult.reason}'`)
		return { snapshot: loadResult.snapshot, validation: validateSnapshot(loadResult.snapshot), oidByPath }
	}

	it('is directly callable as a pure function over two independently-assembled boundary sides, with no ref/parentage orchestration, and agrees with validateTransition\'s own diagnostics for the identical commit pair', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		// A knowledge Artifact first appearing directly `active` with no
		// completed CHG `introduces` effect -- illegal (EF-LIFE-003) -- so this
		// pair carries a real, non-empty diagnostic to compare.
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'REQ-001 first appears active with no completed CHG introduces effect')

		const before = await boundarySideAt(repo(), baselineOid)
		const after = await boundarySideAt(repo(), proposedOid)

		const pureDiagnostics = evaluateTransitionBoundary({ before, after, beforeOid: baselineOid, afterOid: proposedOid })
		expect(pureDiagnostics.some(d => d.code === 'EF-LIFE-003'))
			.toBe(true)

		// `validateTransition` is a thin orchestrator around this SAME core: for
		// the identical commit pair, its own diagnostics (minus whatever the
		// orchestrator layer itself contributes, which is none for this valid,
		// correctly-parented pair) must match exactly.
		const orchestrated = await validateTransition({ git: repo(), baselineOid, proposedOid, operationStartRefOid: baselineOid })
		expect(codesOf(orchestrated.diagnostics))
			.toEqual(codesOf(pureDiagnostics))
	})

	it('reports no diagnostics for a genuinely valid transition (over-blocking guard)', async () => {
		await writeMinimalProject(tempDir)
		const baselineOid = commitAll(tempDir, 'bootstrap')

		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd({ id: 'CHG-001', relations: '\n  - type: introduces\n    target: REQ-001' }))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'active' }))
		const proposedOid = commitAll(tempDir, 'CHG-001 completes, activates REQ-001')

		const before = await boundarySideAt(repo(), baselineOid)
		const after = await boundarySideAt(repo(), proposedOid)

		const pureDiagnostics = evaluateTransitionBoundary({ before, after, beforeOid: baselineOid, afterOid: proposedOid })
		expect(pureDiagnostics)
			.toEqual([])
	})
})
