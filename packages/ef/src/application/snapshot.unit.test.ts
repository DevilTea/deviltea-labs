import type { GitRepository } from '../git/repository'
import type { ReadRegularFileNoFollowResult } from '../platform/fs-facts'
import type { SnapshotFsDeps } from './snapshot'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { loadSnapshotFromCommit, loadSnapshotFromWorkingTree } from './snapshot'

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
summary: A minimal example project used for snapshot loading tests.
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

async function writeMinimalProject(root: string): Promise<void> {
	const engineeringDir = path.join(root, '.engineering')
	await fs.mkdir(engineeringDir, { recursive: true })
	await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), CONFIG_YAML)
	await fs.writeFile(path.join(engineeringDir, '.gitignore'), GITIGNORE)
	await fs.writeFile(path.join(engineeringDir, 'PROJECT.md'), PROJECT_MD)
}

function fakeGitRepository(overrides: Partial<GitRepository>): GitRepository {
	const notImplemented = () => {
		throw new Error('not implemented in this fake')
	}
	return {
		root: '/fake',
		findWorktreeRoot: notImplemented,
		getObjectFormat: notImplemented,
		resolveCommit: notImplemented,
		resolveRef: notImplemented,
		getFirstParent: notImplemented,
		readTree: notImplemented,
		readBlob: notImplemented,
		listFirstParentHistory: notImplemented,
		pathExistsInFirstParentHistory: notImplemented,
		diffTrees: notImplemented,
		...overrides,
	}
}

