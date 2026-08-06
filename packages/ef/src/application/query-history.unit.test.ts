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
import { buildArtifactSummary } from './query-projection'

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
		expect(outcome)
			.toBeDefined()

		expect(outcome!.effects)
			.toEqual([
				expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'active', commit_oid: oids.commit3 }),
				expect.objectContaining({ effect: 'modifies', status_before: 'active', status_after: 'superseded', commit_oid: oids.commit5 }),
			])
		expect(outcome!.effects[0]!.chg.id)
			.toBe('CHG-001')
		expect(outcome!.effects[1]!.chg.id)
			.toBe('CHG-002')
	})

	it('reports Git commits that change the Artifact aggregate, oldest to newest, with bytewise-sorted changed_paths', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-001', 'requirement', new Map())
		expect(outcome)
			.toBeDefined()

		expect(outcome!.commits.map(c => c.oid))
			.toEqual([oids.commit3, oids.commit5, oids.commit6])
		expect(outcome!.commits[0]!.changed_paths)
			.toEqual(['.engineering/req/REQ-001.md'])
		expect(outcome!.commits[2]!.changed_paths)
			.toEqual([
				'.engineering/req/REQ-001.md',
				'.engineering/resources/REQ-001/notes.md',
			])
	})

	it('tracks draft-only Git history (no CHG effects) for an Artifact aggregate', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'REQ-002', 'requirement', new Map())
		expect(outcome)
			.toBeDefined()
		expect(outcome!.effects)
			.toEqual([])
		expect(outcome!.commits.map(c => c.oid))
			.toEqual([oids.commit2, oids.commit4])
	})

	it('includes control files (ef.yaml, .gitignore) in the PROJECT aggregate', async () => {
		const outcome = await computeHistory(gitRepo(), oids.commit7!, 'PROJECT', 'project', new Map())
		expect(outcome)
			.toBeDefined()
		expect(outcome!.commits.map(c => c.oid))
			.toEqual([oids.commit1, oids.commit7])
		expect(outcome!.commits[0]!.changed_paths)
			.toEqual([
				'.engineering/.gitignore',
				'.engineering/PROJECT.md',
				'.engineering/ef.yaml',
			])
		expect(outcome!.commits[1]!.changed_paths)
			.toEqual(['.engineering/ef.yaml'])
	})

	it('prefers a live (current-snapshot) CHG summary over the historically-decoded one when available', async () => {
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
		expect(outcome!.effects[0]!.chg)
			.toEqual(buildArtifactSummary(liveChg.envelope, liveChg.path))
		expect(outcome!.effects[0]!.chg.title)
			.toBe('LIVE CURRENT TITLE')
	})

	it('returns undefined when the required history cannot be completely materialized (shallow clone)', async () => {
		const shallowDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-shallow-')))
		try {
			git(shallowDir, ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${tempDir}`, '.'])
			const tipOid = git(shallowDir, ['rev-parse', 'HEAD'])
				.trim()
			const outcome = await computeHistory(gitRepo(shallowDir), tipOid, 'REQ-001', 'requirement', new Map())
			expect(outcome)
				.toBeUndefined()
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
			expect(outcome)
				.not
				.toBeUndefined()
			expect(outcome!.commits.length)
				.toBeGreaterThan(0)
		}
		finally {
			await fs.rm(otherSourceDir, { recursive: true, force: true })
		}
	})

	it('returns undefined when a historical commit tree cannot be resolved mid-walk', async () => {
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
			.toBeUndefined()
	})

	it('treats an unresolvable target blob as an undecodable envelope, falling back status_after to the terminal default', async () => {
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
		// Limited to commit3 itself: REQ-001 first appears in this commit, so
		// there is no earlier history whose `previousEnvelope` could mask the
		// fallback -- both `currentEnvelope` and `previousEnvelope` are absent,
		// so `status_after` must fall all the way back to the literal 'retired'.
		const outcome = await computeHistory(wrapped, oids.commit3!, 'REQ-001', 'requirement', new Map())
		expect(outcome)
			.toBeDefined()
		expect(outcome!.effects)
			.toEqual([
				expect.objectContaining({ effect: 'introduces', status_before: null, status_after: 'retired', commit_oid: oids.commit3 }),
			])
	})

	it('does not report an engineering effect for a non-effect relation (references) alongside an effect relation on the same completed CHG', async () => {
		await writeFile(tempDir, '.engineering/chg/CHG-003.md', chgMd('CHG-003', 'completed', '  - type: modifies\n    target: REQ-001\n  - type: references\n    target: REQ-001'))
		const commitOid = commitAll(tempDir, 'chg-003 mixed relations')

		const outcome = await computeHistory(gitRepo(), commitOid, 'REQ-001', 'requirement', new Map())
		expect(outcome)
			.toBeDefined()
		const chg3Effects = outcome!.effects.filter(e => e.chg.id === 'CHG-003')
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
		expect(outcome)
			.toBeDefined()
		const lastCommit = outcome!.commits.at(-1)!
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
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			const bootstrapOid = commitAll(dir, 'project only, no control files yet')
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/.gitignore', '.cache/\n')
			const withControlsOid = commitAll(dir, 'add control files')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, withControlsOid, 'PROJECT', 'project', new Map())
			expect(outcome)
				.toBeDefined()
			expect(outcome!.commits.map(c => c.oid))
				.toEqual([bootstrapOid, withControlsOid])
			expect(outcome!.commits[0]!.changed_paths)
				.toEqual(['.engineering/PROJECT.md'])
			expect(outcome!.commits[1]!.changed_paths)
				.toEqual([
					'.engineering/.gitignore',
					'.engineering/ef.yaml',
				])
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe('computeHistory: malformed CHG file mid-history', () => {
	it('ignores a chg/*.md file whose envelope cannot be decoded, without crashing or reporting a false effect', async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-history-chg-stub-')))
		try {
			git(dir, ['init', '-q', '-b', 'main'])
			await writeFile(dir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(dir, '.engineering/PROJECT.md', PROJECT_MD)
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'draft'))
			// A CHG stub whose frontmatter is missing required fields and therefore fails to decode.
			await writeFile(dir, '.engineering/chg/CHG-001.md', '---\nschema: ef/change@1\ntype: change\nid: CHG-001\n---\n\nplaceholder\n')
			commitAll(dir, 'chg stub, undecodable envelope')

			await writeFile(dir, '.engineering/chg/CHG-001.md', chgMd('CHG-001', 'completed', '  - type: introduces\n    target: REQ-001'))
			await writeFile(dir, '.engineering/req/REQ-001.md', reqMd('REQ-001', 'active'))
			const completedOid = commitAll(dir, 'chg completed')

			const repo = createGitRepository(dir, createGitExecutor())
			const outcome = await computeHistory(repo, completedOid, 'REQ-001', 'requirement', new Map())
			expect(outcome)
				.toBeDefined()
			expect(outcome!.effects)
				.toEqual([
					expect.objectContaining({ effect: 'introduces', commit_oid: completedOid }),
				])
		}
		finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
