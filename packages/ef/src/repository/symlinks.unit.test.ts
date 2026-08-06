import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSymlink } from '../platform/fs-facts'
import { checkManagedSymlinks, managedSymlinkPaths, pathComponents } from './symlinks'

describe('pathComponents', () => {
	it('returns every prefix of a nested path', () => {
		expect(pathComponents('a/b/c'))
			.toEqual(['a', 'a/b', 'a/b/c'])
	})

	it('returns a single component for a top-level name', () => {
		expect(pathComponents('a'))
			.toEqual(['a'])
	})
})

describe('managedSymlinkPaths', () => {
	it('always includes the fixed .engineering paths', () => {
		const result = managedSymlinkPaths({ artifactFiles: [], resourceFiles: [] })
		expect(result)
			.toEqual(expect.arrayContaining([
				'.engineering',
				'.engineering/prd',
				'.engineering/req',
				'.engineering/adr',
				'.engineering/pol',
				'.engineering/chg',
				'.engineering/resources',
				'.engineering/ef.yaml',
				'.engineering/.gitignore',
			]))
	})

	it('includes every Artifact file verbatim', () => {
		const result = managedSymlinkPaths({
			artifactFiles: ['.engineering/PROJECT.md', '.engineering/req/REQ-031.md'],
			resourceFiles: [],
		})
		expect(result)
			.toEqual(expect.arrayContaining(['.engineering/PROJECT.md', '.engineering/req/REQ-031.md']))
	})

	it('includes every existing directory component of a Resource file path', () => {
		const result = managedSymlinkPaths({
			artifactFiles: [],
			resourceFiles: ['.engineering/resources/REQ-031/search-filter.schema.json'],
		})
		expect(result)
			.toEqual(expect.arrayContaining([
				'.engineering/resources/REQ-031',
				'.engineering/resources/REQ-031/search-filter.schema.json',
			]))
	})

	it('omits linked repository paths when none are supplied', () => {
		const result = managedSymlinkPaths({ artifactFiles: [], resourceFiles: [] })
		expect(result.some(p => p.startsWith('repos/')))
			.toBe(false)
	})

	it('includes linked repository path components only when explicitly supplied (workspace mode)', () => {
		const result = managedSymlinkPaths({
			artifactFiles: [],
			resourceFiles: [],
			linkedRepositoryPaths: ['repos/project-fe'],
		})
		expect(result)
			.toEqual(expect.arrayContaining(['repos', 'repos/project-fe']))
	})

	it('deduplicates and returns a bytewise-sorted array', () => {
		const result = managedSymlinkPaths({
			artifactFiles: ['.engineering/ef.yaml'],
			resourceFiles: [],
		})
		const uniqueSorted = [...new Set(result)].sort()
		expect(result)
			.toEqual(uniqueSorted)
		expect(result.filter(p => p === '.engineering/ef.yaml'))
			.toHaveLength(1)
	})
})

describe('checkManagedSymlinks', () => {
	it('reports EF-FS-004 for exactly the flagged symlink paths', () => {
		const diagnostics = checkManagedSymlinks([
			{ path: '.engineering', isSymlink: false },
			{ path: '.engineering/req', isSymlink: true },
			{ path: '.engineering/req/REQ-031.md', isSymlink: false },
		])
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-004', severity: 'error', path: '.engineering/req' }),
			])
	})

	it('returns an empty array when nothing is a symlink', () => {
		expect(checkManagedSymlinks([{ path: '.engineering', isSymlink: false }]))
			.toEqual([])
	})

	it('reports every flagged path when more than one is a symlink', () => {
		const diagnostics = checkManagedSymlinks([
			{ path: '.engineering/req', isSymlink: true },
			{ path: '.engineering/adr', isSymlink: true },
		])
		expect(diagnostics.map(d => d.path))
			.toEqual(['.engineering/adr', '.engineering/req'])
	})
})

describe('checkManagedSymlinks with real filesystem facts', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-'))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('flags a real symlinked canonical directory and not an ordinary one', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.mkdir(path.join(engineeringDir, 'req'), { recursive: true })
		const realTarget = path.join(tempDir, 'real-adr')
		await fs.mkdir(realTarget, { recursive: true })
		await fs.symlink(realTarget, path.join(engineeringDir, 'adr'), 'dir')

		const facts = await Promise.all(['.engineering/req', '.engineering/adr'].map(async (relativePath) => {
			return { path: relativePath, isSymlink: await isSymlink(path.join(tempDir, relativePath)) }
		}))

		const diagnostics = checkManagedSymlinks(facts)
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-004', path: '.engineering/adr' }),
			])
	})
})
