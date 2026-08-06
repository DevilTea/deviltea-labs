import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isDirectory, isRegularFile, isSymlink, readFileBytes, walkDirectory } from './fs-facts'

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('isRegularFile / isDirectory / isSymlink', () => {
	it('classifies a regular file', async () => {
		const target = path.join(tempRoot, 'PROJECT.md')
		fs.writeFileSync(target, 'content')

		await expect(isRegularFile(target)).resolves.toBe(true)
		await expect(isDirectory(target)).resolves.toBe(false)
		await expect(isSymlink(target)).resolves.toBe(false)
	})

	it('classifies a directory', async () => {
		const target = path.join(tempRoot, 'req')
		fs.mkdirSync(target)

		await expect(isRegularFile(target)).resolves.toBe(false)
		await expect(isDirectory(target)).resolves.toBe(true)
		await expect(isSymlink(target)).resolves.toBe(false)
	})

	it('classifies a symlink using lstat, never following it to the target', async () => {
		const realFile = path.join(tempRoot, 'real.md')
		fs.writeFileSync(realFile, 'content')
		const link = path.join(tempRoot, 'link.md')
		fs.symlinkSync(realFile, link)

		// A symlink to a regular file must not be reported as the regular file
		// itself: lstat inspects the link, not its resolved target.
		await expect(isRegularFile(link)).resolves.toBe(false)
		await expect(isDirectory(link)).resolves.toBe(false)
		await expect(isSymlink(link)).resolves.toBe(true)
	})

	it('reports false for a missing path rather than throwing', async () => {
		const target = path.join(tempRoot, 'does-not-exist.md')

		await expect(isRegularFile(target)).resolves.toBe(false)
		await expect(isDirectory(target)).resolves.toBe(false)
		await expect(isSymlink(target)).resolves.toBe(false)
	})
})

describe('walkDirectory', () => {
	it('returns every entry beneath root with its type flags, using / separators', async () => {
		fs.mkdirSync(path.join(tempRoot, 'req'))
		fs.writeFileSync(path.join(tempRoot, 'req', 'REQ-001.md'), 'x')
		fs.mkdirSync(path.join(tempRoot, 'resources'))
		fs.mkdirSync(path.join(tempRoot, 'resources', 'REQ-001'))
		fs.writeFileSync(path.join(tempRoot, 'resources', 'REQ-001', 'schema.json'), '{}')
		fs.writeFileSync(path.join(tempRoot, 'ef.yaml'), 'schema: ef/config@1\n')

		const entries = await walkDirectory(tempRoot)
		const byPath = new Map(entries.map(entry => [entry.relativePath, entry]))

		expect(byPath.get('ef.yaml'))
			.toEqual({ relativePath: 'ef.yaml', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(byPath.get('req'))
			.toEqual({ relativePath: 'req', isRegularFile: false, isDirectory: true, isSymlink: false })
		expect(byPath.get('req/REQ-001.md'))
			.toEqual({ relativePath: 'req/REQ-001.md', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(byPath.get('resources/REQ-001/schema.json'))
			.toEqual({ relativePath: 'resources/REQ-001/schema.json', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(entries)
			.toHaveLength(6)
	})

	it('reports a symlinked directory as a symlink and does not descend into it', async () => {
		const realDir = path.join(tempRoot, 'real-dir')
		fs.mkdirSync(realDir)
		fs.writeFileSync(path.join(realDir, 'inside.md'), 'x')
		fs.symlinkSync(realDir, path.join(tempRoot, 'linked-dir'))

		const entries = await walkDirectory(tempRoot)
		const relativePaths = entries.map(entry => entry.relativePath)
			.sort()

		expect(relativePaths)
			.toEqual(['linked-dir', 'real-dir', 'real-dir/inside.md'])
		const linkedEntry = entries.find(entry => entry.relativePath === 'linked-dir')
		expect(linkedEntry)
			.toEqual({ relativePath: 'linked-dir', isRegularFile: false, isDirectory: false, isSymlink: true })
	})

	it('returns an empty array for an empty directory', async () => {
		await expect(walkDirectory(tempRoot))
			.resolves.toEqual([])
	})
})

describe('readFileBytes', () => {
	it('returns exact raw bytes, including a BOM and CRLF, as a Uint8Array', async () => {
		const target = path.join(tempRoot, 'raw.md')
		const bytes = Uint8Array.from([0xEF, 0xBB, 0xBF, 0x61, 0x0D, 0x0A, 0x62])
		fs.writeFileSync(target, bytes)

		const result = await readFileBytes(target)
		expect(result)
			.toBeInstanceOf(Uint8Array)
		expect(Array.from(result))
			.toEqual(Array.from(bytes))
	})
})
