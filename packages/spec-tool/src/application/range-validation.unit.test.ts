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
import { findRangeIntegrationRefSource, validateRange } from './range-validation'
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

/** `git write-tree`: materialize the current index as a tree object, returning its OID. */
function writeTreeOid(dir: string): string {
	return git(dir, ['write-tree'])
		.trim()
}

/** `git commit-tree`: create a commit for `treeOid` (optionally with `parentOid`) without touching any ref, returning its OID. */
function commitTreeOid(dir: string, treeOid: string, message: string, parentOid?: string): string {
	const args = parentOid !== undefined ? ['commit-tree', treeOid, '-p', parentOid, '-m', message] : ['commit-tree', treeOid, '-m', message]
	return git(dir, args)
		.trim()
}

/** `git hash-object -w --stdin`: writes `content` to the object database, returning the resulting blob OID. */
function hashObjectFromStdin(dir: string, content: string): string {
	return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: { ...process.env, ...GIT_TEST_ENV }, input: content, encoding: 'utf8' })
		.trim()
}

/**
 * Stages `.engineering/ef.yaml` in the index at an explicit non-regular-file
 * Git `mode` -- `120000` (symlink) or `160000` (gitlink/submodule) -- via
 * `git update-index --add --cacheinfo`, without ever creating a real
 * filesystem symlink or submodule (mirrors
 * `cli/commands/validate.unit.test.ts`'s `stageSymlinkModeConfig`). `ls-tree`
 * reports a `120000` entry's `type` as `blob` -- identical to an ordinary
 * file -- so only its Git MODE reveals it is a symlink; a `160000` entry's
 * `type` is `commit`. `--add --cacheinfo` replaces any existing index entry
 * at that exact path, so this may be called directly after an ordinary
 * `git add -A` without a separate `git rm --cached` first.
 */
