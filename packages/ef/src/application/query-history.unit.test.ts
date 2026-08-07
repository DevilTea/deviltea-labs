import type { GitRepository } from '../git/repository'
import type { SnapshotArtifactRecord } from './snapshot-validation'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { computeHistory } from './query-history'

/** Delegates every call to `real`, except properties overridden in `overrides` -- lets a test intercept one Git operation deep inside a real history walk while every other call still hits the real repository. */
function wrapGitRepository(real: GitRepository, overrides: Partial<GitRepository>): GitRepository {
	return {
		root: real.root,
		findWorktreeRoot: (...args) => real.findWorktreeRoot(...args),
		getObjectFormat: (...args) => real.getObjectFormat(...args),
		resolveCommit: (...args) => real.resolveCommit(...args),
		resolveRef: (...args) => real.resolveRef(...args),
		getFirstParent: (...args) => real.getFirstParent(...args),
		readTree: (...args) => real.readTree(...args),
		readBlob: (...args) => real.readBlob(...args),
		listFirstParentHistory: (...args) => real.listFirstParentHistory(...args),
		pathExistsInFirstParentHistory: (...args) => real.pathExistsInFirstParentHistory(...args),
		diffTrees: (...args) => real.diffTrees(...args),
		...overrides,
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
	// `.git/objects/pack` when `afterEach`'s `fs.rm` tears the fixture down,
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

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

/** Write `content` to the object database via `git hash-object -w --stdin`, returning the resulting blob OID -- without ever touching the working tree or index by path (Finding 10 fixtures below). */
function hashObjectFromStdin(dir: string, content: Buffer): string {
	return execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: { ...process.env, ...GIT_TEST_ENV }, input: content, encoding: 'utf8' })
		.trim()
}