describe('loadSnapshotFromWorkingTree', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-snapshot-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('reports engineering-missing when .engineering is not a directory', async () => {
		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('engineering-missing')
	})

	it('loads config, gitignore, and PROJECT.md bytes for a minimal valid project', async () => {
		await writeMinimalProject(tempDir)

		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return

		const { snapshot } = result
		expect(snapshot.source)
			.toEqual({ kind: 'working-tree', projectRoot: tempDir })
		expect(snapshot.config.config).not.toBeNull()
		expect(snapshot.config.diagnostics)
			.toEqual([])
		expect(snapshot.configBytes)
			.toBeDefined()
		expect(snapshot.gitignoreBytes)
			.toBeDefined()
		expect(snapshot.layoutDiagnostics)
			.toEqual([])
		expect(snapshot.resourceFiles)
			.toEqual([])
		expect(snapshot.entryKinds.get('.engineering'))
			.toBe('directory')

		expect(snapshot.artifacts)
			.toHaveLength(1)
		const [project] = snapshot.artifacts
		expect(project!.path)
			.toBe('.engineering/PROJECT.md')
		expect(project!.frontmatter.ok)
			.toBe(true)
		expect(project!.envelope?.envelope?.id)
			.toBe('PROJECT')
		expect(project!.sections?.sections)
			.toHaveLength(5)
	})

	it('treats a missing ef.yaml/.gitignore as absent bytes rather than throwing', async () => {
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'PROJECT.md'), PROJECT_MD)

		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.configBytes)
			.toBeUndefined()
		expect(result.snapshot.gitignoreBytes)
			.toBeUndefined()
		expect(result.snapshot.config)
			.toEqual({ config: null, diagnostics: [] })
	})

	it('discovers files beneath the managed Resource root as resourceFiles, not artifacts', async () => {
		await writeMinimalProject(tempDir)
		const resourceDir = path.join(tempDir, '.engineering', 'resources', 'REQ-001')
		await fs.mkdir(resourceDir, { recursive: true })
		await fs.writeFile(path.join(resourceDir, 'schema.json'), '{}\n')

		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return

		const paths = result.snapshot.resourceFiles.map(r => r.path)
			.sort()
		expect(paths)
			.toEqual([
				'.engineering/resources/REQ-001',
				'.engineering/resources/REQ-001/schema.json',
			])
		expect(result.snapshot.artifacts)
			.toHaveLength(1)
	})

	it('reports read-error (not engineering-missing) when a required file path is actually a directory', async () => {
		await writeMinimalProject(tempDir)
		await fs.rm(path.join(tempDir, '.engineering', 'ef.yaml'))
		await fs.mkdir(path.join(tempDir, '.engineering', 'ef.yaml'))

		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
	})

	it('classifies a symlinked `.engineering` root itself as a symlink entry kind', async () => {
		const deps: SnapshotFsDeps = {
			isDirectory: async () => true,
			isSymlink: async () => true,
			walkDirectory: async () => [],
			readRegularFileNoFollow: async () => {
				throw new Error('must not be called: no walk entry was observed for this path')
			},
		}
		const result = await loadSnapshotFromWorkingTree('/fake/project', deps)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.entryKinds.get('.engineering'))
			.toBe('symlink')
	})

	// FINDING 2 (snapshot.ts, loadSnapshotFromWorkingTree): the directory walk
	// records a regular Artifact, but the earlier implementation's
	// pathname-based `readFile` was never bound to that observation. A
	// discrepancy discovered between the walk and the read (the file vanished,
	// changed kind, or was replaced) must make the WHOLE snapshot load
	// incomplete (`read-error`), never silently omit the affected file while
	// still reporting `ok: true` -- which left `hasUndecodedArtifact` unset
	// downstream and made the graph look complete when it was not. Each case
	// asserts `expectedIdentity` is exactly what `walkDirectory` recorded,
	// proving the read is actually bound to the walk observation rather than
	// merely retried against the bare path.
	describe('races between the directory walk and the per-file read', () => {
		const walkedIdentity = { dev: 1, ino: 42 }

		function racingDeps(raceResult: ReadRegularFileNoFollowResult): SnapshotFsDeps {
			return {
				isDirectory: async () => true,
				isSymlink: async () => false,
				walkDirectory: async () => [
					{ relativePath: 'req/REQ-001.md', isRegularFile: true, isDirectory: false, isSymlink: false, identity: walkedIdentity },
				],
				readRegularFileNoFollow: async (_target, expectedIdentity) => {
					expect(expectedIdentity)
						.toEqual(walkedIdentity)
					return raceResult
				},
			}
		}

		it('reports read-error (not a silent omission) when the artifact file disappears between walk and read', async () => {
			const result = await loadSnapshotFromWorkingTree('/fake/project', racingDeps({ kind: 'not-found' }))
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('read-error')
			expect(result.ok === false && result.message)
				.toContain('req/REQ-001.md')
		})

		it('reports read-error (not a silent omission) when the final entry is replaced by a symlink between walk and read', async () => {
			const result = await loadSnapshotFromWorkingTree('/fake/project', racingDeps({ kind: 'not-a-regular-file' }))
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('read-error')
			expect(result.ok === false && result.message)
				.toContain('req/REQ-001.md')
		})

		it('reports read-error (not a silent omission) when an ancestor directory swap makes the final open resolve to a different file', async () => {
			const result = await loadSnapshotFromWorkingTree('/fake/project', racingDeps({ kind: 'identity-mismatch' }))
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('read-error')
			expect(result.ok === false && result.message)
				.toContain('req/REQ-001.md')
		})

		it('succeeds when the identity-bound read matches the walk observation exactly (no race)', async () => {
			const deps: SnapshotFsDeps = {
				isDirectory: async () => true,
				isSymlink: async () => false,
				walkDirectory: async () => [
					{ relativePath: 'req/REQ-001.md', isRegularFile: true, isDirectory: false, isSymlink: false, identity: walkedIdentity },
				],
				readRegularFileNoFollow: async () => ({ kind: 'ok', bytes: new TextEncoder()
					.encode('---\nschema: ef/req@1\n---\n') }),
			}
			const result = await loadSnapshotFromWorkingTree('/fake/project', deps)
			expect(result.ok)
				.toBe(true)
			if (!result.ok)
				return
			expect(result.snapshot.artifacts)
				.toHaveLength(1)
		})
	})

	// FINDING 3 (layout.ts / working-tree walk): a FIFO named exactly like a
	// canonical Artifact path is not readable as a file; it must be reported
	// (`EF-FS-003`), never silently vanish from both `artifacts` and
	// `layoutDiagnostics`.
	it('reports EF-FS-003 (not a silent omission) for a FIFO named PROJECT.md in the working tree', async () => {
		if (process.platform === 'win32') {
			// mkfifo has no direct Windows equivalent; POSIX-only per the
			// finding's own guidance.
			return
		}
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		execFileSync('mkfifo', [path.join(tempDir, '.engineering', 'PROJECT.md')])

		const result = await loadSnapshotFromWorkingTree(tempDir)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.artifacts)
			.toEqual([])
		expect(result.snapshot.entryKinds.get('.engineering/PROJECT.md'))
			.toBe('other')
		expect(result.snapshot.layoutDiagnostics.some(d => d.code === 'EF-FS-003' && d.path === '.engineering/PROJECT.md'))
			.toBe(true)
	})
})