function stageNonRegularEfYaml(dir: string, mode: '120000' | '160000', objectOid: string): void {
	git(dir, ['update-index', '--add', '--cacheinfo', `${mode},${objectOid},.engineering/ef.yaml`])
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

	// -------------------------------------------------------------------------
	// 32. Bootstrap history condition: every FirstParentResult variant
	// (regression for the fail-open finding: `root-commit` MUST be the only
	// variant treated as vacuous success; `missing` and `not-a-commit` must
	// never fall through into that same vacuous-success path and be mistaken
	// for a complete bootstrap proof)
	// -------------------------------------------------------------------------

	describe('bootstrap history condition: every FirstParentResult variant', () => {
		async function setupPreEfBaselineAndBootstrap(): Promise<{ baseline: string, bootstrapOid: string }> {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap')
			return { baseline, bootstrapOid }
		}

		it('root-commit: the ONLY vacuous-success variant -- no probe, valid bootstrap, exit 0', async () => {
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'root bootstrap')

			const result = await validateRange({
				git: repo(),
				baselineOid: null,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: false },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(0)
			expect(result.valid)
				.toBe(true)
			expect(codesOf(result.diagnostics))
				.toEqual([])
		})

		it('resolved, no prior EF state in first-parent history: satisfied -- valid bootstrap, exit 0', async () => {
			const { baseline, bootstrapOid } = await setupPreEfBaselineAndBootstrap()

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(0)
			expect(result.valid)
				.toBe(true)
			expect(codesOf(result.diagnostics))
				.toEqual([])
		})

		it('resolved, prior EF state found in first-parent history: violated -- EF-VAL-009, complete and invalid, exit 1', async () => {
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
			commitAll(tempDir, 'stray historical EF state')
			await removeFile(tempDir, '.engineering')
			const baseline = commitAll(tempDir, 'back to pre-EF')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'attempted bootstrap')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: bootstrapOid,
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
		})

		it('error: incomplete -- EF-VAL-007 attributed to the boundary commit, never a proof of anything', async () => {
			const { baseline, bootstrapOid } = await setupPreEfBaselineAndBootstrap()

			const wrapped = wrapGitRepository(repo(), {
				getFirstParent: async (oid: string) => {
					if (oid === bootstrapOid)
						return { kind: 'error', message: 'simulated parentage read failure' }
					return repo()
						.getFirstParent(oid)
				},
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(false)
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
			expect(result.diagnostics[0]!.commitOid)
				.toBe(bootstrapOid)
		})

		it('missing: incomplete -- EF-VAL-007, NEVER treated as vacuous success (the fail-open regression)', async () => {
			const { baseline, bootstrapOid } = await setupPreEfBaselineAndBootstrap()

			const wrapped = wrapGitRepository(repo(), {
				getFirstParent: async (oid: string) => {
					if (oid === bootstrapOid)
						return { kind: 'missing' }
					return repo()
						.getFirstParent(oid)
				},
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(false)
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
			expect(result.diagnostics[0]!.commitOid)
				.toBe(bootstrapOid)
			// Never a proof the bootstrap is valid: this must never present as a
			// complete, valid result the way a `root-commit` vacuous success would.
			expect(result.valid)
				.toBe(false)
		})

		it('not-a-commit: incomplete -- EF-VAL-007, NEVER treated as vacuous success (the fail-open regression)', async () => {
			const { baseline, bootstrapOid } = await setupPreEfBaselineAndBootstrap()

			const wrapped = wrapGitRepository(repo(), {
				getFirstParent: async (oid: string) => {
					if (oid === bootstrapOid)
						return { kind: 'not-a-commit' }
					return repo()
						.getFirstParent(oid)
				},
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(false)
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-007'])
			expect(result.diagnostics[0]!.commitOid)
				.toBe(bootstrapOid)
			expect(result.valid)
				.toBe(false)
		})

		it('git-unavailable: incomplete -- EF-VAL-006, never carries commit_oid, never a proof of anything', async () => {
			const { baseline, bootstrapOid } = await setupPreEfBaselineAndBootstrap()

			const wrapped = wrapGitRepository(repo(), {
				getFirstParent: async (oid: string) => {
					if (oid === bootstrapOid)
						return { kind: 'git-unavailable', message: 'simulated git unavailable' }
					return repo()
						.getFirstParent(oid)
				},
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(false)
			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-006'])
			expect(result.diagnostics[0]!.commitOid)
				.toBeUndefined()
		})
	})

	// -------------------------------------------------------------------------
	// Round 2 fix: the range's bootstrap boundary (never the proposed commit)
	// fixes the authoritative integration_ref -- no look-ahead
	// -------------------------------------------------------------------------

	describe('ref selection: the bootstrap boundary fixes integration_ref, never the proposed commit', () => {
		it('required (reviewer scenario): EF-state removal at the proposed commit no longer preempts the bootstrap boundary\'s own ref fixing', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap declaring refs/heads/main')
			await removeFile(tempDir, '.engineering')
			const removalOid = commitAll(tempDir, 'removes the EF state')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: removalOid,
				operationStartRef: 'refs/heads/main',
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(true)
			expect(result.valid)
				.toBe(false)
			expect(result.exitCode)
				.toBe(1)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-013'])
			expect(result.diagnostics[0]!.commitOid)
				.toBe(removalOid)
			expect(result.integrationRef)
				.toBe('refs/heads/main')
			expect(result.expectedRefOid)
				.toBe(baseline)
			void bootstrapOid
		})

		it('required (reviewer scenario): a malformed later commit no longer preempts the bootstrap boundary\'s own findings', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap declaring refs/heads/main')
			await writeFile(tempDir, '.engineering/ef.yaml', 'not: [valid, yaml: broken\n')
			const malformedOid = commitAll(tempDir, 'malformed ef.yaml')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: malformedOid,
				operationStartRef: 'refs/heads/main',
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(true)
			expect(result.exitCode)
				.toBe(1)
			expect(result.integrationRef)
				.toBe('refs/heads/main')
			expect(result.expectedRefOid)
				.toBe(baseline)
			const fsFinding = result.diagnostics.find(d => d.code === 'EF-FS-001')
			expect(fsFinding)
				.toBeDefined()
			expect(fsFinding!.commitOid)
				.toBe(malformedOid)
			expect(commitOidsOf(result.diagnostics))
				.not.toContain(bootstrapOid)
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-VAL-007')
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-VAL-002')
		})

		it('preemption regression: an invalid bootstrap boundary wins even when a later commit is also malformed', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd('CHG-001', '[]'))
			const invalidBootstrapOid = commitAll(tempDir, 'bootstrap with a CHG (invalid)')
			await writeFile(tempDir, '.engineering/ef.yaml', 'not: [valid, yaml: broken\n')
			const malformedOid = commitAll(tempDir, 'later malformed ef.yaml')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: malformedOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.complete)
				.toBe(true)
			expect(result.exitCode)
				.toBe(1)
			for (const d of result.diagnostics) {
				expect(d.commitOid)
					.toBe(invalidBootstrapOid)
			}
			expect(codesOf(result.diagnostics))
				.toContain('EF-VAL-010')
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-FS-001')
			expect(commitOidsOf(result.diagnostics))
				.not.toContain(malformedOid)
		})

		it('structural no-look-ahead proof: the proposed OID is never read when the walk stops at the bootstrap boundary', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/chg/CHG-001.md', changeMd('CHG-001', '[]'))
			const invalidBootstrapOid = commitAll(tempDir, 'bootstrap with a CHG (invalid)')
			await writeFile(tempDir, '.engineering/ef.yaml', 'not: [valid, yaml: broken\n')
			const malformedOid = commitAll(tempDir, 'later malformed ef.yaml')

			const real = repo()
			const readTreeOids: string[] = []
			const wrapped = wrapGitRepository(real, {
				readTree: async (oid: string) => {
					readTreeOids.push(oid)
					return real.readTree(oid)
				},
			})

			const result = await validateRange({
				git: wrapped,
				baselineOid: baseline,
				proposedOid: malformedOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(1)
			expect(readTreeOids)
				.not.toContain(malformedOid)
			expect(readTreeOids)
				.toContain(invalidBootstrapOid)
		})

		it('a bootstrap boundary that names no valid integration_ref is complete and invalid, with no ref check attempted', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeFile(tempDir, '.engineering/.gitignore', GITIGNORE)
			await writeFile(tempDir, '.engineering/PROJECT.md', projectMd())
			const noConfigOid = commitAll(tempDir, '.engineering without ef.yaml')

			const withState = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: noConfigOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(withState.complete)
				.toBe(true)
			expect(withState.valid)
				.toBe(false)
			expect(withState.exitCode)
				.toBe(1)
			expect(withState.integrationRef)
				.toBeNull()
			expect(withState.expectedRefOid)
				.toBeNull()
			expect(withState.diagnostics.some(d => d.severity === 'error' && d.commitOid === noConfigOid))
				.toBe(true)

			const withoutState = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: noConfigOid,
				policy: { strict: false, warningsAsErrors: false },
			})
			expect(withoutState.complete)
				.toBe(true)
			expect(withoutState.valid)
				.toBe(false)
			expect(withoutState.exitCode)
				.toBe(1)
			expect(withoutState.integrationRef)
				.toBeNull()
			expect(withoutState.expectedRefOid)
				.toBeNull()
			expect(codesOf(withoutState.diagnostics))
				.toEqual(codesOf(withState.diagnostics))
		})

		it('later states must still preserve the ref fixed by the range\'s own bootstrap boundary (EF-VAL-002)', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap declaring refs/heads/main')
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML_OTHER_REF)
			const deviatingOid = commitAll(tempDir, 'deviates the integration_ref')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: deviatingOid,
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(2)
			expect(result.complete)
				.toBe(false)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-002'])
			const finding = result.diagnostics.find(d => d.code === 'EF-VAL-002')!
			expect(finding.commitOid)
				.toBe(deviatingOid)
			expect(result.integrationRef)
				.toBe('refs/heads/main')
			void bootstrapOid
		})

		it('the captured-ref check runs at the bootstrap boundary, before a later removal is ever reached', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeFile(tempDir, 'other.txt', 'unrelated\n')
			const otherOid = commitAll(tempDir, 'unrelated commit')
			await writeMinimalProject(tempDir)
			commitAll(tempDir, 'bootstrap declaring refs/heads/main')
			await removeFile(tempDir, '.engineering')
			const removalOid = commitAll(tempDir, 'removes the EF state')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: removalOid,
				operationStartRefState: { resolved: true, oid: otherOid },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(2)
			expect(result.complete)
				.toBe(false)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-002'])
		})

		it('a captured ref NAME mismatch is judged against the bootstrap boundary\'s own configuration', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap declaring refs/heads/main')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				operationStartRef: 'refs/heads/other',
				operationStartRefState: { resolved: true, oid: baseline },
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(2)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-002'])
		})

		it('a missing capture is never proven ref absence, even with an EF-bearing baseline (EF-VAL-006, not EF-VAL-002)', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: baseline,
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(2)
			expect(result.complete)
				.toBe(false)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-006'])
			expect(result.diagnostics[0]!.message)
				.toContain('refs/heads/main')
		})

		it('a missing capture is never proven ref absence for a pre-EF baseline with a bootstrap in range (EF-VAL-006, not EF-VAL-002)', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap declaring refs/heads/main')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: bootstrapOid,
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(2)
			expect(result.complete)
				.toBe(false)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-006'])
			expect(result.diagnostics[0]!.message)
				.toContain('refs/heads/main')
		})

		it('an EF-inert range makes no ref check and needs no capture, even under strict mode', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			const baseline = commitAll(tempDir, 'a')
			await writeFile(tempDir, 'b.txt', 'b\n')
			const proposed = commitAll(tempDir, 'b')

			const result = await validateRange({
				git: repo(),
				baselineOid: baseline,
				proposedOid: proposed,
				policy: { strict: true, warningsAsErrors: true },
			})

			expect(result.exitCode)
				.toBe(0)
			expect(result.complete)
				.toBe(true)
			expect(result.valid)
				.toBe(true)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-014'])
			expect(result.integrationRef)
				.toBeNull()
			expect(result.expectedRefOid)
				.toBeNull()
		})

		it('an EF-inert empty range (baseline === proposed) makes no ref check and needs no capture', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			const oid = commitAll(tempDir, 'a')

			const result = await validateRange({
				git: repo(),
				baselineOid: oid,
				proposedOid: oid,
				policy: { strict: false, warningsAsErrors: false },
			})

			expect(result.exitCode)
				.toBe(0)
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-VAL-014'])
			expect(result.integrationRef)
				.toBeNull()
			expect(result.expectedRefOid)
				.toBeNull()
		})
	})

	// -------------------------------------------------------------------------
	// Absolute Git trust rule (`peekConfigAt`, `cli/commands/validate.ts`): a
	// non-regular-file entry at exactly `.engineering/ef.yaml` on the ONE
	// commit whose configuration is trusted to fix the range's authoritative
	// `integration_ref` must never be silently trusted, and must never be
	// collapsed into the SAME outcome as a genuine absence of a valid ref.
	// `validateRange` is not part of the package's public library surface
	// (`src/index.ts` deliberately exports nothing; `application/index.ts`'s
	// barrel is internal) and every CLI path into range scope is preceded by
	// the CLI's own `peekConfigAt`-based preflight, so this is unreachable
	// through the CLI today -- these are direct-call regressions for a caller
	// that invokes `validateRange` itself.
	// -------------------------------------------------------------------------

	describe('a non-regular-file .engineering/ef.yaml on the ref-fixing commit is EF-VAL-006, never a trusted or silently absent ref', () => {
		describe('baseline-carries-EF path (the trusted range baseline itself names integration_ref)', () => {
			it('a symlink at the baseline\'s ef.yaml is untrusted -- never the symlink target text', async () => {
				await writeMinimalProject(tempDir)
				git(tempDir, ['add', '-A'])
				stageNonRegularEfYaml(tempDir, '120000', hashObjectFromStdin(tempDir, CONFIG_YAML))
				const baselineTree = writeTreeOid(tempDir)
				const baseline = commitTreeOid(tempDir, baselineTree, 'baseline with symlinked config')
				// Restage from the real (unchanged) working tree -- ef.yaml was
				// never actually replaced on disk, only its INDEX entry -- so
				// `proposed` is an ordinary, trusted child commit of `baseline`.
				git(tempDir, ['add', '-A'])
				const proposedTree = writeTreeOid(tempDir)
				const proposed = commitTreeOid(tempDir, proposedTree, 'proposed with real config', baseline)

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: proposed,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
				expect(result.integrationRef)
					.toBeNull()
				expect(result.baselineOid)
					.toBe(baseline)
			})

			it('a gitlink (submodule, mode 160000) at the baseline\'s ef.yaml is untrusted', async () => {
				await writeMinimalProject(tempDir)
				git(tempDir, ['add', '-A'])
				stageNonRegularEfYaml(tempDir, '160000', 'a'.repeat(40))
				const baselineTree = writeTreeOid(tempDir)
				const baseline = commitTreeOid(tempDir, baselineTree, 'baseline with gitlink config')
				git(tempDir, ['add', '-A'])
				const proposedTree = writeTreeOid(tempDir)
				const proposed = commitTreeOid(tempDir, proposedTree, 'proposed with real config', baseline)

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: proposed,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
			})

			it('a directory literally named ef.yaml at the baseline is untrusted', async () => {
				await writeMinimalProject(tempDir)
				await removeFile(tempDir, '.engineering/ef.yaml')
				await writeFile(tempDir, '.engineering/ef.yaml/marker.txt', 'x\n')
				const baseline = commitAll(tempDir, 'baseline with a directory named ef.yaml')
				await writeFile(tempDir, 'unrelated.txt', 'x\n')
				const proposed = commitAll(tempDir, 'proposed')

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: proposed,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
			})
		})

		describe('bootstrap-boundary path (a pre-EF baseline; the range\'s own bootstrap commit names integration_ref)', () => {
			it('a symlink at the bootstrap commit\'s ef.yaml is untrusted -- never a silently complete, null-ref result', async () => {
				await writeFile(tempDir, 'README.txt', 'pre-EF\n')
				const baseline = commitAll(tempDir, 'pre-EF baseline')
				await writeMinimalProject(tempDir)
				git(tempDir, ['add', '-A'])
				stageNonRegularEfYaml(tempDir, '120000', hashObjectFromStdin(tempDir, CONFIG_YAML))
				const bootstrapTree = writeTreeOid(tempDir)
				const bootstrapOid = commitTreeOid(tempDir, bootstrapTree, 'bootstrap with symlinked config', baseline)

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: bootstrapOid,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
				expect(result.integrationRef)
					.toBeNull()
				expect(result.baselineOid)
					.toBe(baseline)
			})

			it('a gitlink (mode 160000) at the bootstrap commit\'s ef.yaml is untrusted', async () => {
				await writeFile(tempDir, 'README.txt', 'pre-EF\n')
				const baseline = commitAll(tempDir, 'pre-EF baseline')
				await writeMinimalProject(tempDir)
				git(tempDir, ['add', '-A'])
				stageNonRegularEfYaml(tempDir, '160000', 'b'.repeat(40))
				const bootstrapTree = writeTreeOid(tempDir)
				const bootstrapOid = commitTreeOid(tempDir, bootstrapTree, 'bootstrap with gitlink config', baseline)

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: bootstrapOid,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
			})

			it('a directory literally named ef.yaml at the bootstrap commit is untrusted', async () => {
				await writeFile(tempDir, 'README.txt', 'pre-EF\n')
				const baseline = commitAll(tempDir, 'pre-EF baseline')
				await writeMinimalProject(tempDir)
				await removeFile(tempDir, '.engineering/ef.yaml')
				await writeFile(tempDir, '.engineering/ef.yaml/marker.txt', 'x\n')
				const bootstrapOid = commitAll(tempDir, 'bootstrap with a directory named ef.yaml')

				const result = await validateRange({
					git: repo(),
					baselineOid: baseline,
					proposedOid: bootstrapOid,
					policy: { strict: false, warningsAsErrors: false },
				})

				expect(result.complete)
					.toBe(false)
				expect(codesOf(result.diagnostics))
					.toEqual(['EF-VAL-006'])
				expect(result.diagnostics[0]!.message)
					.toContain('not a regular file')
			})
		})
	})

	// -------------------------------------------------------------------------
	// findRangeIntegrationRefSource: the ONE definition of the ref-selection
	// rule, consumed by the CLI preflight -- direct tests
	// -------------------------------------------------------------------------

	describe('findRangeIntegrationRefSource', () => {
		it('returns the trusted range baseline when its .engineering entry is present', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			await writeFile(tempDir, 'unrelated.txt', 'x\n')
			const proposed = commitAll(tempDir, 'unrelated')

			const source = await findRangeIntegrationRefSource(repo(), baseline, proposed)
			expect(source)
				.toEqual({ kind: 'commit', role: 'baseline', commitOid: baseline })
		})

		it('returns the range\'s bootstrap boundary -- not the proposed commit -- when the baseline is pre-EF', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeFile(tempDir, 'unrelated-1.txt', 'x\n')
			commitAll(tempDir, 'unrelated 1')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap')
			await writeFile(tempDir, 'unrelated-2.txt', 'x\n')
			const proposed = commitAll(tempDir, 'unrelated 2')

			const source = await findRangeIntegrationRefSource(repo(), baseline, proposed)
			expect(source)
				.toEqual({ kind: 'commit', role: 'bootstrap', commitOid: bootstrapOid })
			expect(source).not.toMatchObject({ commitOid: proposed })
		})

		it('still finds the bootstrap boundary when the proposed commit itself removes .engineering -- the removal must never hide it', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap')
			await removeFile(tempDir, '.engineering')
			const proposed = commitAll(tempDir, 'removes .engineering')

			const source = await findRangeIntegrationRefSource(repo(), baseline, proposed)
			expect(source)
				.toEqual({ kind: 'commit', role: 'bootstrap', commitOid: bootstrapOid })
		})

		it('finds a root-commit bootstrap when baselineOid is null', async () => {
			await writeMinimalProject(tempDir)
			const root = commitAll(tempDir, 'root bootstrap')

			const source = await findRangeIntegrationRefSource(repo(), null, root)
			expect(source)
				.toEqual({ kind: 'commit', role: 'bootstrap', commitOid: root })
		})

		it('returns none for an EF-inert range', async () => {
			await writeFile(tempDir, 'a.txt', 'a\n')
			const baseline = commitAll(tempDir, 'a')
			await writeFile(tempDir, 'b.txt', 'b\n')
			const proposed = commitAll(tempDir, 'b')

			const source = await findRangeIntegrationRefSource(repo(), baseline, proposed)
			expect(source)
				.toEqual({ kind: 'none' })
		})

		it('returns none (never a false EF-VAL-* report) for each listFirstParentRange failure kind, leaving validateRange as the sole reporter', async () => {
			// A pre-EF baseline forces the function past its own baseline check
			// and into the `listFirstParentRange` call being exercised here.
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeFile(tempDir, 'unrelated.txt', 'x\n')
			const proposed = commitAll(tempDir, 'unrelated')

			for (const failure of [
				{ kind: 'truncated' as const },
				{ kind: 'unresolved' as const },
				{ kind: 'not-an-ancestor' as const },
				{ kind: 'git-unavailable' as const, message: 'simulated' },
			]) {
				const wrapped = wrapGitRepository(repo(), {
					listFirstParentRange: async () => failure,
				})
				const source = await findRangeIntegrationRefSource(wrapped, baseline, proposed)
				expect(source)
					.toEqual({ kind: 'none' })
			}
		})

		it('returns blocked (never none, never a silently skipped commit) for each readPathEntry failure kind at the baseline position', async () => {
			await writeMinimalProject(tempDir)
			const baseline = commitAll(tempDir, 'baseline')
			await writeFile(tempDir, 'unrelated.txt', 'x\n')
			const proposed = commitAll(tempDir, 'unrelated')

			for (const failure of [
				{ kind: 'git-unavailable' as const, message: 'simulated git-unavailable' },
				{ kind: 'missing' as const },
				{ kind: 'error' as const, message: 'simulated error' },
			]) {
				const wrapped = wrapGitRepository(repo(), {
					readPathEntry: async () => failure,
				})
				const source = await findRangeIntegrationRefSource(wrapped, baseline, proposed)
				expect(source.kind)
					.toBe('blocked')
				if (source.kind === 'blocked') {
					expect(source.message)
						.toContain('baseline')
				}
			}
		})

		it('returns blocked (never none, never a silently skipped commit) for each readPathEntry failure kind at a mid-sequence position', async () => {
			await writeFile(tempDir, 'README.txt', 'pre-EF\n')
			const baseline = commitAll(tempDir, 'pre-EF baseline')
			await writeMinimalProject(tempDir)
			const bootstrapOid = commitAll(tempDir, 'bootstrap')

			for (const failure of [
				{ kind: 'git-unavailable' as const, message: 'simulated git-unavailable' },
				{ kind: 'missing' as const },
				{ kind: 'error' as const, message: 'simulated error' },
			]) {
				const real = repo()
				const wrapped = wrapGitRepository(real, {
					readPathEntry: async (oid: string, path: string) => {
						if (oid === bootstrapOid)
							return failure
						return real.readPathEntry(oid, path)
					},
				})
				const source = await findRangeIntegrationRefSource(wrapped, baseline, bootstrapOid)
				expect(source.kind)
					.toBe('blocked')
				if (source.kind === 'blocked') {
					expect(source.message)
						.toContain(`commit '${bootstrapOid}'`)
				}
			}
		})
	})
})
