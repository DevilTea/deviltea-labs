import type { GitRepository } from '../git/repository'
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
			readFileBytes: async () => {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
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

	it('silently excludes an artifact file that vanishes between listing and read (ENOENT), rather than treating it as read-error', async () => {
		const deps: SnapshotFsDeps = {
			isDirectory: async () => true,
			isSymlink: async () => false,
			walkDirectory: async () => [
				{ relativePath: 'req/REQ-001.md', isRegularFile: true, isDirectory: false, isSymlink: false },
			],
			readFileBytes: async () => {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
			},
		}
		const result = await loadSnapshotFromWorkingTree('/fake/project', deps)
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.artifacts)
			.toEqual([])
		expect(result.snapshot.configBytes)
			.toBeUndefined()
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

	it('excludes an artifact whose blob cannot be resolved (e.g. a pruned object), without treating the commit as unreadable', async () => {
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
			.toBe(true)
		if (!result.ok)
			return
		expect(result.snapshot.artifacts)
			.toEqual([])
		expect(result.snapshot.configBytes)
			.toBeUndefined()
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
