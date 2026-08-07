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
	return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
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
`

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

Sources text.

## Changes

- Did something.

## Verification

Result: passed

- Verified.
`
}

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
`

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

		// Commit 3: CHG-001 (completed) introduces REQ-001 -- both files new in this commit.
		await writeFile(tempDir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
		oids.commit3 = commitAll(tempDir, 'introduce REQ-001 via CHG-001')

		// Commit 4: draft-only edit to REQ-002 (still draft, no CHG).
		await writeFile(tempDir, '.engineering/req/REQ-002.md', reqMd('REQ-002', 'draft')
			.replace('Body text', 'Revised body text'))
		oids.commit4 = commitAll(tempDir, 'edit draft REQ-002')

		// Commit 5: CHG-002 (completed) modifies REQ-001 (active -> superseded).
		await writeFile(tempDir, '.engineering/chg/CHG-002.md', chgMd('CHG-002', 'completed', '  - type: modifies\n    target: REQ-001'))
		await writeFile(tempDir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'superseded'))
		oids.commit5 = commitAll(tempDir, 'supersede REQ-001 via CHG-002')

		// Commit 6: add REQ-001's local Resource file and declare it.
		await writeFile(tempDir, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
		await writeFile(tempDir, '.engineering/req/REQ-001.md', REQ_001_WITH_RESOURCE)
		oids.commit6 = commitAll(tempDir, 'add REQ-001 resource')

		// Commit 7: control-file-only change (PROJECT aggregate).
		await writeFile(tempDir, '.engineering/ef.yaml', `${CONFIG_YAML}\n`)
		oids.commit7 = commitAll(tempDir, 'touch ef.yaml')
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
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
				expect.objectContaining({ effect: 'modifies', status_before: 'active', status_after: 'superseded', commit_oid: oids.commit5 }),
			])
		expect(outcome.effects[0]!.chg.id)
			.toBe('CHG-001')
		expect(outcome.effects[1]!.chg.id)
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
		expect(outcome.commits[2]!.changed_paths)
			.toEqual([
				'.engineering/req/REQ-001.md',
				'.engineering/resources/REQ-001/notes.md',
			])
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
			await fs.rm(shallowDir, { recursive: true, force: true })
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
			await fs.rm(otherSourceDir, { recursive: true, force: true })
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

	it('fails the query with untrusted-data (does not silently treat the target as absent) when the target Artifact\'s own historical blob cannot be resolved/read', async () => {
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
		const outcome = await computeHistory(wrapped, oids.commit3!, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome)
			.toEqual({ kind: 'untrusted-data' })
	})

	it('does not report an engineering effect for a non-effect relation (references) alongside an effect relation on the same completed CHG', async () => {
		await writeFile(tempDir, '.engineering/chg/CHG-003.md', chgMd('CHG-003', 'completed', '  - type: modifies\n    target: REQ-001\n  - type: references\n    target: REQ-001'))
		const commitOid = commitAll(tempDir, 'chg-003 mixed relations')

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
		expect(outcome.kind)
			.toBe('complete')
		if (outcome.kind !== 'complete')
			return
		const chg3Effects = outcome.effects.filter(e => e.chg.id === 'CHG-003')
		expect(chg3Effects)
			.toEqual([
				expect.objectContaining({ effect: 'modifies', commit_oid: commitOid }),
			])
	})

	it('excludes an external (http/https) Resource location from the tracked Artifact aggregate', async () => {
		const reqWithExternalResource = REQ_001_WITH_RESOURCE.replace(
			'resources:\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: false\n    description: Supplementary notes.\n',
			'resources:\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: false\n    description: Supplementary notes.\n  - type: reference\n    location: https://example.com/spec\n    role: reference\n    media_type: text/html\n    normative: false\n    description: External spec reference.\n',
		)
		expect(reqWithExternalResource)
			.not.toBe(REQ_001_WITH_RESOURCE)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', reqWithExternalResource)
		const commitOid = commitAll(tempDir, 'add external resource to REQ-001')

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
	it('omits a control file from the PROJECT aggregate at a commit predating its creation', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-controls-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			// The bootstrap commit MUST carry `.engineering/ef.yaml` -- it is the
			// first authoritative EF state -- but `.gitignore` need not exist yet;
			// this still exercises `ownedPathsOf` correctly omitting a control
			// path that is genuinely absent from a given historical commit's tree.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap, no .gitignore yet')
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			const withControlsOid = commitAll(dir, 'add .gitignore')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, withControlsOid, 'PROJECT', 'project', new Map(), INTEGRATION_REF)
			expect(outcome.kind)
				.toBe('complete')
			if (outcome.kind !== 'complete')
				return
			expect(outcome.commits.map(c => c.oid))
				.toEqual([bootstrapOid, withControlsOid])
			expect(outcome.commits[0]!.changed_paths)
				.toEqual([
					'.engineering/PROJECT.md',
					'.engineering/ef.yaml',
				])
			expect(outcome.commits[1]!.changed_paths)
				.toEqual(['.engineering/.gitignore'])
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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

	it('does not fabricate a commit or effect from ordinary pre-bootstrap history containing Artifact/CHG-shaped files at EF paths', async () => {
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

			// Bootstrap: establishes the first authoritative EF state. Both
			// pre-existing files are left byte-for-byte unchanged -- only the
			// project's control files and PROJECT.md are newly added.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'bootstrap')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map(), INTEGRATION_REF)
			expect(outcome.kind)
				.toBe('complete')
			if (outcome.kind !== 'complete')
				return

			// The pre-bootstrap commit must never appear anywhere in the result.
			expect(outcome.commits.map(c => c.oid))
				.not.toContain(preBootstrapOid)
			expect(outcome.effects.map(e => e.commit_oid))
				.not.toContain(preBootstrapOid)

			// REQ-001's first appearance in *authoritative* history is bootstrap
			// itself (not the earlier ordinary commit), and CHG-001's completed
			// `introduces` effect is attributed to bootstrap, not fabricated at
			// the pre-EF commit.
			expect(outcome.commits.map(c => c.oid))
				.toEqual([bootstrapOid])
			expect(outcome.commits[0]!.changed_paths)
				.toEqual(['.engineering/req/REQ-001.md'])
			expect(outcome.effects)
				.toEqual([
					expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'active', commit_oid: bootstrapOid }),
				])
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true })
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

			// Bootstrap replaces both with real EF content.
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
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
			await fs.rm(dir, { recursive: true, force: true })
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

Sources text.

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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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

Sources text.

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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
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
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