/** Stage one index entry at an ordinary (ASCII) `path` with an explicit `mode` -- e.g. `120000` for a symlink -- via `git update-index --add --cacheinfo`, without ever creating a real filesystem symlink. */
function addCacheinfoEntry(dir: string, mode: string, blobOid: string, path: string): void {
	execFileSync('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `${mode},${blobOid},${path}`], { env: { ...process.env, ...GIT_TEST_ENV } })
}

/** Stage one index entry whose PATH is exactly `pathBytes` -- which may contain byte sequences that are not valid UTF-8 -- via `git update-index --index-info`, fed over stdin as a `Buffer` since raw invalid-UTF-8 bytes cannot be passed as a normal CLI argument. */
function addRawIndexEntry(dir: string, mode: string, blobOid: string, pathBytes: Buffer): void {
	const line = Buffer.concat([Buffer.from(`${mode} blob ${blobOid}\t`), pathBytes, Buffer.from('\n')])
	execFileSync('git', ['-C', dir, 'update-index', '--add', '--index-info'], { env: { ...process.env, ...GIT_TEST_ENV }, input: line })
}

/** `git write-tree`: materialize the current index as a tree object, returning its OID. */
function writeTreeOid(dir: string): string {
	return execFileSync('git', ['-C', dir, 'write-tree'], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
		.trim()
}

/** `git commit-tree <treeOid> -p <parentOid>`: create a commit for `treeOid` with a single parent, returning its OID. Used (instead of `commitAll`) whenever a fixture needs to inject a raw index entry `commitAll`'s own `git add -A` (working-tree-driven) could never stage. */
function commitTreeOid(dir: string, treeOid: string, parentOid: string, message: string): string {
	return execFileSync('git', ['-C', dir, 'commit-tree', treeOid, '-p', parentOid, '-m', message], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
		.trim()
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

/** The `integration_ref` every `CONFIG_YAML` fixture above declares -- passed as `computeHistory`'s `expectedIntegrationRef` argument by every test in this file unless a test is deliberately exercising Finding 11 (immutable `integration_ref`) itself. */
const INTEGRATION_REF = 'refs/heads/main'

// Eighth-round Finding 5: the bootstrap boundary now runs COMPLETE snapshot
// validation (`validateSnapshot`), which includes body-schema validation
// (`domain/body-schemas.ts`) over every Artifact present at that commit --
// PROJECT's own required sections always among them (`requiresCompleteness`
// is unconditionally `true` for `type: project`). `PROJECT_MD` must therefore
// carry every required section with meaningful content, not just a minimal
// `id`/`type`/`status` witness.
const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: Example project used for history tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering workflow.

## Scope

This project covers the Artifacts and history exercised by these tests.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

The project operates as a single-repository workspace with no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
`

// Every required heading must be PRESENT regardless of `status`
// (`requiresHeadingPresence` is unconditionally `true` for non-`change`
// types) -- so `reqMd` always emits Requirement/Rationale/Acceptance Criteria,
// with real (non-placeholder) content so the fixture remains valid whichever
// status a test passes (`draft` never requires meaningful content, but
// `active`/`superseded` do; supplying it unconditionally keeps this one
// helper correct for every caller).
function reqMd(id: string, status: string, resourcesYaml = '[]'): string {
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Title of ${id}
status: ${status}
summary: Summary of ${id}.
tags: []
relations: []
resources: ${resourcesYaml}
---

## Requirement

Body text for ${id}.

## Rationale

Rationale text for ${id}.

## Acceptance Criteria

- ${id} behaves as described.
`
}

function chgMd(id: string, status: string, relationsYaml: string, title = `Title of ${id}`): string {
	return `---
schema: ef/change@1
type: change
id: ${id}
title: ${title}
status: ${status}
summary: Summary of ${id}.
tags: []
relations:
${relationsYaml}
resources: []
---

## Rationale

Rationale text.

## Sources

- Sources text.

## Changes

- Did something.

## Verification

Result: passed

- Verified.
`
}

// Eighth-round Finding 5 (see `PROJECT_MD`'s own comment above): every
// required heading is unconditionally present regardless of status
// (`requiresHeadingPresence` is unconditionally `true` for non-`change`
// types), with real content so `requiresCompleteness` is satisfied whichever
// status a caller substitutes in. `superseded` additionally requires a
// meaningful, final `## Lifecycle` section (`EF-BODY-009`); a non-terminal
// status must NOT carry one at all (`EF-BODY-010`), so the `active` variant
// below has it stripped rather than merely swapping the `status:` field.
const REQ_001_WITH_RESOURCE = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Title of REQ-001
status: superseded
summary: Summary of REQ-001.
tags: []
relations: []
resources:
  - type: reference
    location: .engineering/resources/REQ-001/notes.md
    role: reference
    media_type: text/markdown
    normative: false
    description: Supplementary notes.
---

## Requirement

Body text for REQ-001.

## Rationale

Rationale text for REQ-001.

## Acceptance Criteria

- REQ-001 behaves as described.

## Lifecycle

Superseded after REQ-003 was introduced as its replacement.
`

/** Same content as `REQ_001_WITH_RESOURCE`, but still `active` (no `Lifecycle` section, `EF-BODY-010`) -- used while REQ-001's Resource is added before supersession. */
const REQ_001_WITH_RESOURCE_ACTIVE = REQ_001_WITH_RESOURCE
	.replace('status: superseded', 'status: active')
	.replace(/\n## Lifecycle\n\nSuperseded after REQ-003 was introduced as its replacement\.\n$/, '')

/**
 * Same content as `REQ_001_WITH_RESOURCE`, but with a valid `superseded-by`
 * relation to REQ-003 -- a THIRD, already-`active` requirement (not REQ-002,
 * which this shared fixture deliberately keeps `draft` forever for its own
 * draft-only-history tests). Eleventh-round review Finding 2: every consumed
 * authoritative commit is now fully snapshot-validated, which includes
 * 05-supersession.md's own single-state invariants -- a `superseded` Artifact
 * with no direct replacement is `EF-SUP-001`, error severity. Twelfth-round
 * review Finding 1: the shared, graph-wide transition core additionally
 * requires the direct replacement to be genuinely `active` AT THIS EXACT
 * TRANSITION (`EF-SUP-004`, 05-supersession.md "atomicity") -- REQ-002 would
 * never satisfy that (it stays `draft` throughout this fixture), so REQ-003
 * is used instead. Used only by the shared 7-commit fixture below; other,
 * isolated fixtures elsewhere in this file that reuse `REQ_001_WITH_RESOURCE`
 * directly are unaffected by this constant.
 */
const REQ_001_SUPERSEDED_WITH_REPLACEMENT = REQ_001_WITH_RESOURCE.replace('relations: []', 'relations:\n  - type: superseded-by\n    target: REQ-003')

describe('computeHistory', () => {
	let tempDir: string
	const oids: Record<string, string> = {}

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-')))
		git(tempDir, ['init', '-q', '-b', 'main'])

		// Commit 1 (root): bootstrap -- PROJECT + control files only.
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(tempDir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
		await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
		oids.commit1 = commitAll(tempDir, 'bootstrap')

		// Commit 2: draft-only creation of REQ-002 (no CHG required for a draft).
		await writeFile(tempDir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'draft'))
		oids.commit2 = commitAll(tempDir, 'draft REQ-002')

		// Commit 3: CHG-001 (completed) introduces REQ-001 -- both files new in
		// this commit. Also introduces REQ-003 (active) in the SAME commit --
		// used only as REQ-001's eventual, genuinely-active supersession
		// replacement at commit6 below (twelfth-round review Finding 1:
		// `EF-SUP-004` requires the direct replacement to be active AT THAT
		// EXACT TRANSITION); REQ-003 itself is never queried by any test in
		// this shared fixture.
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001\n  - type: introduces\n    target: REQ-003'))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
		await writeFile(tempDir, '.engineering/req/REQ-003.md', reqMd('REQ-003', 'active'))
		oids.commit3 = commitAll(tempDir, 'introduce REQ-001 and REQ-003 via CHG-001')

		// Commit 4: draft-only edit to REQ-002 (still draft, no CHG).
		await writeFile(tempDir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'draft')
			.replace('Body text', 'Revised body text'))
		oids.commit4 = commitAll(tempDir, 'edit draft REQ-002')

		// Commit 5: CHG-003 (completed) modifies REQ-001 -- adds its local
		// Resource file while REQ-001 remains `active` (07-change-transactions.md
		// "any content, location, addition, or removal change to a local
		// Resource owned by an active Artifact" is CHG-required). Tenth-round
		// review Finding 5(a): a terminal Artifact's aggregate is byte-frozen,
		// so this Resource addition MUST happen before REQ-001 is superseded
		// below, not after.
		await writeFile(tempDir, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
		await writeFile(tempDir, '.engineering/chg/CHG-003.md', chgMd('CHG-003', 'completed', '  - type: modifies\n    target: REQ-001'))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE_ACTIVE)
		oids.commit5 = commitAll(tempDir, 'add REQ-001 resource via CHG-003')

		// Commit 6: CHG-002 (completed) modifies REQ-001 (active -> superseded).
		// REQ-001 declares a `superseded-by` relation to REQ-002 -- required by
		// 05-supersession.md ("a superseded Artifact has no direct replacement"
		// is `EF-SUP-001`, now enforced by this walk's own full per-commit
		// snapshot validation, eleventh-round review Finding 2).
		await writeFile(tempDir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: modifies\n    target: REQ-001'))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', REQ_001_SUPERSEDED_WITH_REPLACEMENT)
		oids.commit6 = commitAll(tempDir, 'supersede REQ-001 via CHG-002')

		// Commit 7: control-file-only change (PROJECT aggregate), covered by a
		// completing CHG. Tenth-round review Finding 5(b): a PROJECT aggregate
		// change (any `.engineering/ef.yaml`/`.gitignore` change is attributed
		// to PROJECT) with no completing CHG at all is now an exactly-once
		// coverage violation, not a silent no-op.
		await writeFile(tempDir, '.engineering/ef.yaml', `${CONFIG_YAML}\n`)
		await writeFile(tempDir, '.engineering/chg/CHG-004.md', chgMd('CHG-004', 'completed', '  - type: modifies\n    target: PROJECT'))
		oids.commit7 = commitAll(tempDir, 'touch ef.yaml via CHG-004')
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	function gitRepo(root: string = tempDir) {
		return createGitRepository(root, createGitExecutor())
	}

	it('reports engineering effects (introduces then modifies) with correct before/after status and commit_oid', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return

		expect(outcome.effects)
			.toEqual([
				expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'active', commit_oid: oids.commit3 }),
				expect.objectContaining({ effect: 'modifies', status_before: 'active', status_after: 'active', commit_oid: oids.commit5 }),
				expect.objectContaining({ effect: 'modifies', status_before: 'active', status_after: 'superseded', commit_oid: oids.commit6 }),
			])
		expect(outcome.effects[0]!.chg.id)
			.toBe('CHG-001')
		expect(outcome.effects[1]!.chg.id)
			.toBe('CHG-003')
		expect(outcome.effects[2]!.chg.id)
			.toBe('CHG-002')
	})

	it('reports Git commits that change the Artifact aggregate, oldest to newest, with bytewise-sorted changed_paths', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return

		expect(outcome.commits.map(c => c.oid))
			.toEqual([oids.commit3, oids.commit5, oids.commit6])
		expect(outcome.commits[0]!.changed_paths)
			.toEqual(['.engineering/req/REQ-001.md'])
		expect(outcome.commits[1]!.changed_paths)
			.toEqual([
				'.engineering/req/REQ-001.md',
				'.engineering/resources/REQ-001/notes.md',
			])
		expect(outcome.commits[2]!.changed_paths)
			.toEqual(['.engineering/req/REQ-001.md'])
	})

	it('tracks draft-only Git history (no CHG effects) for an Artifact aggregate', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-002', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		expect(outcome.effects)
			.toEqual([])
		expect(outcome.commits.map(c => c.oid))
			.toEqual([oids.commit2, oids.commit4])
	})

	it('includes control files (ef.yaml, .gitignore) in the PROJECT aggregate', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		expect(outcome.commits.map(c => c.oid))
			.toEqual([oids.commit1, oids.commit7])
		expect(outcome.commits[0]!.changed_paths)
			.toEqual([
				'.engineering/.gitignore',
				'.engineering/PROJECT.md',
				'.engineering/ef.yaml',
			])
		expect(outcome.commits[1]!.changed_paths)
			.toEqual(['.engineering/ef.yaml'])
	})

	it('builds the effect summary from the historically-decoded CHG (chgEnvelope/path at this oid), never from a live/current record that has since been edited', async () => {
		// History is defined by authoritative integration first-parent state:
		// the effect summary for CHG-001's completing commit MUST always
		// reflect what CHG-001's frontmatter said AT `oids.commit3` (title
		// 'Title of CHG-001', summary 'Summary of CHG-001.') -- never a
		// `byId` live/current record, even when one is supplied and its
		// content differs (e.g. an uncommitted working-tree edit, or any
		// later edit to CHG-001's title/summary). Using the live record would
		// rewrite the payload of this older historical event.
		const liveChg: SnapshotArtifactRecord = {
			path: '.engineering/chg/CHG-001.md',
			id: 'CHG-001',
			type: 'change',
			status: 'completed',
			relations: [],
			envelope: {
				schema: 'ef/change@1',
				type: 'change',
				id: 'CHG-001',
				title: 'LIVE CURRENT TITLE',
				status: 'completed',
				summary: 'Live summary.',
				tags: [],
				relations: [],
				resources: [],
				extensions: {},
			},
		}
		const byId = new Map([['CHG-001', liveChg]])
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId, INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		expect(outcome.effects[0]!.chg.title)
			.toBe('Title of CHG-001')
		expect(outcome.effects[0]!.chg.summary)
			.toBe('Summary of CHG-001.')
		expect(outcome.effects[0]!.chg.title)
			.not.toBe('LIVE CURRENT TITLE')
	})

	it('returns untrusted-data (never a false empty/partial history) when the current record\'s actual path has a filename mismatch (EF-ID-005) from its canonical path', async () => {
		// `graphTrustworthy` (snapshot-validation.ts) deliberately does NOT gate
		// on EF-ID-005/EF-ID-014 -- REQ-001's declared ID is still unique and
		// correctly decoded, so it reaches history lookup. But `computeHistory`
		// scans the *canonical* path derived from (type, id); if the record's
		// actual authoritative path is misfiled, that canonical path is not
		// where the aggregate's real blob lives, so scanning it anyway could
		// silently return an empty/partial history instead of failing.
		const misfiledRecord: SnapshotArtifactRecord = {
			path: '.engineering/req/wrong-filename.md',
			id: 'REQ-001',
			type: 'requirement',
			status: 'superseded',
			relations: [],
			envelope: {
				schema: 'ef/requirement@1',
				type: 'requirement',
				id: 'REQ-001',
				title: 'Title of REQ-001',
				status: 'superseded',
				summary: 'Summary of REQ-001.',
				tags: [],
				relations: [],
				resources: [],
				extensions: {},
			},
		}
		const byId = new Map([['REQ-001', misfiledRecord]])
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId, INTEGRATION_REF)
		expect(outcome)
			.toEqual({ kind: 'untrusted-data' })
	})

	it('returns untrusted-data (never a false empty/partial history) when the current record\'s actual path is outside its canonical directory (EF-ID-014)', async () => {
		const misfiledRecord: SnapshotArtifactRecord = {
			path: '.engineering/misplaced/REQ-001.md',
			id: 'REQ-001',
			type: 'requirement',
			status: 'superseded',
			relations: [],
			envelope: {
				schema: 'ef/requirement@1',
				type: 'requirement',
				id: 'REQ-001',
				title: 'Title of REQ-001',
				status: 'superseded',
				summary: 'Summary of REQ-001.',
				tags: [],
				relations: [],
				resources: [],
				extensions: {},
			},
		}
		const byId = new Map([['REQ-001', misfiledRecord]])
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId, INTEGRATION_REF)
		expect(outcome)
			.toEqual({ kind: 'untrusted-data' })
	})

	it('returns history-unavailable when the required history cannot be completely materialized (shallow clone)', async () => {
		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-shallow-')))
		try {
			git(shallowDir, ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${tempDir}`, '.'])
			const tipOid = git(shallowDir, ['rev-parse', 'HEAD'])
				.trim()
			const outcome = await computeHistory(gitRepo(shallowDir), tipOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'history-unavailable' })
		}
		finally {
			await fs.rm(shallowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('succeeds for a complete first-parent chain even when the repository also has an unrelated shallow-fetched branch (GitRepository#listFirstParentHistory Finding B parity)', async () => {
		// `git rev-parse --is-shallow-repository` is repository-wide: it is
		// true whenever ANY shallow boundary exists anywhere, even on a branch
		// unrelated to the one being queried. `listFirstParentHistory` used to
		// consult that repo-wide flag *before* even attempting to walk
		// `integrationRefOid`'s own history, so fetching in an unrelated
		// shallow branch made every history query in this repository -- even
		// one whose own history is completely available -- fail with
		// `EF-QRY-010`. This proves `computeHistory` (and therefore the
		// `EF-QRY-010` mapping it relies on) now only reports incomplete when
		// the *queried* history is actually inaccessible, not merely when some
		// unrelated shallow branch happens to exist in the same repository.
		const otherSourceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-other-source-')))
		try {
			git(otherSourceDir, ['init', '-q', '-b', 'main'])
			await writeFile(otherSourceDir, 'a.txt', 'a\n')
			commitAll(otherSourceDir, 'a')
			await writeFile(otherSourceDir, 'b.txt', 'b\n')
			const otherTip = commitAll(otherSourceDir, 'b')

			git(tempDir, ['fetch', '-q', '--depth', '1', `file://${otherSourceDir}`, `main:refs/heads/unrelated-shallow-branch`])
			expect(git(tempDir, ['rev-parse', '--is-shallow-repository'])
				.trim())
				.toBe('true')
			expect(otherTip.length)
				.toBeGreaterThan(0)

			const outcome = await computeHistory(gitRepo(), oids.commit7!, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome.kind)
				.toBe('complete')
			if (outcome.kind !== 'complete')
				return
			expect(outcome.commits.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(otherSourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('returns history-unavailable when a historical commit tree cannot be resolved mid-walk', async () => {
		const real = gitRepo()
		const wrapped = wrapGitRepository(real, {
			readTree: async (oid: string) => {
				if (oid === oids.commit5)
					return { kind: 'missing' }
				return real.readTree(oid)
			},
		})
		const outcome = await computeHistory(wrapped, oids.commit7!, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome)
			.toEqual({ kind: 'history-unavailable' })
	})

	it('fails the query with history-unavailable (does not silently treat the target as absent) when the target Artifact\'s own historical blob cannot be resolved/read', async () => {
		const real = gitRepo()
		const wrapped = wrapGitRepository(real, {
			readTree: async (oid: string) => {
				const result = await real.readTree(oid)
				if (oid !== oids.commit3 || result.kind !== 'resolved')
					return result
				return {
					kind: 'resolved' as const,
					entries: result.entries.map(entry => entry.path === '.engineering/req/REQ-001.md'
						? { ...entry, oid: 'f'.repeat(40) }
						: entry),
				}
			},
		})
		// REQ-001's tree entry at commit3 points at an oid that does not exist in
		// the object database, so `readBlob` fails to resolve it. The blob still
		// EXISTS as a tree entry at this historical commit -- this is an
		// unreadable blob, not a genuine absence -- so the whole query must fail
		// rather than silently falling back as if the target had never existed.
		// Eleventh-round review Finding 2: commit3's COMPLETE tree is now
		// materialized via the same `loadSnapshotFromCommit` pipeline the
		// bootstrap boundary already used, so this unreadable blob fails that
		// materialization outright (an execution/read failure, not a content
		// validity finding) -- `history-unavailable`, consistent with every
		// other blob/tree read failure this module already classifies that way.
		const outcome = await computeHistory(wrapped, oids.commit3!, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome)
			.toEqual({ kind: 'history-unavailable' })
	})

	it('does not report an engineering effect for a non-effect relation (references) alongside an effect relation on the same completed CHG', async () => {
		// Finding 7(c): a completed CHG's declared effect must match the
		// target's own before/after aggregate transition ACROSS THIS COMMIT --
		// so REQ-001's own file is edited alongside CHG-005 in the SAME commit
		// (a genuine `modifies` transition), not left byte-for-byte unchanged.
		// Branches off `oids.commit5` (REQ-001 still `active`) rather than the
		// current `main` tip -- tenth-round review Finding 5(a): REQ-001 is
		// already `superseded` (terminal, byte-frozen) from `oids.commit6`
		// onward, so mutating it any later would itself be untrustworthy
		// regardless of CHG coverage.
		git(tempDir, ['checkout', '-q', oids.commit5!])
		await writeFile(tempDir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE_ACTIVE.replace('Supplementary notes.', 'Supplementary notes, revised.'))
		await writeFile(tempDir, '.engineering/chg/CHG-005.md', chgMd('CHG-005', 'completed', '  - type: modifies\n    target: REQ-001\n  - type: references\n    target: REQ-001'))
		const commitOid = commitAll(tempDir, 'chg-005 mixed relations')

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		const chg5Effects = outcome.effects.filter(e => e.chg.id === 'CHG-005')
		expect(chg5Effects)
			.toEqual([
				expect.objectContaining({ effect: 'modifies', commit_oid: commitOid }),
			])
	})

	it('excludes an external (http/https) Resource location from the tracked Artifact aggregate', async () => {
		const reqWithExternalResource = REQ_001_WITH_RESOURCE_ACTIVE.replace(
			'resources:\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: false\n    description: Supplementary notes.\n',
			'resources:\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: false\n    description: Supplementary notes.\n  - type: reference\n    location: https://example.com/spec\n    role: reference\n    media_type: text/html\n    normative: false\n    description: External spec reference.\n',
		)
		expect(reqWithExternalResource)
			.not.toBe(REQ_001_WITH_RESOURCE_ACTIVE)
		// Branches off `oids.commit5` (REQ-001 still `active`) for the same
		// terminal-freeze reason as above, and declares a covering CHG since
		// tenth-round review Finding 5(b) now requires exactly-once CHG
		// coverage for an active target's own aggregate change.
		git(tempDir, ['checkout', '-q', oids.commit5!])
		await writeFile(tempDir, '.engineering/req/REQ-001.md', reqWithExternalResource)
		await writeFile(tempDir, '.engineering/chg/CHG-006.md', chgMd('CHG-006', 'completed', '  - type: modifies\n    target: REQ-001'))
		const commitOid = commitAll(tempDir, 'add external resource to REQ-001 via CHG-006')

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		const lastCommit = outcome.commits.at(-1)!
		expect(lastCommit.oid)
			.toBe(commitOid)
		expect(lastCommit.changed_paths)
			.toEqual(['.engineering/req/REQ-001.md'])
	})
})

describe('computeHistory: PROJECT control-path availability', () => {
	it('fails with untrusted-data when a required control file (.gitignore) is removed at a later, non-boundary commit, even with a matching completing CHG', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-controls-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			// Finding 5: the bootstrap commit MUST be a genuine, COMPLETE
			// bootstrap -- every required control file already present in
			// canonical form (`.gitignore` included).
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap, full control files')
			await fs.rm(path.join(dir, '.engineering/.gitignore'))
			// Eleventh-round review Finding 2: `.gitignore` is a required
			// control file (11-filesystem-and-config.md) in EVERY authoritative
			// commit, not only at bootstrap -- its absence here is `EF-FS-009`,
			// error severity, in this LATER commit's own complete snapshot
			// validation. A completing CHG declaring `modifies -> PROJECT`
			// covers the aggregate CHANGE (tenth-round review Finding 5(b)'s
			// exactly-once coverage requirement), but can never launder the
			// removal of a required control file into a trustworthy
			// authoritative state.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: PROJECT'))
			const controlRemovedOid = commitAll(dir, 'remove .gitignore via CHG-001')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, controlRemovedOid, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: malformed CHG file mid-history', () => {
	it('fails the query (does not silently skip or report a false effect) when a chg/*.md blob exists at a historical commit but its envelope cannot be decoded', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-stub-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			// A CHG stub whose frontmatter is missing required fields and therefore fails to decode.
			// This blob EXISTS at this historical commit -- it is not absent -- so
			// it must fail the whole query rather than being silently skipped.
			await writeFile(dir, '.engineering/chg/CHG-001.md', '---\nschema: ef/change@1\ntype: change\nid: CHG-001\n---\n\nplaceholder\n')
			commitAll(dir, 'chg stub, undecodable envelope')

			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completedOid = commitAll(dir, 'chg completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completedOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails the query when the chg/*.md blob that would report the completing effect itself has malformed frontmatter', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-malformed-completing-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// The CHG meant to introduce REQ-001 has malformed frontmatter (missing
			// required fields) at the very commit that would otherwise report the
			// completing effect. This must fail the query, not silently report
			// REQ-001 as having no engineering history.
			await writeFile(dir, '.engineering/chg/CHG-001.md', '---\nschema: ef/change@1\ntype: change\nid: CHG-001\nstatus: completed\n---\n\nmalformed, missing required fields\n')
			const malformedCompletingOid = commitAll(dir, 'malformed completing chg')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, malformedCompletingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: bootstrap boundary (11-filesystem-and-config.md)', () => {
	// The bootstrap commit is the first authoritative EF state; its
	// first-parent ancestors MAY be ordinary repository history without EF
	// state. The walk MUST initialize at the first commit whose tree contains
	// `.engineering/ef.yaml` and never decode/scan anything earlier, even when
	// earlier ordinary history happens to contain files at exactly the paths
	// EF would use.

	it('fails with untrusted-data (never treats an invalid commit as authoritative bootstrap) when the first ef.yaml commit also carries a completed CHG and a non-canonical .gitignore', async () => {
		// Eighth-round Finding 5: this regression used to carry a completed
		// CHG-001 into the very commit that first adds `.engineering/ef.yaml`
		// (and used a non-canonical single-line `.gitignore`), yet asserted
		// that this same invalid commit became authoritative bootstrap AND
		// emitted a completed `introduces` effect from it -- exactly the bug
		// this round fixes. Core bootstrap prohibits ANY CHG Artifact
		// (09-validation.md "Bootstrap exception"; EF-VAL-010) and requires
		// every control file in canonical form (EF-FS-009); a first commit
		// that fails these bootstrap STATE rules must be reported as
		// untrusted-data, never silently accepted as the start of complete
		// history.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-preboot-fabricate-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			// Ordinary pre-EF repository history (no `.engineering/ef.yaml`
			// anywhere) that happens to already contain a fully valid-looking
			// Artifact and a completed CHG at exactly the paths EF would use --
			// e.g. leftover content from an experiment, or a template copied in
			// before the project actually adopted EF.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			const preBootstrapOid = commitAll(dir, 'pre-EF experimental content (no ef.yaml)')

			// The commit that first adds `.engineering/ef.yaml` -- and so
			// claims the bootstrap boundary -- carries BOTH pre-existing files
			// forward byte-for-byte UNCHANGED: a completed CHG-001 (prohibited
			// at bootstrap, EF-VAL-010) and a non-canonical single-line
			// `.gitignore` (EF-FS-009). This is not a genuine, complete
			// bootstrap.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(preBootstrapOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the first ef.yaml commit carries a CHG Artifact at bootstrap, even with an otherwise-complete, canonical control-file set', async () => {
		// Isolates the CHG-at-bootstrap condition on its own (canonical
		// `.gitignore`, no other defect) -- the walk must reject this commit
		// as bootstrap purely because a CHG Artifact is present at all
		// (09-validation.md "Bootstrap exception"; EF-VAL-010), independent of
		// the CHG's own status or any other control-file defect.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-at-bootstrap-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'draft', '  - type: introduces\n    target: REQ-001'))
			const bootstrapOid = commitAll(dir, 'bootstrap with a draft CHG already present')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the first ef.yaml commit\'s .gitignore is missing entirely, even though ef.yaml/PROJECT.md are otherwise valid', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-bootstrap-missing-gitignore-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap without .gitignore at all')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the first ef.yaml commit\'s .gitignore content does not exactly match the four canonical entries', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-bootstrap-bad-gitignore-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			// Right four entries, wrong order -- EF-FS-009 requires the exact
			// canonical byte sequence, in order.
			await writeFile(dir, '.engineering/.gitignore', '.lock\n.tmp/\n.generated/\n.cache/\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap with reordered .gitignore entries')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('does not fail an otherwise-valid history query because of unparsable content sitting at the canonical path before bootstrap', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-preboot-garbage-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			// Ordinary pre-EF content at REQ-001's eventual canonical path:
			// no frontmatter at all. Decoding this (if the walk ever reached it)
			// would fail outright (EF-ENV-001) -- exactly the "stricter parsing"
			// this round adds -- so this proves the walk never even attempts it.
			await writeFile(dir, '.engineering/req/REQ-001.md', 'Not an EF-authored file. Unrelated pre-existing content.\n')
			await writeFile(dir, '.engineering/chg/CHG-001.md', 'Also not EF-authored; unrelated pre-existing content.\n')
			const preBootstrapOid = commitAll(dir, 'pre-EF garbage at EF-shaped paths (no ef.yaml)')

			// Bootstrap replaces both with real EF content. Finding 5: the
			// bootstrap commit must be a genuine, COMPLETE bootstrap, so its
			// `.gitignore` is the full canonical four-entry content (not the
			// abbreviated single-line placeholder this fixture used before this
			// round).
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			await fs.rm(path.join(dir, '.engineering/chg/CHG-001.md'))
			const bootstrapOid = commitAll(dir, 'bootstrap replaces pre-EF garbage with real Artifacts')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome.kind)
				.toBe('complete')
			if (outcome.kind !== 'complete')
				return
			expect(outcome.commits.map(c => c.oid))
				.toEqual([bootstrapOid])
			expect(outcome.commits[0]!.changed_paths)
				.toEqual(['.engineering/req/REQ-001.md'])
			expect(outcome.effects)
				.toEqual([])
			expect(preBootstrapOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: envelope trust (document/decoded diagnostics and target identity)', () => {
	it('fails with untrusted-data (does not silently complete) when a completed CHG\'s frontmatter has a duplicate top-level key', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-dup-key-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001's frontmatter declares `status` twice -- `draft`, then
			// `completed` -- a duplicate top-level mapping key (EF-ENV-005,
			// error severity). The YAML parser still resolves a usable-looking
			// envelope from this (keeping the last value, `completed`), so
			// without checking `document.diagnostics` this would silently drive
			// a completed `introduces` effect from data that is not trustworthy.
			await writeFile(dir, '.engineering/chg/CHG-001.md', `---
schema: ef/change@1
type: change
id: CHG-001
title: Title of CHG-001
status: draft
status: completed
summary: Summary of CHG-001.
tags: []
relations:
  - type: introduces
    target: REQ-001
resources: []
---

## Rationale

Rationale text.

## Sources

- Sources text.

## Changes

- Did something.

## Verification

Result: passed

- Verified.
`)
			const completingOid = commitAll(dir, 'chg with duplicate top-level key')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data (does not silently attribute an unrelated envelope\'s history) when the blob at the target\'s canonical path decodes to a different declared id', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-wrong-id-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			// A file sitting at REQ-001's canonical path (`.engineering/req/REQ-001.md`)
			// but whose own declared `id` is a completely different Artifact
			// (`REQ-999`). The blob decodes to a perfectly well-formed envelope,
			// so without an explicit identity check this would be silently
			// treated as REQ-001's own history.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-999', 'active'))
			const oid = commitAll(dir, 'wrong-id envelope at REQ-001 canonical path')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, oid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: relation-entry trust for CHG effects (04-relations.md)', () => {
	it('fails with untrusted-data (does not emit the same effect twice) when a completed CHG declares a duplicate (type, target) relation pair', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-dup-relation-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 declares TWO 'introduces' relations targeting REQ-001 -- a
			// duplicate (type, target) pair (EF-REL-006, error severity).
			// `validateRelationEntries` does NOT exclude a duplicate entry from
			// its returned `entries` (only reports the diagnostic alongside it),
			// so without gating on that diagnostic this completed CHG would
			// silently drive TWO 'introduces' effect entries for the same commit
			// while the query still reported `complete: true`.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001\n  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg with duplicate effect relation')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a completed CHG\'s filename does not match its own declared id (EF-ID-005)', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-wrong-filename-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// The file is committed at `.engineering/chg/CHG-001.md`, but its own
			// declared `id` is `CHG-002` -- a filename/ID mismatch (EF-ID-005).
			// This walk discovers every CHG purely by directory-prefix scan and
			// indexes completion status by declared `id`; without gating on this
			// mismatch, the completing effect would still be silently emitted
			// from an identity fact this walk never verified.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-002', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg with mismatched filename/id')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the target\'s own declared Resource location is not syntactically valid (escapes the project root)', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-bad-resource-location-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// REQ-001 declares a Resource `location` that is neither a valid
			// external HTTP(S) URL nor a syntactically valid local path (it
			// escapes the project root with a '..' segment -- EF-RES-007, error
			// severity). This walk treats every non-external `location` as a
			// literal owned path for aggregate diffing; a location this
			// malformed can never correspond to a genuine tracked path, so it
			// must fail the query rather than silently excluding it from the
			// aggregate while still reporting `complete: true`.
			const reqWithBadResource = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Title of REQ-001
status: active
summary: Summary of REQ-001.
tags: []
relations: []
resources:
  - type: reference
    location: ../escape.md
    role: reference
    media_type: text/markdown
    normative: false
    description: Escapes the project root.
---

## Requirement

Body text for REQ-001.
`
			await writeFile(dir, '.engineering/req/REQ-001.md', reqWithBadResource)
			const commitOid = commitAll(dir, 'req-001 declares an invalid resource location')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: bootstrap boundary never reached (11-filesystem-and-config.md)', () => {
	it('returns history-unavailable (never complete-empty) when the integration ref\'s entire history is pre-EF and never establishes a valid bootstrap', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-no-bootstrap-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, 'README.md', '# Ordinary project\n')
			const rootOid = commitAll(dir, 'ordinary pre-EF history, no ef.yaml ever')
			await writeFile(dir, 'README.md', '# Ordinary project, updated\n')
			const tipOid = commitAll(dir, 'still ordinary, still no ef.yaml')

			// No commit on this ref ever contains `.engineering/ef.yaml`, so no
			// authoritative EF state exists anywhere on the ref: the required
			// history this query needs simply does not exist, which must be
			// reported as `history-unavailable` (EF-QRY-010) -- never the
			// misleadingly ordinary-looking `{ kind: 'complete', effects: [],
			// commits: [] }` a caller could mistake for "no history yet".
			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, tipOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'history-unavailable' })
			expect(rootOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: invalid ef.yaml blob preceding the real bootstrap (11-filesystem-and-config.md, Finding 10)', () => {
	it('fails with untrusted-data (never skips forward to a later valid bootstrap) when the first commit to carry .engineering/ef.yaml is invalid', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-invalid-preboot-config-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			// A stale/invalid `ef.yaml`-shaped blob (missing the required
			// 'schemas' field, EF-FS-001 error). Per the adjudicated
			// bootstrap-boundary design (EF-VAL-009's contract: any historical
			// `ef.yaml` path asserts an EF state), the FIRST commit whose tree
			// contains `.engineering/ef.yaml` AT ALL claims the boundary --
			// the walk must never look past it hoping a later commit is "more
			// valid". Since this claimed boundary's config fails to decode,
			// the whole query must fail as untrusted-data, not silently treat
			// this commit as ordinary pre-EF content and start history at the
			// later, genuinely valid bootstrap instead.
			const invalidConfigYaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
`
			await writeFile(dir, '.engineering/ef.yaml', invalidConfigYaml)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			const preBootstrapOid = commitAll(dir, 'invalid draft ef.yaml, never authoritative')

			// A later commit with a fully valid configuration and PROJECT.md --
			// a genuine bootstrap, but too late: the invalid commit above
			// already claimed the boundary.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'later, otherwise-valid bootstrap')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(preBootstrapOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data (never skips forward) when the first commit with a valid ef.yaml has no PROJECT.md at all', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-no-project-witness-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			// The claimed boundary's `ef.yaml` decodes as a perfectly valid
			// `ef/config@1` configuration, but the tree has no PROJECT.md at
			// all -- failing the minimal bootstrap witness requirement
			// (EF-VAL-009's contract: a decodable config alone does not prove
			// this commit is a genuine bootstrap). This must fail as
			// untrusted-data, never be silently treated as ordinary pre-EF
			// content in favor of the later commit that does add PROJECT.md.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			const noProjectOid = commitAll(dir, 'valid ef.yaml, but no PROJECT.md yet')

			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			const laterOid = commitAll(dir, 'PROJECT.md added later')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, laterOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(noProjectOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('returns history-unavailable (never silently starts late) when the true boundary commit\'s ef.yaml blob transiently fails to read but a later commit\'s ef.yaml reads fine', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-transient-read-failure-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			const trueBoundaryOid = commitAll(dir, 'true bootstrap boundary')
			const trueBoundaryEfYamlOid = git(dir, ['rev-parse', `${trueBoundaryOid}:.engineering/ef.yaml`])
				.trim()

			// A later commit whose ef.yaml content differs (still fully valid),
			// so it has a DIFFERENT blob oid that reads successfully.
			await writeFile(dir, '.engineering/ef.yaml', `${CONFIG_YAML}\n`)
			const laterOid = commitAll(dir, 'later commit, also valid ef.yaml, different blob')

			const repo = createGitRepository(dir, createGitExecutor())
			const wrapped = wrapGitRepository(repo, {
				readBlob: async (oid: string) => {
					// Simulate a transient read failure -- an execution/read
					// error, never a proof of absence or invalidity -- on
					// exactly the TRUE boundary commit's own ef.yaml blob.
					if (oid === trueBoundaryEfYamlOid)
						return { kind: 'error', message: 'simulated transient read failure' }
					return repo.readBlob(oid)
				},
			})

			const outcome = await computeHistory(wrapped, laterOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			// MUST report the required history as unavailable -- MUST NOT
			// silently fall through and treat the later, successfully-read
			// commit as though history started there instead (a silent late
			// start).
			expect(outcome)
				.toEqual({ kind: 'history-unavailable' })
			expect(trueBoundaryEfYamlOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data (never skips forward) when the first commit with ef.yaml is a symlink-mode (120000) blob', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-symlink-ef-yaml-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])

			// `.engineering/ef.yaml` is committed as a Git symlink-mode
			// (`120000`) blob at the claimed boundary. `EF-VAL-009`'s own
			// history-condition probe (`pathExistsInFirstParentHistory`) does
			// not care about mode -- any path existence claims the boundary --
			// but a symlink is not a regular file this walk may trust as the
			// actual configuration content, so this must fail as
			// untrusted-data rather than being silently skipped in favor of
			// the later commit that replaces it with a real, valid bootstrap.
			await fs.mkdir(path.join(dir, '.engineering'), { recursive: true })
			await fs.symlink('nonexistent-target.yaml', path.join(dir, '.engineering', 'ef.yaml'))
			const symlinkBoundaryOid = commitAll(dir, 'ef.yaml is a symlink-mode blob')

			await fs.rm(path.join(dir, '.engineering', 'ef.yaml'))
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			const laterOid = commitAll(dir, 'later, real bootstrap replacing the symlink')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, laterOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(symlinkBoundaryOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: Resource descriptor validation for aggregate attribution (06-resources.md, Finding 11)', () => {
	it('fails with untrusted-data when the target declares a local Resource location beneath ANOTHER Artifact\'s owner directory (EF-RES-014)', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-res-wrong-owner-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// REQ-001 declares a Resource location that is syntactically a
			// perfectly valid local path, but sits beneath ANOTHER Artifact's
			// (REQ-999's) canonical owner directory -- EF-RES-014, error
			// severity. Without running the domain Resource-descriptor
			// validation, this walk would attribute REQ-999's own Resource
			// path OID changes to REQ-001's aggregate.
			const reqWithWrongOwnerResource = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Title of REQ-001
status: active
summary: Summary of REQ-001.
tags: []
relations: []
resources:
  - type: reference
    location: .engineering/resources/REQ-999/notes.md
    role: reference
    media_type: text/markdown
    normative: false
    description: Declared under another Artifact's owner directory.
---

## Requirement

Body text for REQ-001.
`
			await writeFile(dir, '.engineering/req/REQ-001.md', reqWithWrongOwnerResource)
			const commitOid = commitAll(dir, 'req-001 declares a resource under REQ-999\'s owner directory')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the tree entry at a declared local Resource location is a directory, not a regular blob', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-res-non-regular-directory-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// REQ-001 declares its Resource at
			// `.engineering/resources/REQ-001/notes.md`, but the tree entry
			// actually sitting at that exact path is a DIRECTORY (it contains
			// a file inside it), not the ordinary file the descriptor claims.
			// Without a regular-blob check, this directory's tree entry would
			// still be silently compared as though it were the Resource's
			// real content.
			await writeFile(dir, '.engineering/resources/REQ-001/notes.md/inner.txt', 'inner\n')
			await writeFile(dir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE)
			const commitOid = commitAll(dir, 'req-001 resource location is a directory, not a regular file')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the tree entry at a declared local Resource location is a symlink-mode (120000) blob', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-res-non-regular-symlink-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			await fs.mkdir(path.join(dir, '.engineering/resources/REQ-001'), { recursive: true })
			await fs.symlink('nonexistent-target.md', path.join(dir, '.engineering/resources/REQ-001/notes.md'))
			await writeFile(dir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE)
			const commitOid = commitAll(dir, 'req-001 resource location is a symlink-mode blob, not a regular file')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: emitted CHG summary projection-fidelity (10-query-and-trace.md, Finding 12)', () => {
	it('fails with untrusted-data when the completing CHG\'s own effect relation has an invalid extension field (EF-REL-015), even though the (type, target) fact stays valid', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-relation-extension-loss-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001's completing 'introduces' relation targeting REQ-001 --
			// exactly the pair this walk reads and would emit as the effect
			// FACT -- also declares a non-JSON-compatible extension field
			// (`.nan`, a non-finite YAML float, EF-REL-015). The FACT
			// (`introduces`, `REQ-001`) is unaffected by this and would still
			// pass the r5 FACT-trust gate; but `buildArtifactSummary` projects
			// this relation's extensions verbatim into the emitted CHG
			// summary, where a non-finite number would silently serialize to
			// `null` -- so the query must still fail because the EMITTED
			// SUMMARY cannot be represented faithfully.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001\n    x-acme-note: .nan'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg-001 completing relation has an invalid extension field')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the completing CHG declares a malformed Resource entry (EF-RES-001) that would decode to defaults in the emitted summary', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-malformed-resource-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 completes and correctly introduces REQ-001, but its own
			// `resources` array declares an entry missing the required 'role'
			// field (EF-RES-001) -- `domain/resources.ts`'s validation is
			// never otherwise run over a CHG's own Resources, so this would
			// silently decode to an empty-string default in the projected
			// summary instead of being recognized as malformed.
			await writeFile(dir, '.engineering/chg/CHG-001.md', `---
schema: ef/change@1
type: change
id: CHG-001
title: Title of CHG-001
status: completed
summary: Summary of CHG-001.
tags: []
relations:
  - type: introduces
    target: REQ-001
resources:
  - type: reference
    location: .engineering/resources/CHG-001/notes.md
    media_type: text/markdown
    normative: false
    description: Missing the required 'role' field.
---

## Rationale

Rationale text.

## Sources

- Sources text.

## Changes

- Did something.

## Verification

Result: passed

- Verified.
`)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg-001 declares a malformed resource entry')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the completing CHG\'s raw bytes contain invalid UTF-8 in its body', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-invalid-utf8-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 completes and correctly introduces REQ-001, but its raw
			// bytes contain an invalid UTF-8 byte (0xFF, never a valid UTF-8
			// lead byte) inside the Markdown body -- the frontmatter itself
			// decodes cleanly, so `envelopeAt` alone would accept this blob,
			// but the best-effort decode already replaced that byte with
			// U+FFFD, which the emitted CHG summary would silently embed in
			// place of content the file never actually declared.
			const chgText = chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001')
			const bodyMarkerIndex = chgText.indexOf('## Rationale')
			expect(bodyMarkerIndex)
				.toBeGreaterThan(0)
			const chgBytes = Buffer.concat([
				Buffer.from(chgText.slice(0, bodyMarkerIndex), 'utf8'),
				Buffer.from([0xFF]),
				Buffer.from(chgText.slice(bodyMarkerIndex), 'utf8'),
			])
			await fs.mkdir(path.join(dir, '.engineering/chg'), { recursive: true })
			await fs.writeFile(path.join(dir, '.engineering/chg/CHG-001.md'), chgBytes)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg-001 has invalid UTF-8 in its body')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: managed historical entries require a regular Git file mode and a valid UTF-8 path (Finding 10)', () => {
	it('fails with untrusted-data when a symlink-mode (120000) blob sits at the target Artifact\'s own canonical path, even though its blob content decodes as a valid-looking envelope', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-target-symlink-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap')

			// REQ-001's canonical path is committed as a Git symlink-mode
			// (`120000`) blob whose OWN BLOB CONTENT is nonetheless a
			// perfectly valid-looking `ef/requirement@1` envelope.
			// `ls-tree` reports a symlink as `type: 'blob'` exactly like an
			// ordinary file, so `entry.type === 'blob'` alone (the previous
			// implementation) would read and decode this content as REQ-001's
			// own historical envelope instead of failing closed.
			const blobOid = hashObjectFromStdin(dir, Buffer.from(reqMd('REQ-001', 'active')))
			addCacheinfoEntry(dir, '120000', blobOid, '.engineering/req/REQ-001.md')
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, bootstrapOid, 'REQ-001 canonical path is a symlink-mode blob')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a symlink-mode (120000) blob sits at a `.engineering/chg/*.md` path, even though its blob content decodes as a valid-looking completing CHG', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-symlink-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			const bootstrapOid = commitAll(dir, 'bootstrap')

			// CHG-001's canonical path is committed as a symlink-mode blob
			// whose own blob content is a valid-looking, completed CHG that
			// introduces REQ-001. Without a regular Git mode check, this
			// walk would decode it as a genuine completing CHG and emit a
			// fabricated effect for a symlink that was never a real CHG file.
			const chgContent = chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001')
			const blobOid = hashObjectFromStdin(dir, Buffer.from(chgContent))
			addCacheinfoEntry(dir, '120000', blobOid, '.engineering/chg/CHG-001.md')
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, bootstrapOid, 'CHG-001 is a symlink-mode blob')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a tree entry beneath `.engineering/chg/` has an invalid-UTF-8 path -- invisible to the ordinary prefix scan, but still an untrustworthy managed path', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-invalid-path-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			const bootstrapOid = commitAll(dir, 'bootstrap')

			// Raw path bytes: `.engineering/chg/CHG-` + 0xFF + `.md` --
			// genuinely beneath `.engineering/chg/` in raw bytes, but
			// `0xFF` is never a valid UTF-8 lead byte, so `readTree` reports
			// this entry with `pathValid: false` and a synthesized,
			// NUL-prefixed placeholder `path` that can never start with
			// `.engineering/chg/`. The CHG scan's ordinary
			// `path.startsWith('.engineering/chg/')` prefix filter can
			// therefore never see this entry at all -- it must be caught by
			// a separate, byte-level check instead of silently passing
			// through as though this commit's `.engineering` tree were
			// entirely ordinary.
			const blobOid = hashObjectFromStdin(dir, Buffer.from('irrelevant content\n'))
			const invalidPathBytes = Buffer.concat([
				Buffer.from('.engineering/chg/CHG-'),
				Buffer.from([0xFF]),
				Buffer.from('.md'),
			])
			addRawIndexEntry(dir, '100644', blobOid, invalidPathBytes)
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, bootstrapOid, 'invalid UTF-8 path under .engineering/chg/')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: immutable integration_ref (11-filesystem-and-config.md, Finding 11)', () => {
	it('fails with untrusted-data when the walked history\'s bootstrap config declares a DIFFERENT integration_ref than the ref this walk was asked to walk', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-boundary-ref-mismatch-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			// `CONFIG_YAML` declares `integration_ref: refs/heads/main`. Models
			// the working-tree config having been schema-validly edited to
			// declare a DIFFERENT ref (`refs/heads/other`), so `runQueryCommand`
			// resolved `refs/heads/other` and is walking whatever commit that
			// ref currently points to -- here, that commit happens to be (or
			// share) this SAME bootstrap commit, whose own decoded
			// `ef.yaml` still fixes `integration_ref: refs/heads/main`
			// (11-filesystem-and-config.md: "fixed by bootstrap and MUST NOT
			// change within Core v1"). The caller's selected ref
			// (`refs/heads/other`) and the boundary's own declared ref
			// (`refs/heads/main`) disagree, so this history cannot be trusted.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), 'refs/heads/other')
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a LATER authoritative EF-bearing commit edits ef.yaml to declare a different integration_ref than the bootstrap fixed', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-in-history-retarget-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// A LATER authoritative EF-bearing commit edits `ef.yaml` itself
			// (a new blob OID) to declare a DIFFERENT `integration_ref` than
			// the one the bootstrap fixed -- `integration_ref` is fixed by
			// bootstrap and MUST NOT change within Core v1, so this in-history
			// retarget must make the whole query untrustworthy, never be
			// silently accepted as an ordinary later config edit.
			expect(CONFIG_YAML)
				.toContain('refs/heads/main')
			const retargetedConfigYaml = CONFIG_YAML.replace('refs/heads/main', 'refs/heads/other')
			await writeFile(dir, '.engineering/ef.yaml', retargetedConfigYaml)
			const retargetOid = commitAll(dir, 'ef.yaml retargets integration_ref')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, retargetOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: mid-history ef.yaml mode change with an unchanged blob OID (Finding 6)', () => {
	it('fails with untrusted-data when a later commit rewrites ef.yaml from a regular file to a symlink-mode (120000) blob while reusing the identical blob OID', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-efyaml-mode-change-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap')
			const efYamlOid = git(dir, ['rev-parse', `${bootstrapOid}:.engineering/ef.yaml`])
				.trim()

			// Git's tree-entry MODE is stored independently of the blob object
			// it names: this later commit reuses the EXACT SAME
			// `.engineering/ef.yaml` blob OID as the bootstrap commit, only
			// rewriting its tree-entry MODE from the regular `100644` to the
			// forbidden symlink mode `120000`. A per-commit re-check cached on
			// `oid` alone would see no OID change here and wrongly skip
			// re-validating this control path entirely, letting a now-forbidden
			// symlink control file pass through completely unnoticed.
			addCacheinfoEntry(dir, '120000', efYamlOid, '.engineering/ef.yaml')
			const treeOid = writeTreeOid(dir)
			const commitOid = commitTreeOid(dir, treeOid, bootstrapOid, 'ef.yaml mode rewritten to symlink, same blob OID')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: CHG net-effect trust (07-change-transactions.md, Finding 7)', () => {
	it('fails with untrusted-data when one completed CHG declares CONFLICTING effect types (introduces and modifies) for the same target', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-conflicting-effects-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001 declares BOTH `introduces -> REQ-001` AND
			// `modifies -> REQ-001` -- not a duplicate `(type, target)` pair
			// (EF-REL-006 does not catch this), so both entries would
			// otherwise survive and this walk would emit TWO conflicting
			// authoritative effects for the same commit, violating the
			// exactly-once/net-effect contract.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001\n  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg-001 declares conflicting effect types for REQ-001')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a completed CHG has an invalid Verification result marker in its body', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-invalid-verification-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001's frontmatter/envelope is perfectly valid and its
			// relations correctly declare `introduces -> REQ-001`, but its
			// Verification section's result marker ("Result: bogus") is not
			// one of the recognized `passed`/`not-applicable`/`not-completed`
			// forms (EF-BODY-014, error severity) -- `envelopeAt` never checks
			// body content, only the frontmatter envelope, so without an
			// explicit body-schema check this invalid completed-CHG structure
			// would still silently drive a trusted effect.
			await writeFile(dir, '.engineering/chg/CHG-001.md', `---
schema: ef/change@1
type: change
id: CHG-001
title: Title of CHG-001
status: completed
summary: Summary of CHG-001.
tags: []
relations:
  - type: introduces
    target: REQ-001
resources: []
---

## Rationale

Rationale text.

## Sources

- Sources text.

## Changes

- Did something.

## Verification

Result: bogus

- Verified.
`)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'chg-001 has an invalid Verification result marker')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a managed chg/*.md path\'s envelope decodes to a non-change type', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-wrong-type-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// `.engineering/chg/CHG-001.md` is a managed CHG-shaped path, but
			// its envelope decodes to `type: requirement`, not `change` -- a
			// managed-path/type mismatch this walk must fail on, never
			// silently `continue` past as though no CHG existed there.
			await writeFile(dir, '.engineering/chg/CHG-001.md', reqMd('CHG-001', 'active'))
			const commitOid = commitAll(dir, 'chg-shaped path decodes to a non-change type')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a completed CHG claims a "modifies" effect but the target\'s aggregate did not actually change in this commit', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-untrue-effect-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'bootstrap')

			// CHG-001 completes claiming `modifies -> REQ-001`, but REQ-001's
			// own file is left byte-for-byte UNCHANGED in this exact commit --
			// no real absent->present, present->retired, or present->changed
			// transition occurred, so this claimed effect cannot be truthful.
			// A real EF-governed repository's own commit-time transaction
			// validation (`EF-CHG-006`) would already have rejected this; this
			// walk must reject it too, rather than trusting the CHG's bare
			// declaration.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			const completingOid = commitAll(dir, 'chg-001 claims modifies but REQ-001 is unchanged')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: Artifact identity trust across the whole history (Finding 4, 02-identity.md permanent retention)', () => {
	it('fails with untrusted-data when the target ID appears at a non-canonical discovery-scope path before it ever appears at its own canonical path', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-wrong-path-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// REQ-001 first appears at the WRONG canonical directory
			// (`.engineering/prd/`, not `.engineering/req/`) -- still a
			// perfectly well-formed `requirement` envelope declaring `id:
			// REQ-001`, just sitting at a non-canonical Artifact discovery-scope
			// path. `envelopeAt(treeMap, canonicalPath)` alone would see nothing
			// at REQ-001's own canonical path at this commit and treat this as
			// ordinary "not yet created" absence -- silently making this
			// commit's real content invisible to the walk.
			await writeFile(dir, '.engineering/prd/REQ-001.md', reqMd('REQ-001', 'active'))
			const wrongPathOid = commitAll(dir, 'REQ-001 first appears at a non-canonical discovery-scope path')

			// REQ-001 is later "moved" to its own canonical path.
			await fs.rm(path.join(dir, '.engineering/prd/REQ-001.md'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const canonicalOid = commitAll(dir, 'REQ-001 moved to its canonical path')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, canonicalOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(wrongPathOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when an issued target physically disappears and later reappears at its own canonical path', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-delete-readd-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'bootstrap, REQ-001 present from the start')

			// REQ-001 is physically deleted -- 02-identity.md forbids this for
			// an issued ID ("its Artifact MUST remain in the authoritative
			// files ... rather than be physically deleted"). Without this
			// fix, `previousEnvelope` would simply reset to `undefined` here.
			await fs.rm(path.join(dir, '.engineering/req/REQ-001.md'))
			const deletedOid = commitAll(dir, 'REQ-001 physically deleted')

			// REQ-001 reappears at its own canonical path. Without this fix, this
			// would be silently accepted as a fresh `absent -> present` creation.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const reappearOid = commitAll(dir, 'REQ-001 reappears at its canonical path')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, reappearOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(deletedOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: CHG historical lifecycle/retention (Finding 5, 03-lifecycle.md ALLOWED_TRANSITIONS)', () => {
	it('fails with untrusted-data when a CHG regresses from a terminal `retired` status back to `completed`', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-retired-to-completed-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 first appears already `retired` (a legitimate first
			// appearance -- Core permits a CHG to be abandoned without ever
			// completing). This is a terminal status.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'retired', '  - type: modifies\n    target: REQ-001'))
			commitAll(dir, 'CHG-001 first appears retired')

			// CHG-001 later flips to `completed` and declares a qualifying
			// effect -- `retired -> completed` is not in `ALLOWED_TRANSITIONS`
			// for `change` (only `draft -> completed` and `draft -> retired`
			// exist), and a terminal status must never regress. Checking only
			// the IMMEDIATELY PREVIOUS status (as before this fix) would see
			// `wasCompleted === false` here and wrongly treat this as a fresh,
			// trustworthy completion.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const regressedOid = commitAll(dir, 'CHG-001 illegally regresses retired -> completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, regressedOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a completed CHG is physically deleted and later reappears completed again', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-completed-delete-reappear-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001 completes, genuinely introducing REQ-001 (absent -> present:
			// REQ-001 does not exist anywhere before this commit).
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'CHG-001 completes, introduces REQ-001')

			// CHG-001 is physically deleted -- an issued, terminal CHG can never
			// disappear (02-identity.md).
			await fs.rm(path.join(dir, '.engineering/chg/CHG-001.md'))
			const deletedOid = commitAll(dir, 'CHG-001 physically deleted after completing')

			// CHG-001 reappears, again `completed`, declaring another effect.
			// Checking only the immediately previous commit (as before this
			// fix) would see no prior status at all here (the disappearance
			// having erased it from tracking) and wrongly accept this as a
			// fresh completion.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active')
				.replace('Body text', 'Revised body text'))
			const reappearOid = commitAll(dir, 'CHG-001 reappears completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, reappearOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(deletedOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: relation compatibility matrix applied to the historical target type (Finding 6, 04-relations.md RELATION_COMPATIBILITY)', () => {
	it('fails with untrusted-data when a completing CHG declares a `modifies` effect targeting another CHG (a CHG cannot effect a CHG)', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-effects-chg-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			const chg002Draft = `---
schema: ef/change@1
type: change
id: CHG-002
title: Title of CHG-002
status: draft
summary: Summary of CHG-002.
tags: []
relations: []
resources: []
---

## Rationale

Rationale text.
`
			await writeFile(dir, '.engineering/chg/CHG-002.md', chg002Draft)
			commitAll(dir, 'CHG-002 created (draft)')

			// CHG-002's own content changes in the SAME commit as CHG-001's
			// completion, so CHG-002's aggregate genuinely transitioned
			// (`actualEffect` would otherwise classify this as a truthful
			// `modifies`). CHG-001 completes declaring `modifies -> CHG-002` --
			// forbidden by `RELATION_COMPATIBILITY['modifies'].targets` (never
			// includes `change`: a CHG cannot effect another CHG). Without the
			// compatibility check, this would pass the existing `actualEffect`
			// truth check and be emitted as an impossible completed effect for
			// CHG-002's own history.
			await writeFile(dir, '.engineering/chg/CHG-002.md', chg002Draft.replace('Rationale text.', 'Revised rationale text.'))
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: CHG-002'))
			const completingOid = commitAll(dir, 'CHG-001 completes, illegally declaring modifies -> CHG-002')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'CHG-002', 'change', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: genuine transition required for a `retires` effect (Finding 7, 07-change-transactions.md)', () => {
	it('fails with untrusted-data when a completing CHG declares `retires` against a target that is already terminal (retired) and byte-identical', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-retires-already-retired-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// REQ-001 is created POST-bootstrap already `retired` -- unlike the
			// bootstrap boundary itself (which forbids any terminal knowledge
			// Artifact, EF-VAL-010), a later commit has no such restriction, so
			// this is a legitimate way for the target to already be terminal
			// before the completing commit below.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'retired'))
			commitAll(dir, 'REQ-001 created already retired')

			// REQ-001's own file is left BYTE-FOR-BYTE UNCHANGED -- no genuine
			// transition into `retired` occurs in this commit (it already WAS
			// retired) -- while CHG-001 newly completes declaring
			// `retires -> REQ-001`. `currentEnvelope.status === 'retired'`
			// alone (the previous implementation) would still match, ignoring
			// that `previousEnvelope.status` was ALREADY `retired`.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: retires\n    target: REQ-001'))
			const completingOid = commitAll(dir, 'chg-001 completes claiming retires against an already-retired, unchanged target')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: exactly-once target claim across the whole commit (Finding 8, EF-CHG-007)', () => {
	it('fails with untrusted-data when two different CHGs both newly complete in the same commit and both claim the same target', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-two-chgs-same-target-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 and CHG-002 BOTH newly complete in this SAME commit, and
			// BOTH declare a qualifying `modifies -> REQ-001` effect. Checked
			// only within one CHG at a time (as before this fix), each
			// independently sees a truthful `actualEffect` (REQ-001 genuinely
			// transitions `draft -> active` in this commit) and both would be
			// pushed -- violating the exactly-once rule (EF-CHG-007): multiple
			// CHGs completing at the same integration boundary cannot claim the
			// same target.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completingOid = commitAll(dir, 'CHG-001 and CHG-002 both complete claiming REQ-001')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: canonical-layout-violating entries hide unparsed Artifacts (tenth-round review Finding 3, EF-FS-003)', () => {
	it('fails with untrusted-data when the target first appears at an unexpected discovery-scope path (EF-FS-003) before it ever appears at its own canonical path', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-fs003-nested-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// REQ-001 first appears at `.engineering/other/REQ-001.md` -- an
			// entry `listArtifactFiles` reports as `EF-FS-003` (an unexpected
			// top-level directory, never a canonical Artifact directory,
			// control file, or managed root) rather than including in its own
			// `artifactFiles` candidate set. Before this fix, this walk's
			// candidate-path scan (`artifactDiscoveryPaths`) only ever looked at
			// `artifactFiles` and silently never decoded this entry at all --
			// `targetEverAppeared` stayed `false` through this commit.
			await writeFile(dir, '.engineering/other/REQ-001.md', reqMd('REQ-001', 'active'))
			const wrongPathOid = commitAll(dir, 'REQ-001 first appears at an EF-FS-003-violating path')

			// REQ-001 is later "moved" to its own canonical path.
			await fs.rm(path.join(dir, '.engineering/other/REQ-001.md'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const canonicalOid = commitAll(dir, 'REQ-001 moved to its canonical path')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, canonicalOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(wrongPathOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: declared local Resource file existence (tenth-round review Finding 4, 06-resources.md EF-RES-006)', () => {
	it('fails with untrusted-data when a declared local Resource location never resolves to a file at all', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-res006-missing-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001 introduces REQ-001, which declares a local Resource
			// location -- but the file itself is never written anywhere in this
			// commit's tree. Before this fix, an absent tree entry at a declared
			// location was treated exactly like ordinary "not created yet"
			// absence, so this commit still reported `complete: true`.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE_ACTIVE)
			const completingOid = commitAll(dir, 'CHG-001 introduces REQ-001 declaring a Resource whose file does not exist')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a declared local Resource file is removed while its descriptor remains', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-res006-removed-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001 introduces REQ-001 with its Resource file genuinely
			// present.
			await writeFile(dir, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE_ACTIVE)
			commitAll(dir, 'CHG-001 introduces REQ-001 with its Resource file present')

			// The Resource FILE is removed while REQ-001's own descriptor still
			// declares it -- covered by a completing CHG (so the exactly-once
			// coverage check this round's Finding 5(b) added is satisfied and
			// cannot itself explain a failure here). Before this fix, the
			// now-absent tree entry at this declared location was silently
			// treated as ordinary "not created yet" absence.
			await fs.rm(path.join(dir, '.engineering/resources/REQ-001/notes.md'))
			await writeFile(dir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: modifies\n    target: REQ-001'))
			const removedOid = commitAll(dir, 'CHG-002 removes REQ-001\'s Resource file while its descriptor remains')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, removedOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: terminal freeze and exactly-once CHG coverage for the target aggregate (tenth-round review Finding 5, 07-change-transactions.md)', () => {
	it('fails with untrusted-data when an already-terminal target\'s content changes while its status stays terminal, even when a completing CHG claims the mutation', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-terminal-freeze-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'CHG-001 introduces REQ-001')

			await writeFile(dir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'superseded'))
			commitAll(dir, 'CHG-002 supersedes REQ-001')

			// REQ-001's OWN status stays `superseded` (terminal) in this commit,
			// yet its body content changes, and CHG-003 newly completes claiming
			// `modifies -> REQ-001`. A terminal Artifact's aggregate is
			// byte-frozen regardless of what any CHG claims -- before this fix,
			// `targetContentChanged` fell through to a truthful-looking
			// `modifies` classification and this commit was accepted.
			await writeFile(dir, '.engineering/chg/CHG-003.md', chgMd('CHG-003', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'superseded')
				.replace('Body text', 'Illegally revised body text'))
			const frozenMutationOid = commitAll(dir, 'CHG-003 illegally mutates already-superseded REQ-001')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, frozenMutationOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when an active target\'s aggregate changes in a commit with no completing CHG claiming it at all', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-active-no-chg-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'CHG-001 introduces REQ-001')

			// REQ-001's own file changes in this commit -- a genuine aggregate
			// mutation of an ACTIVE Artifact, which 07-change-transactions.md's
			// "CHG-required mutations" makes mandatory ("any content change to
			// an active Artifact file") -- yet no CHG completes here at all.
			// Before this fix, the Git commit was still recorded
			// (`commits.push`) and this query still reported `complete: true`
			// with no engineering effect explaining the change.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active')
				.replace('Body text', 'Uncovered revised body text'))
			const uncoveredOid = commitAll(dir, 'REQ-001 mutated with no completing CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, uncoveredOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when the PROJECT aggregate changes in a commit with no completing CHG claiming it at all', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-project-no-chg-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// `.engineering/ef.yaml` changes post-bootstrap -- attributed to the
			// PROJECT aggregate (07-change-transactions.md) -- with no
			// completing CHG at all. Before this fix, PROJECT's own aggregate
			// changes were never checked for CHG coverage.
			await writeFile(dir, '.engineering/ef.yaml', `${CONFIG_YAML}\n`)
			const uncoveredOid = commitAll(dir, 'ef.yaml touched with no completing CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, uncoveredOid, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: CHG identity permanence and terminal-aggregate freeze (tenth-round review Finding 6, 02-identity.md)', () => {
	it('fails with untrusted-data when a draft CHG disappears and later reappears completed', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-draft-absent-completed-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			commitAll(dir, 'bootstrap')

			// CHG-001 first appears `draft` -- not a terminal status.
			await writeFile(dir, '.engineering/chg/CHG-001.md', `---
schema: ef/change@1
type: change
id: CHG-001
title: Title of CHG-001
status: draft
summary: Summary of CHG-001.
tags: []
relations: []
resources: []
---

## Rationale

Rationale text.
`)
			commitAll(dir, 'CHG-001 first appears draft')

			// CHG-001 is physically deleted. Before this fix, disappearance was
			// only ever checked for a PREVIOUSLY TERMINAL id -- a draft CHG's
			// disappearance was silently ignored.
			await fs.rm(path.join(dir, '.engineering/chg/CHG-001.md'))
			const deletedOid = commitAll(dir, 'CHG-001 physically deleted while still draft')

			// CHG-001 reappears, now completed, declaring a qualifying effect.
			// Before this fix, `chgLifecycleStatus` had forgotten CHG-001
			// entirely, so this looked like a fresh, legitimate `draft ->
			// completed` first-time completion.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const reappearOid = commitAll(dir, 'CHG-001 reappears completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, reappearOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
			expect(deletedOid.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a completed CHG\'s own content changes while it remains completed', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-completed-same-status-mutation-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap')

			// CHG-001 completes, genuinely introducing REQ-001.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'CHG-001 completes, introduces REQ-001')

			// CHG-001's own title changes in a LATER commit while its status
			// stays `completed` -- a completed CHG's "frontmatter, body, and
			// owned Resources are frozen after integration"
			// (07-change-transactions.md). `chgLifecycleStatus` alone only
			// tracks status: a same-status recurrence would previously never
			// be re-examined at all once past its first completion.
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001', 'Illegally revised title of CHG-001'))
			const mutatedOid = commitAll(dir, 'CHG-001 illegally mutated while remaining completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, mutatedOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: eleventh-round review Finding 2 (post-bootstrap authoritative state must be fully snapshot-validated)', () => {
	it('fails with untrusted-data when a later commit rewrites the target\'s body to remove a required heading, even though a matching completing CHG covers the mutation', async () => {
		// Finding 2: `evaluateBootstrapBoundary` already runs COMPLETE snapshot
		// validation at the bootstrap commit, but every LATER authoritative
		// commit this walk consumes was only ever checked through a
		// hand-maintained subset of probes (frontmatter/status/resources) that
		// never re-validated the target's own BODY. REQ-001's body loses its
		// required 'Rationale' heading here -- a plain `EF-BODY` structural
		// violation -- while its OID still changes (so `actualEffect` becomes
		// `modifies`) and an otherwise-valid completing CHG claims exactly that
		// mutation. Before this fix, nothing in the per-commit walk ever
		// re-validated the target's body, so this commit's illegal content was
		// silently accepted as trustworthy.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-invalid-target-body-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'bootstrap, REQ-001 active from the start')

			const bodyMissingRationale = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Title of REQ-001
status: active
summary: Summary of REQ-001.
tags: []
relations: []
resources: []
---

## Requirement

Revised body text for REQ-001, missing its required Rationale heading.

## Acceptance Criteria

- REQ-001 behaves as described.
`
			await writeFile(dir, '.engineering/req/REQ-001.md', bodyMissingRationale)
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			const mutatedOid = commitAll(dir, 'REQ-001 body loses its required Rationale heading, covered by a completing CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, mutatedOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a later commit corrupts the PROJECT control file (.gitignore), even though a matching completing CHG covers the mutation', async () => {
		// Finding 2's PROJECT-shaped variant: PROJECT's own aggregate
		// (07-change-transactions.md) includes its control files. A later
		// commit rewrites `.engineering/.gitignore` to content that no longer
		// exactly matches the four canonical entries this specification
		// requires (`EF-FS-009`) -- the walk's own OID-diffing sees PROJECT's
		// aggregate change and a completing CHG claims it, but nothing ever
		// re-validated the CONTENT of that changed control file.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-invalid-control-file-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap, canonical control files')

			// Corrupted: entries out of the canonical order/set.
			await writeFile(dir, '.engineering/.gitignore', '.tmp/\n.cache/\n.generated/\n.lock\n')
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: PROJECT'))
			const corruptedOid = commitAll(dir, 'corrupt .gitignore, covered by a completing CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, corruptedOid, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: eleventh-round review Finding 3 (lifecycle-transition legality and first-appearance rules before net-effect classification)', () => {
	it('fails with untrusted-data when the target illegally transitions active -> draft, even though a matching completing CHG covers the mutation', async () => {
		// 03-lifecycle.md `ALLOWED_TRANSITIONS.requirement` permits `active ->
		// superseded` and `active -> retired`, never `active -> draft`. Before
		// this fix, the walk only ever classified the target's before/after
		// aggregate transition into `introduces`/`modifies`/`retires`/
		// `unchanged` and checked CHG coverage/truthfulness against THAT
		// classification -- it never independently verified the underlying
		// status EDGE itself was legal, so an illegal downgrade covered by an
		// otherwise-valid completing `modifies` CHG was silently accepted.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-active-to-draft-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			commitAll(dir, 'bootstrap, REQ-001 active from the start')

			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft')
				.replace('Body text', 'Illegally downgraded body text'))
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001'))
			const illegalOid = commitAll(dir, 'REQ-001 illegally regresses active -> draft, covered by a completing CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, illegalOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when a knowledge Artifact first appears directly terminal (retired), even with a matching completing "introduces" CHG', async () => {
		// 03-lifecycle.md "First authoritative appearance": a knowledge
		// Artifact may first appear only `draft` or `active`, never
		// `superseded`/`retired` -- regardless of whether a completing CHG
		// exists. Before this fix, `requiresChgForTarget(undefined, 'retired')`
		// demanded CHG coverage (since `after !== 'draft'`), and a matching
		// `introduces` CHG satisfied that coverage, so this illegal first
		// appearance was silently accepted as trustworthy history.
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-first-appearance-terminal-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap, no REQ-001 yet')

			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'retired'))
			const firstAppearanceOid = commitAll(dir, 'REQ-001 first appears already retired, covered by a completing "introduces" CHG')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, firstAppearanceOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})

describe('computeHistory: twelfth-round review Finding 1 (graph-wide transition semantics, not a target-scoped subset)', () => {
	// A target-scoped history walk only narrows every completed CHG's declared
	// effect, lifecycle edge, and coverage to the ONE queried target. The real
	// commit-time transaction validator (`transition-validation.ts`) instead
	// proves CHG truthfulness/coverage for EVERY target, supersession
	// atomicity, and lifecycle legality across the WHOLE graph in the same
	// commit. These three tests prove `computeHistory` now reuses that SAME
	// shared, graph-wide `evaluateTransitionBoundary` core over every
	// post-bootstrap boundary it consumes, rather than a narrower per-target
	// subset of the same checks.

	it('fails with untrusted-data when the queried target\'s own completing CHG effect is truthful, but the SAME transaction ALSO falsely declares a "retires" effect on an unrelated, byte-identical target', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-f1-false-retire-unrelated-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			await writeFile(dir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'active'))
			commitAll(dir, 'bootstrap, REQ-001 and REQ-002 both active')

			// CHG-001 completes declaring BOTH a truthful `modifies -> REQ-001`
			// (REQ-001's own body genuinely changes) AND a false
			// `retires -> REQ-002` -- REQ-002's own file is left
			// byte-for-byte UNCHANGED, so it was never genuinely retired
			// (still `active`, identical bytes). A target-scoped walk querying
			// REQ-001 only ever narrows to REQ-001's own relation/lifecycle
			// edge, sees a truthful `modifies`, and would report `complete`.
			// The real transaction validator rejects this whole commit
			// (EF-CHG-006: an effect declared on an unchanged target) -- this
			// walk must reuse that SAME graph-wide semantics.
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active')
				.replace('Body text', 'Revised body text'))
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: modifies\n    target: REQ-001\n  - type: retires\n    target: REQ-002'))
			const untrustworthyOid = commitAll(dir, 'CHG-001 truthfully modifies REQ-001 but falsely claims retires on unchanged REQ-002')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, untrustworthyOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('fails with untrusted-data when an UNRELATED active target mutates with no completing CHG at all, even though the queried target is byte-for-byte untouched in the same commit', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-f1-unrelated-uncovered-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			await writeFile(dir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'active'))
			commitAll(dir, 'bootstrap, REQ-001 and REQ-002 both active')

			// REQ-002 -- entirely unrelated to the REQ-001 query -- mutates its
			// own body with NO completing CHG anywhere in this commit; REQ-001
			// itself is left byte-for-byte untouched. A target-scoped walk
			// querying REQ-001 never examines REQ-002's own coverage at all,
			// so it would see no change to REQ-001's aggregate and report
			// `complete`. The real transaction validator rejects this whole
			// commit (EF-CHG-005: a changed, CHG-required target -- REQ-002 --
			// with no completing CHG effect) -- this walk must reuse that SAME
			// graph-wide semantics, even for a target the query never asked
			// about.
			await writeFile(dir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'active')
				.replace('Body text', 'Uncovered revised body text'))
			const uncoveredOid = commitAll(dir, 'REQ-002 mutated with no completing CHG at all; REQ-001 untouched')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, uncoveredOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})

	it('remains complete:true (over-blocking guard) for a clean multi-commit history where a DIFFERENT target has its own, independently valid CHG-covered lifecycle in the same walk', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-f1-clean-multi-target-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n.lock\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			commitAll(dir, 'bootstrap, no requirements yet')

			// CHG-001 completes, legitimately introducing REQ-001 (absent ->
			// present, fresh in this SAME commit).
			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const introduceReq001Oid = commitAll(dir, 'CHG-001 introduces REQ-001')

			// A LATER, separate commit: CHG-002 completes, legitimately
			// introducing REQ-002 (also absent -> present, fresh in this
			// commit) -- REQ-001 untouched. The pure graph-wide core runs
			// over EVERY adjacent boundary, including this one, whose only
			// change belongs to REQ-002; it must not spuriously reject
			// REQ-001's own already-complete, valid history.
			await writeFile(dir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: introduces\n    target: REQ-002'))
			await writeFile(dir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'active'))
			commitAll(dir, 'CHG-002 introduces REQ-002, independently of REQ-001')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, introduceReq001Oid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome.kind)
				.toBe('complete')
			if (outcome.kind !== 'complete')
				return
			expect(outcome.effects)
				.toEqual([
					expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'active', commit_oid: introduceReq001Oid }),
				])

			// Querying past BOTH commits (REQ-001 untouched by the second) must
			// still report REQ-001's own history as complete and unaffected.
			const laterTipOid = git(dir, ['rev-parse', 'HEAD'])
				.trim()
			const laterOutcome = await computeHistory(repo, laterTipOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(laterOutcome.kind)
				.toBe('complete')
			if (laterOutcome.kind !== 'complete')
				return
			expect(laterOutcome.effects)
				.toEqual([
					expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'active', commit_oid: introduceReq001Oid }),
				])
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		}
	})
})
