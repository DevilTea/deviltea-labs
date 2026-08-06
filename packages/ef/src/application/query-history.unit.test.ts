import type { GitRepository } from '../git/repository'
import type { SnapshotArtifactRecord } from './snapshot-validation'
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', new Map())
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', new Map())
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-002', 'requirement', new Map())
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'PROJECT', 'project', new Map())
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId)
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId)
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
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', byId)
		expect(outcome)
			.toEqual({ kind: 'untrusted-data' })
	})

	it('returns history-unavailable when the required history cannot be completely materialized (shallow clone)', async () => {
		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-shallow-')))
		try {
			git(shallowDir, ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${tempDir}`, '.'])
			const tipOid = git(shallowDir, ['rev-parse', 'HEAD'])
				.trim()
			const outcome = await computeHistory(gitRepo(shallowDir), tipOid, 'REQ-001', 'requirement', new Map())
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

			const outcome = await computeHistory(gitRepo(), oids.commit7!, 'PROJECT', 'project', new Map())
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
		const outcome = await computeHistory(wrapped, oids.commit7!, 'REQ-001', 'requirement', new Map())
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
		const outcome = await computeHistory(wrapped, oids.commit3!, 'REQ-001', 'requirement', new Map())
		expect(outcome)
			.toEqual({ kind: 'untrusted-data' })
	})

	it('does not report an engineering effect for a non-effect relation (references) alongside an effect relation on the same completed CHG', async () => {
		await writeFile(tempDir, '.engineering/chg/CHG-003.md', chgMd('CHG-003', 'completed', '  - type: modifies\n    target: REQ-001\n  - type: references\n    target: REQ-001'))
		const commitOid = commitAll(tempDir, 'chg-003 mixed relations')

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map())
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

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, withControlsOid, 'PROJECT', 'project', new Map())
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
			const outcome = await computeHistory(repo, completedOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, malformedCompletingOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, bootstrapOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, completingOid, 'REQ-001', 'requirement', new Map())
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
			const outcome = await computeHistory(repo, oid, 'REQ-001', 'requirement', new Map())
			expect(outcome)
				.toEqual({ kind: 'untrusted-data' })
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
