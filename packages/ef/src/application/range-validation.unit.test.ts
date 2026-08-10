import type { GitExecOutcome, GitExecutor } from '../git/executor'
import type { GitRepository } from '../git/repository'
import type { OperationStartRefState } from './bootstrap-validation'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { computeHistory } from './query-history'
import { validateRange } from './range-validation'
import { loadSnapshotFromCommit } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

// ---------------------------------------------------------------------------
// Fixtures (mirrors bootstrap-validation.unit.test.ts / transition-validation.unit.test.ts house style)
// ---------------------------------------------------------------------------

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

function projectMd(options: { termsInOrder?: boolean } = {}): string {
	const terms = options.termsInOrder === false
		? '| Zebra | last letter | none |\n| Alpha | first letter | none |'
		: '| Alpha | first letter | none |\n| Zebra | last letter | none |'
	return `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for range validation tests.
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
${terms}
`
}

interface RequirementOptions {
	id: string
	status?: string
	relations?: string
	summary?: string
}

function requirementMd(options: RequirementOptions): string {
	const status = options.status ?? 'active'
	const relations = options.relations ?? '[]'
	const summary = options.summary ?? 'A minimal example requirement used for range validation tests.'
	return `---
schema: ef/requirement@1
type: requirement
id: ${options.id}
title: Example Requirement
status: ${status}
summary: ${summary}
tags: []
relations: ${relations}
resources: []
---

## Requirement

The system must behave as specified by this requirement.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

- The system behaves as specified.
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

function changeMd(id: string, relations: string): string {
	return `---
schema: ef/change@1
type: change
id: ${id}
title: Example Change
status: completed
summary: A minimal example change used for range validation tests.
tags: []
relations: ${relations}
resources: []
---

${COMPLETED_CHG_BODY}`
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

async function removeFile(root: string, relativePath: string): Promise<void> {
	await fs.rm(path.join(root, relativePath), { force: true, recursive: true })
}

async function writeMinimalProject(root: string, options: { termsInOrder?: boolean } = {}): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/.gitignore', GITIGNORE)
	await writeFile(root, '.engineering/PROJECT.md', projectMd(options))
}

/** Writes REQ-`n` active plus a completed CHG that introduces it, in one commit's staged changes. */
async function addActiveRequirementWithIntroducingChg(root: string, reqId: string, chgId: string): Promise<void> {
	await writeFile(root, `.engineering/req/${reqId}.md`, requirementMd({ id: reqId }))
	await writeFile(root, `.engineering/chg/${chgId}.md`, changeMd(chgId, `[{ type: introduces, target: ${reqId} }]`))
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	const result = execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
	if (args[0] === 'init') {
		execFileSync('git', ['-C', dir, 'config', 'gc.auto', '0'])
		execFileSync('git', ['-C', dir, 'config', 'gc.autoDetach', 'false'])
		execFileSync('git', ['-C', dir, 'config', 'maintenance.auto', 'false'])
	}
	return result
}

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

function commitOidsOf(diagnostics: readonly { commitOid?: string }[]): (string | undefined)[] {
	return diagnostics.map(d => d.commitOid)
}

/**
 * Delegates every {@link GitRepository} method to `real` except the ones
 * named in `overrides`, so a single low-level Git outcome can be forced
 * (`git-unavailable`, `error`, etc.) without spawning a real Git failure.
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
		listFirstParentRange: overrides.listFirstParentRange ?? real.listFirstParentRange.bind(real),
		readPathEntry: overrides.readPathEntry ?? real.readPathEntry.bind(real),
	}
}

/** A scripted executor wrapper counting invocations whose args match `predicate`, delegating everything to `real`. */
function countingExecutor(real: GitExecutor, predicate: (args: readonly string[]) => boolean): { executor: GitExecutor, count: () => number } {
	let count = 0
	return {
		executor: {
			exec: args => real.exec(args),
			execIn: (dir: string, args: readonly string[]): Promise<GitExecOutcome> => {
				if (predicate(args))
					count += 1
				return real.execIn(dir, args)
			},
		},
		count: () => count,
	}
}

const RESOLVED_ABSENT: OperationStartRefState = { resolved: false }

describe('validateRange', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-range-')))
		git(tempDir, ['init', '-q', '-b', 'main'])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	function repo(dir = tempDir): GitRepository {
		return createGitRepository(dir, createGitExecutor())
	}

	// -------------------------------------------------------------------------
	// 1. Transition-only range
	// -------------------------------------------------------------------------

	it('validates a transition-only range: both boundaries via evaluateTransitionBoundary, exit 0', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'bootstrap')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const c1 = commitAll(tempDir, 'introduce REQ-001')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-002', 'CHG-002')
		const c2 = commitAll(tempDir, 'introduce REQ-002')
		git(tempDir, ['update-ref', 'refs/heads/main', c2])

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: c2,
			operationStartRef: 'refs/heads/main',
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		expect(result.valid)
			.toBe(true)
		expect(result.complete)
			.toBe(true)
		expect(result.integrationRef)
			.toBe('refs/heads/main')
		expect(result.expectedRefOid)
			.toBe(baseline)
		expect(result.baselineOid)
			.toBe(baseline)
		expect(codesOf(result.diagnostics))
			.toEqual([])
		void c1
	})

	// -------------------------------------------------------------------------
	// 2-6. Bootstrap-in-range
	// -------------------------------------------------------------------------

	it('validates a bootstrap-in-range: identity, bootstrap, then transitions; integration_ref from the bootstrap commit', async () => {
		await writeFile(tempDir, 'README.txt', 'pre-EF\n')
		const baseline = commitAll(tempDir, 'pre-EF baseline')
		await writeFile(tempDir, 'other.txt', 'unrelated\n')
		commitAll(tempDir, 'code only (identity)')
		await writeMinimalProject(tempDir)
		const bootstrapOid = commitAll(tempDir, 'bootstrap')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		commitAll(tempDir, 'introduce REQ-001')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-002', 'CHG-002')
		const proposed = commitAll(tempDir, 'introduce REQ-002')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: proposed,
			// The trusted range baseline MAY be pre-EF, but it is still the real
			// captured pre-integration ref tip: the ref DID resolve, at operation
			// start, to this exact (pre-EF) OID.
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		expect(result.valid)
			.toBe(true)
		expect(result.integrationRef)
			.toBe('refs/heads/main')
		expect(result.expectedRefOid)
			.toBe(baseline)
		void bootstrapOid
	})

	it('reports EF-VAL-009 (not a bootstrap) when the pre-baseline first-parent history already contains .engineering/ef.yaml', async () => {
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		commitAll(tempDir, 'stray historical EF state')
		await removeFile(tempDir, '.engineering')
		const baseline = commitAll(tempDir, 'back to pre-EF')
		await writeMinimalProject(tempDir)
		const proposed = commitAll(tempDir, 'attempted bootstrap')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(1)
		expect(result.complete)
			.toBe(true)
		expect(result.valid)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-009'])
		expect(result.diagnostics[0]!.commitOid)
			.toBe(proposed)
	})

	it('accepts a root-commit bootstrap as the range root when --baseline is omitted and the ref is proven unresolved', async () => {
		await writeMinimalProject(tempDir)
		const root = commitAll(tempDir, 'root bootstrap')

		const result = await validateRange({
			git: repo(),
			baselineOid: null,
			proposedOid: root,
			operationStartRefState: { resolved: false },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		expect(result.baselineOid)
			.toBeNull()
		expect(result.expectedRefOid)
			.toBeNull()
	})

	it('reports EF-VAL-002 when --baseline is omitted but integration_ref actually resolves', async () => {
		await writeMinimalProject(tempDir)
		const root = commitAll(tempDir, 'root bootstrap')

		const result = await validateRange({
			git: repo(),
			baselineOid: null,
			proposedOid: root,
			operationStartRefState: { resolved: true, oid: root },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(2)
		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-002'])
	})

	it('reports EF-VAL-010 with commit_oid attribution when the bootstrap commit contains a CHG Artifact', async () => {
		await writeFile(tempDir, 'README.txt', 'pre-EF\n')
		const baseline = commitAll(tempDir, 'pre-EF baseline')
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd('CHG-001', '[]'))
		const proposed = commitAll(tempDir, 'bootstrap with a CHG (invalid)')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(1)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-010')
		const finding = result.diagnostics.find(d => d.code === 'EF-VAL-010')!
		expect(finding.commitOid)
			.toBe(proposed)
	})

	// -------------------------------------------------------------------------
	// 7. Non-EF commits: identity-boundary optimization
	// -------------------------------------------------------------------------

	it('evaluates exactly one boundary in a range where only one commit touches .engineering, and never fully materializes the untouched commits', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		for (let i = 0; i < 10; i++) {
			await writeFile(tempDir, `unrelated-${i}.txt`, `content ${i}\n`)
			commitAll(tempDir, `unrelated change ${i}`)
		}
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const transitionOid = commitAll(tempDir, 'the one EF-touching commit')
		for (let i = 10; i < 15; i++) {
			await writeFile(tempDir, `unrelated-${i}.txt`, `content ${i}\n`)
			commitAll(tempDir, `unrelated change ${i}`)
		}
		const proposed = git(tempDir, ['rev-parse', 'HEAD'])
			.trim()

		const { executor, count } = countingExecutor(createGitExecutor(), args => args[0] === 'ls-tree' && args.includes('-r'))
		const result = await validateRange({
			git: createGitRepository(tempDir, executor),
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRefState: { resolved: true, oid: baseline },
			operationStartRef: 'refs/heads/main',
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		expect(result.valid)
			.toBe(true)
		// Exactly two commits are ever fully materialized: the baseline itself,
		// and the single commit whose `.engineering` tree entry actually
		// changed. Each materialization reads the tree recursively twice (once
		// to build the path->OID index, once inside `loadSnapshotFromCommit`),
		// mirroring `transition-validation.ts`'s own `materialize()` -- so the
		// count is 2 (commits) * 2 (reads each) = 4, not 20 (every commit) * 2.
		expect(count())
			.toBe(4)
		void transitionOid
	})

	// -------------------------------------------------------------------------
	// 8-9. Ranges with no EF state
	// -------------------------------------------------------------------------

	it('reports EF-VAL-014 when neither the baseline nor any commit in the range has an .engineering entry', async () => {
		await writeFile(tempDir, 'a.txt', 'a\n')
		const baseline = commitAll(tempDir, 'a')
		await writeFile(tempDir, 'b.txt', 'b\n')
		commitAll(tempDir, 'b')
		await writeFile(tempDir, 'c.txt', 'c\n')
		const proposed = commitAll(tempDir, 'c')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRefState: RESOLVED_ABSENT,
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		expect(result.valid)
			.toBe(true)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-014'])
		expect(result.integrationRef)
			.toBeNull()
		expect(result.expectedRefOid)
			.toBeNull()
	})

	it('reports EF-VAL-014 for an empty range (before === after) with no EF state, and strict mode still exits 0', async () => {
		await writeFile(tempDir, 'a.txt', 'a\n')
		const oid = commitAll(tempDir, 'a')

		const strictResult = await validateRange({
			git: repo(),
			baselineOid: oid,
			proposedOid: oid,
			operationStartRefState: { resolved: true, oid },
			policy: { strict: true, warningsAsErrors: true },
		})

		expect(strictResult.exitCode)
			.toBe(0)
		expect(codesOf(strictResult.diagnostics))
			.toEqual(['EF-VAL-014'])
	})

	// -------------------------------------------------------------------------
	// 10. Invalid ancestry
	// -------------------------------------------------------------------------

	describe('invalid ancestry', () => {
		it('reports EF-VAL-011 when the baseline is reachable only through a non-first parent', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			commitAll(tempDir, 'main1')
			git(tempDir, ['checkout', '-q', '-b', 'feature'])
			await writeFile(tempDir, 'feature.txt', 'feature\n')
			const feature1 = commitAll(tempDir, 'feature1')
			git(tempDir, ['checkout', '-q', 'main'])
			git(tempDir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
			const head = git(tempDir, ['rev-parse', 'HEAD'])
				.trim()

			const result = await validateRange({
				git: repo(),
				baselineOid: feature1,
				proposedOid: head,
				operationStartRefState: { resolved: true, oid: feature1 },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-011'])
		})

		it('reports EF-VAL-011 for a rewind (proposed is an ancestor of baseline)', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			const c1 = commitAll(tempDir, 'c1')
			await writeFile(tempDir, 'b.txt', 'b\n')
			const c2 = commitAll(tempDir, 'c2')

			const result = await validateRange({
				git: repo(),
				baselineOid: c2,
				proposedOid: c1,
				operationStartRefState: { resolved: true, oid: c2 },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-011'])
		})

		it('reports EF-VAL-011 for two unrelated root histories', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			const mainRoot = commitAll(tempDir, 'main root')
			git(tempDir, ['checkout', '-q', '--orphan', 'unrelated'])
			execFileSync('git', ['-C', tempDir, 'rm', '-rq', '--cached', '.'], { stdio: 'pipe' })
			await writeFile(tempDir, 'other.txt', 'other\n')
			const otherRoot = commitAll(tempDir, 'unrelated root')

			const result = await validateRange({
				git: repo(),
				baselineOid: otherRoot,
				proposedOid: mainRoot,
				operationStartRefState: { resolved: true, oid: otherRoot },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-011'])
		})
	})

	// -------------------------------------------------------------------------
	// 11-13. Ref selection, capture, and staleness
	// -------------------------------------------------------------------------

	it('reports EF-VAL-002 with expected_ref_oid equal to the already-advanced tip (the stale-ref adopter failure)', async () => {
		await writeMinimalProject(tempDir)
		const oldTip = commitAll(tempDir, 'old tip')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const newTip = commitAll(tempDir, 'new tip')

		const result = await validateRange({
			git: repo(),
			baselineOid: oldTip,
			proposedOid: newTip,
			operationStartRefState: { resolved: true, oid: newTip },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(2)
		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-002'])
		expect(result.expectedRefOid)
			.toBe(newTip)
	})

	it('reports EF-VAL-006 (never proven absence) when the ref probe itself failed', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: baseline,
			operationStartRefState: { resolved: 'error', message: 'show-ref exploded' },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-006'])
	})

	it('reports EF-VAL-002 when the captured ref name differs from the authoritative integration_ref', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: baseline,
			operationStartRef: 'refs/heads/other',
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-002'])
	})

	// -------------------------------------------------------------------------
	// 14. Mid-range integration_ref change
	// -------------------------------------------------------------------------

	it('reports EF-VAL-002 attributed to the specific commit that declares a deviating integration_ref', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const c1 = commitAll(tempDir, 'ordinary transition')
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML_OTHER_REF)
		const c2 = commitAll(tempDir, 'deviates the integration_ref')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: c2,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(2)
		expect(result.complete)
			.toBe(false)
		const finding = result.diagnostics.find(d => d.code === 'EF-VAL-002')!
		expect(finding.commitOid)
			.toBe(c2)
		void c1
	})

	// -------------------------------------------------------------------------
	// 15-16. Shallow / incomplete history and mid-walk execution failures
	// -------------------------------------------------------------------------

	describe('shallow and incomplete history', () => {
		it('reports EF-VAL-007 when listFirstParentRange reports truncated', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			await writeFile(tempDir, 'unrelated.txt', 'x\n')
			const proposed = commitAll(tempDir, 'proposed')
			const wrapped = wrapGitRepository(repo(), {
				listFirstParentRange: async () => ({ kind: 'truncated' }),
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: proposed,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
		})

		it('reports EF-VAL-007 when listFirstParentRange reports unresolved', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			const wrapped = wrapGitRepository(repo(), {
				listFirstParentRange: async () => ({ kind: 'unresolved' }),
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: baseline,
				operationStartRefState: RESOLVED_ABSENT,
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
		})

		it('reports EF-VAL-006 when listFirstParentRange reports git-unavailable', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			const wrapped = wrapGitRepository(repo(), {
				listFirstParentRange: async () => ({ kind: 'git-unavailable', message: 'no git' }),
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: baseline,
				operationStartRefState: RESOLVED_ABSENT,
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-006'])
		})

		it('validates normally in a real shallow clone whose entire validated sequence is visible', async () => {
			await writeMinimalProject(tempDir)
			commitAll(tempDir, 'unrelated')
			await writeFile(tempDir, 'baseline-marker.txt', 'x\n')
			const baseline = commitAll(tempDir, 'baseline')
			await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
			const proposed = commitAll(tempDir, 'transition')

			const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-range-shallow-')))
			await fs.rm(shallowDir, { recursive: true, force: true })
			execFileSync('git', ['clone', '-q', '--depth', '2', `file://${tempDir}`, shallowDir], { stdio: 'pipe' })
			disableBackgroundMaintenance(shallowDir)

			try {
				const result = await validateRange({
					git: repo(shallowDir),
					baselineOid: baseline,
					proposedOid: proposed,
					operationStartRefState: { resolved: true, oid: baseline },
					policy: { strict: false, warningsAsErrors: false },
				})
				expect(result.exitCode)
					.toBe(0)
			}
			finally {
				await fs.rm(shallowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
			}
		})
	})

	it('treats a read failure on an already-proven-existing commit mid-walk as incomplete, never an absent EF state', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const proposed = commitAll(tempDir, 'transition')

		const wrapped = wrapGitRepository(repo(), {
			readTree: async (oid: string) => {
				if (oid === proposed)
					return { kind: 'error', message: 'simulated read failure' }
				return repo()
					.readTree(oid)
			},
		})

		const result = await validateRange({
			git: wrapped,
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(result.complete)
			.toBe(false)
		expect(result.exitCode)
			.toBe(2)
		expect(codesOf(result.diagnostics))
			.not.toContain('EF-VAL-014')
	})

	// -------------------------------------------------------------------------
	// 17. Object format (SHA-1 malformed OIDs)
	// -------------------------------------------------------------------------

	it('rejects a 64-hex --baseline as malformed (EF-VAL-002) and a 64-hex --proposed as malformed (EF-VAL-011) in a SHA-1 repository', async () => {
		await writeMinimalProject(tempDir)
		const oid = commitAll(tempDir, 'baseline')
		const sha256Shaped = 'a'.repeat(64)

		const baselineResult = await validateRange({
			git: repo(),
			baselineOid: sha256Shaped,
			proposedOid: oid,
			operationStartRefState: RESOLVED_ABSENT,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(codesOf(baselineResult.diagnostics))
			.toEqual(['EF-VAL-002'])

		const proposedResult = await validateRange({
			git: repo(),
			baselineOid: null,
			proposedOid: sha256Shaped,
			operationStartRefState: RESOLVED_ABSENT,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(codesOf(proposedResult.diagnostics))
			.toEqual(['EF-VAL-011'])
	})

	// -------------------------------------------------------------------------
	// 19. Uppercase-hex normalization
	// -------------------------------------------------------------------------

	it('normalizes uppercase-hex baseline/proposed OIDs and still matches the walked chain', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const proposed = commitAll(tempDir, 'transition')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline.toUpperCase(),
			proposedOid: proposed.toUpperCase(),
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(result.exitCode)
			.toBe(0)
		expect(result.baselineOid)
			.toBe(baseline)
		expect(result.proposedOid)
			.toBe(proposed)
	})

	// -------------------------------------------------------------------------
	// 20. Malformed intermediate EF state + fail-fast
	// -------------------------------------------------------------------------

	it('attributes a malformed intermediate commit\'s own content defect to that commit and produces no diagnostics for a later commit (fail-fast)', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nnot: [valid, yaml: broken\n---\nbody\n')
		const brokenOid = commitAll(tempDir, 'malformed frontmatter')
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002', status: 'draft' }))
		const laterOid = commitAll(tempDir, 'a later, otherwise-fine commit')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: laterOid,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(1)
		expect(result.complete)
			.toBe(true)
		expect(result.diagnostics.length)
			.toBeGreaterThan(0)
		for (const d of result.diagnostics) {
			expect(d.commitOid)
				.toBe(brokenOid)
		}
		expect(commitOidsOf(result.diagnostics))
			.not.toContain(laterOid)
	})

	// -------------------------------------------------------------------------
	// 21. Malformed intermediate boundary (graph-wide transition invariant)
	// -------------------------------------------------------------------------

	it('reports EF-CHG-005 (uncovered active mutation) at the offending commit and stops before a later commit', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
		const baseline = commitAll(tempDir, 'baseline with active REQ-001')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', summary: 'Mutated without a covering CHG.' }))
		const uncoveredOid = commitAll(tempDir, 'mutates REQ-001 without a CHG')
		await writeFile(tempDir, 'unrelated-later.txt', 'x\n')
		const laterOid = commitAll(tempDir, 'later commit')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: laterOid,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(1)
		expect(result.complete)
			.toBe(true)
		const finding = result.diagnostics.find(d => d.code === 'EF-CHG-005')
		expect(finding?.commitOid)
			.toBe(uncoveredOid)
		expect(commitOidsOf(result.diagnostics))
			.not.toContain(laterOid)
	})

	// -------------------------------------------------------------------------
	// 22. Invalid baseline vs invalid state inside the range
	// -------------------------------------------------------------------------

	it('reports an invalid EF-bearing baseline as EF-VAL-002 with complete: false, exit 2 -- distinct from an invalid state inside the range (exit 1)', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nbroken: [yaml\n---\nbody\n')
		const invalidBaseline = commitAll(tempDir, 'invalid baseline')
		await writeFile(tempDir, 'unrelated.txt', 'x\n')
		const proposed = commitAll(tempDir, 'proposed')

		const result = await validateRange({
			git: repo(),
			baselineOid: invalidBaseline,
			proposedOid: proposed,
			operationStartRefState: { resolved: true, oid: invalidBaseline },
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(result.exitCode)
			.toBe(2)
		expect(result.complete)
			.toBe(false)
		expect(codesOf(result.diagnostics))
			.toContain('EF-VAL-002')
	})

	// -------------------------------------------------------------------------
	// 23. EF removal mid-range
	// -------------------------------------------------------------------------

	it('reports EF-VAL-013 when a commit removes the authoritative EF state, and stops the walk', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await removeFile(tempDir, '.engineering')
		const removalOid = commitAll(tempDir, 'removes .engineering entirely')
		await writeFile(tempDir, 'after-removal.txt', 'x\n')
		const laterOid = commitAll(tempDir, 'a commit after the removal')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: laterOid,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(1)
		expect(result.complete)
			.toBe(true)
		expect(codesOf(result.diagnostics))
			.toEqual(['EF-VAL-013'])
		expect(result.diagnostics[0]!.commitOid)
			.toBe(removalOid)
	})

	// -------------------------------------------------------------------------
	// 24. Merge commits
	// -------------------------------------------------------------------------

	describe('merge commits', () => {
		it('treats a merge with an unchanged .engineering tree as an identity boundary', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			git(tempDir, ['checkout', '-q', '-b', 'feature'])
			await writeFile(tempDir, 'feature-code.txt', 'code only, no EF changes\n')
			commitAll(tempDir, 'feature commit (no EF changes)')
			git(tempDir, ['checkout', '-q', 'main'])
			git(tempDir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
			const proposed = git(tempDir, ['rev-parse', 'HEAD'])
				.trim()

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: proposed,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(0)
			expect(codesOf(result.diagnostics))
				.toEqual([])
		})

		it('evaluates a merge bringing EF changes through its second parent as one aggregated transition boundary, never validating the non-first-parent commits directly', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			git(tempDir, ['checkout', '-q', '-b', 'feature'])
			await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
			const featureOid = commitAll(tempDir, 'feature: introduce REQ-001')
			git(tempDir, ['checkout', '-q', 'main'])
			git(tempDir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
			const mergeOid = git(tempDir, ['rev-parse', 'HEAD'])
				.trim()

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: mergeOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(result.exitCode)
				.toBe(0)
			expect(codesOf(result.diagnostics))
				.toEqual([])
			expect(commitOidsOf(result.diagnostics))
				.not.toContain(featureOid)
		})
	})

	// -------------------------------------------------------------------------
	// 25. Distinct-defect dedup across boundaries (commit_oid prevents collapse)
	// -------------------------------------------------------------------------

	it('keeps the same warning code and path as two distinct findings when it recurs at two different boundaries', async () => {
		await writeMinimalProject(tempDir, { termsInOrder: false })
		const baseline = commitAll(tempDir, 'baseline (terminology already out of order)')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const c1 = commitAll(tempDir, 'add draft REQ-001 (terminology still out of order)')
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002', status: 'draft' }))
		const c2 = commitAll(tempDir, 'add draft REQ-002 (terminology still out of order)')

		const result = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: c2,
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})

		expect(result.exitCode)
			.toBe(0)
		const termOrderFindings = result.diagnostics.filter(d => d.code === 'EF-BODY-019')
		expect(termOrderFindings)
			.toHaveLength(2)
		expect(new Set(termOrderFindings.map(d => d.commitOid)))
			.toEqual(new Set([c1, c2]))
	})

	// -------------------------------------------------------------------------
	// 26. Deterministic ordering (commit_oid is the final tiebreaker)
	// -------------------------------------------------------------------------

	it('orders two otherwise-identical findings by commit_oid as the final tiebreaker, deterministically across runs', async () => {
		await writeMinimalProject(tempDir, { termsInOrder: false })
		const baseline = commitAll(tempDir, 'baseline (terminology already out of order)')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
		const c1 = commitAll(tempDir, 'add draft REQ-001')
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002', status: 'draft' }))
		const c2 = commitAll(tempDir, 'add draft REQ-002')

		const input = {
			git: repo(),
			baselineOid: baseline,
			proposedOid: c2,
			operationStartRefState: { resolved: true, oid: baseline } as OperationStartRefState,
			policy: { strict: false, warningsAsErrors: false },
		}
		const first = await validateRange(input)
		const second = await validateRange(input)

		expect(first.diagnostics)
			.toEqual(second.diagnostics)
		const [a, b] = [c1, c2].sort()
		const termOrderOids = first.diagnostics.filter(d => d.code === 'EF-BODY-019')
			.map(d => d.commitOid)
		expect(termOrderOids)
			.toEqual([a, b])
	})

	// -------------------------------------------------------------------------
	// 31. Cross-consistency with ef query history
	// -------------------------------------------------------------------------

	it('a range that validates clean is later walked by computeHistory over the same commits without reporting untrusted-data', async () => {
		await writeMinimalProject(tempDir)
		const baseline = commitAll(tempDir, 'baseline')
		await addActiveRequirementWithIntroducingChg(tempDir, 'REQ-001', 'CHG-001')
		const proposed = commitAll(tempDir, 'introduce REQ-001')
		git(tempDir, ['update-ref', 'refs/heads/main', proposed])

		const rangeResult = await validateRange({
			git: repo(),
			baselineOid: baseline,
			proposedOid: proposed,
			operationStartRef: 'refs/heads/main',
			operationStartRefState: { resolved: true, oid: baseline },
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(rangeResult.exitCode)
			.toBe(0)

		const loaded = await loadSnapshotFromCommit(repo(), proposed)
		expect(loaded.ok)
			.toBe(true)
		if (!loaded.ok)
			return
		const validation = validateSnapshot(loaded.snapshot)

		const historyResult = await computeHistory(repo(), proposed, 'REQ-001', 'requirement', validation.byId, 'refs/heads/main')
		expect(historyResult.kind)
			.toBe('complete')
	})
})