describe('loadSnapshotFromCommit', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-snapshot-git-')))
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('reports commit-not-found for an oid that does not resolve to a commit', async () => {
		await writeMinimalProject(tempDir)
		commitAll(tempDir, 'initial')
		const executor = createGitExecutor()
		const repo = createGitRepository(tempDir, executor)

		const result = await loadSnapshotFromCommit(repo, '0'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('commit-not-found')
	})

	it('reports git-unavailable when readTree cannot run', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({ kind: 'git-unavailable', message: 'git is not installed' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result)
			.toEqual({ ok: false, reason: 'git-unavailable', message: 'git is not installed' })
	})

	it('reports git-unavailable when a required blob cannot be read', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/ef.yaml', mode: '100644', oid: 'blob-oid', type: 'blob' },
				],
			}),
			readBlob: async () => ({ kind: 'git-unavailable', message: 'git process crashed' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result)
			.toEqual({ ok: false, reason: 'git-unavailable', message: 'git process crashed' })
	})

	// FINDING (repository.ts readTree -> snapshot.ts loadSnapshotFromCommit):
	// `readTree`'s `error` kind means the commit was already proven to exist
	// but its tree could not be read -- distinct from `missing` (a genuine
	// absence). This must surface as an incomplete `read-error`, not be
	// accessed as though `treeResult` were `resolved`.
	it('reports read-error (not commit-not-found) when the commit tree exists but cannot be read', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({ kind: 'error', message: 'ls-tree failed after cat-file -t proved existence' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('ls-tree failed after cat-file -t proved existence')
	})

	// FINDING (repository.ts readBlob -> snapshot.ts readBlobOrThrow): before
	// this fix, `readBlobOrThrow` folded ANY non-`resolved` `readBlob` kind
	// (including the new `error` kind) into `undefined`, silently treating a
	// blob proven to exist as a tree entry -- but which then failed to read --
	// the same as a genuinely absent control file. A control file that fails
	// to read this way must fail the whole load as `read-error`, not silently
	// report `configBytes: undefined` as though '.engineering/ef.yaml' were
	// simply never committed.
	it('reports read-error (not a silently absent config) when a required blob exists but its content read fails', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/ef.yaml', mode: '100644', oid: 'blob-oid', type: 'blob' },
				],
			}),
			readBlob: async () => ({ kind: 'error', message: 'cat-file -p failed after cat-file -t proved it is a blob' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('cat-file -p failed after cat-file -t proved it is a blob')
	})

	it('produces the same artifacts, config, and layout diagnostics as the equivalent working tree', async () => {
		await writeMinimalProject(tempDir)
		const resourceDir = path.join(tempDir, '.engineering', 'resources', 'PROJECT')
		await fs.mkdir(resourceDir, { recursive: true })
		await fs.writeFile(path.join(resourceDir, 'diagram.svg'), '<svg></svg>\n')
		const commitOid = commitAll(tempDir, 'initial')

		const workingTreeResult = await loadSnapshotFromWorkingTree(tempDir)
		expect(workingTreeResult.ok)
			.toBe(true)

		const executor = createGitExecutor()
		const repo = createGitRepository(tempDir, executor)
		const commitResult = await loadSnapshotFromCommit(repo, commitOid)
		expect(commitResult.ok)
			.toBe(true)
		if (!workingTreeResult.ok || !commitResult.ok)
			return

		expect(commitResult.snapshot.source)
			.toEqual({ kind: 'commit', commitOid })
		expect(commitResult.snapshot.config)
			.toEqual(workingTreeResult.snapshot.config)
		expect(commitResult.snapshot.layoutDiagnostics)
			.toEqual(workingTreeResult.snapshot.layoutDiagnostics)
		expect(commitResult.snapshot.resourceFiles.map(r => r.path)
			.sort())
			.toEqual(workingTreeResult.snapshot.resourceFiles.map(r => r.path)
				.sort())
		expect(commitResult.snapshot.artifacts.map(a => ({ path: a.path, text: a.text })))
			.toEqual(workingTreeResult.snapshot.artifacts.map(a => ({ path: a.path, text: a.text })))
		expect([...commitResult.snapshot.entryKinds.entries()].sort())
			.toEqual([...workingTreeResult.snapshot.entryKinds.entries()].sort())
	})

	it('classifies a Git symlink-mode entry (120000) as a symlink', async () => {
		await writeMinimalProject(tempDir)
		await fs.symlink('PROJECT.md', path.join(tempDir, '.engineering', 'linked.md'))
		const commitOid = commitAll(tempDir, 'with symlink')

		const executor = createGitExecutor()
		const repo = createGitRepository(tempDir, executor)
		const result = await loadSnapshotFromCommit(repo, commitOid)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.entryKinds.get('.engineering/linked.md'))
			.toBe('symlink')
	})

	it('treats a commit tree lacking ef.yaml/.gitignore as absent bytes rather than an error', async () => {
		await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
		await fs.writeFile(path.join(tempDir, '.engineering', 'PROJECT.md'), PROJECT_MD)
		const commitOid = commitAll(tempDir, 'project only, no control files')

		const executor = createGitExecutor()
		const repo = createGitRepository(tempDir, executor)
		const result = await loadSnapshotFromCommit(repo, commitOid)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.configBytes)
			.toBeUndefined()
		expect(result.snapshot.gitignoreBytes)
			.toBeUndefined()
		expect(result.snapshot.config)
			.toEqual({ config: null, diagnostics: [] })
	})

	// FINDING (readBlobOrThrow): once the tree listing already proved an
	// Artifact entry exists as a blob (`type: 'blob'`), a follow-up
	// `readBlob` reporting it `missing` (e.g. a pruned object) is
	// repository/read corruption, not a legitimate absence -- silently
	// excluding the Artifact from `snapshot.artifacts` would drop it from the
	// materialized snapshot without a trace, leaving it invisible to
	// `hasUndecodedArtifact` so validation/query could still look complete.
	// Before this fix, this case was folded into the same `undefined` used
	// for a genuinely absent path and the whole load reported `ok: true`.
	it('reports read-error (not a silent omission) when a tree-listed artifact blob is reported missing', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/req', mode: '040000', oid: 'tree-req-oid', type: 'tree' },
					{ path: '.engineering/req/REQ-001.md', mode: '100644', oid: 'blob-oid-missing', type: 'blob' },
				],
			}),
			readBlob: async (oid: string) => {
				if (oid === 'blob-oid-missing')
					return { kind: 'missing' }
				throw new Error(`unexpected oid: ${oid}`)
			},
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('.engineering/req/REQ-001.md')
	})

	// Same defect, `not-a-blob` variant: the tree proved the path is a blob,
	// but `readBlob` then reports the object it points at has a different
	// actual type (e.g. a corrupted/rewritten repository). Still a read
	// failure, never a legitimate absence.
	it('reports read-error (not a silent omission) when a tree-listed artifact blob is reported not-a-blob', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/req', mode: '040000', oid: 'tree-req-oid', type: 'tree' },
					{ path: '.engineering/req/REQ-001.md', mode: '100644', oid: 'blob-oid-corrupt', type: 'blob' },
				],
			}),
			readBlob: async (oid: string) => {
				if (oid === 'blob-oid-corrupt')
					return { kind: 'not-a-blob', actualType: 'tree' }
				throw new Error(`unexpected oid: ${oid}`)
			},
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('.engineering/req/REQ-001.md')
	})

	// Same defect, config-file variant: the tree proved `.engineering/ef.yaml`
	// exists as a blob, so a follow-up `missing` read must not be folded into
	// `configBytes: undefined` as though the file were genuinely absent.
	it('reports read-error (not a silently absent config) when a tree-listed ef.yaml blob is reported missing', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/ef.yaml', mode: '100644', oid: 'blob-oid-missing', type: 'blob' },
				],
			}),
			readBlob: async () => ({ kind: 'missing' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('.engineering/ef.yaml')
	})

	// Same defect, `not-a-blob` variant of the config-file case.
	it('reports read-error (not a silently absent config) when a tree-listed ef.yaml blob is reported not-a-blob', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/ef.yaml', mode: '100644', oid: 'blob-oid-corrupt', type: 'blob' },
				],
			}),
			readBlob: async () => ({ kind: 'not-a-blob', actualType: 'tree' }),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('read-error')
		expect(result.ok === false && result.message)
			.toContain('.engineering/ef.yaml')
	})

	// FINDING 3 (git/repository.ts `readTree` classification -> snapshot.ts
	// `entryKindOf`): a gitlink (`type: 'commit'`, Git submodule reference)
	// named exactly like a canonical Artifact path was previously classified
	// as `'file'` (the same fallback used for a genuine blob), so
	// `listArtifactFiles` reported it as a readable Artifact candidate. It is
	// never in `blobEntries` (only `type: 'blob'` entries are), so
	// `readBlobOrThrow(git, undefined)` silently returned `undefined` and the
	// artifacts loop dropped it with `continue` -- no diagnostic, no
	// `hasUndecodedArtifact`, `readBlob` never even called. It must instead be
	// reported as a canonical-layout violation (`EF-FS-003`), never silently
	// treated as absent.
	it('reports EF-FS-003 (not a silent omission) for a Git gitlink (submodule) entry named like an Artifact file', async () => {
		const repo = fakeGitRepository({
			readTree: async () => ({
				kind: 'resolved',
				entries: [
					{ path: '.engineering', mode: '040000', oid: 'tree-oid', type: 'tree' },
					{ path: '.engineering/req', mode: '040000', oid: 'tree-req-oid', type: 'tree' },
					{ path: '.engineering/req/REQ-001.md', mode: '160000', oid: 'gitlink-oid', type: 'commit' },
				],
			}),
		})
		const result = await loadSnapshotFromCommit(repo, 'a'.repeat(40))
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.artifacts)
			.toEqual([])
		expect(result.snapshot.entryKinds.get('.engineering/req/REQ-001.md'))
			.toBe('other')
		expect(result.snapshot.layoutDiagnostics.some(d => d.code === 'EF-FS-003' && d.path === '.engineering/req/REQ-001.md'))
			.toBe(true)
	})

	it('rethrows a non-GitUnavailableError raised while materializing the commit tree', async () => {
		const repo = fakeGitRepository({
			readTree: async () => {
				throw new Error('boom')
			},
		})
		await expect(loadSnapshotFromCommit(repo, 'a'.repeat(40)))
			.rejects.toThrow('boom')
	})
})
