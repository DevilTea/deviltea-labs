import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isDirectory, isRegularFile, isSymlink, readFileBytes, readRegularFileNoFollow, walkDirectory } from './fs-facts'

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
			.toMatchObject({ relativePath: 'ef.yaml', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(byPath.get('req'))
			.toMatchObject({ relativePath: 'req', isRegularFile: false, isDirectory: true, isSymlink: false })
		expect(byPath.get('req/REQ-001.md'))
			.toMatchObject({ relativePath: 'req/REQ-001.md', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(byPath.get('resources/REQ-001/schema.json'))
			.toMatchObject({ relativePath: 'resources/REQ-001/schema.json', isRegularFile: true, isDirectory: false, isSymlink: false })
		expect(entries)
			.toHaveLength(6)

		// Every real filesystem entry carries an `lstat`-derived `dev`/`ino`
		// identity a caller can later bind a read to (`readRegularFileNoFollow`'s
		// `expectedIdentity`).
		for (const entry of entries) {
			expect(typeof entry.identity?.dev)
				.toBe('number')
			expect(typeof entry.identity?.ino)
				.toBe('number')
		}
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
			.toMatchObject({ relativePath: 'linked-dir', isRegularFile: false, isDirectory: false, isSymlink: true })
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

// FINDING 1/2 (discovery.ts / snapshot.ts): a pathname-based `readFile`
// follows a symlink at the final path component, so a managed path (e.g.
// `.engineering/ef.yaml`) replaced by a symlink -- to an external file, or
// simply to another in-tree file -- is read through silently. This helper's
// own contract (typed refusal for anything that is not a genuinely observed,
// still-identical regular file) is what callers rely on to avoid that.
describe('readRegularFileNoFollow', () => {
	it('returns ok with the exact bytes of a genuine regular file', async () => {
		const target = path.join(tempRoot, 'ef.yaml')
		fs.writeFileSync(target, 'schema: ef/config@1\n')

		const result = await readRegularFileNoFollow(target)
		expect(result.kind)
			.toBe('ok')
		expect(result.kind === 'ok' && Buffer.from(result.bytes)
			.toString('utf8'))
			.toBe('schema: ef/config@1\n')
	})

	it('returns not-found for a missing path', async () => {
		const result = await readRegularFileNoFollow(path.join(tempRoot, 'does-not-exist.yaml'))
		expect(result)
			.toEqual({ kind: 'not-found' })
	})

	it('returns not-a-regular-file for a directory', async () => {
		const target = path.join(tempRoot, 'a-directory')
		fs.mkdirSync(target)

		const result = await readRegularFileNoFollow(target)
		expect(result)
			.toEqual({ kind: 'not-a-regular-file' })
	})

	it('refuses to read through a symlink even when its target is a real regular file, never returning the target bytes', async () => {
		const outsideFile = path.join(tempRoot, 'outside.yaml')
		fs.writeFileSync(outsideFile, 'schema: ef/config@1 # OUTSIDE CONTENT\n')
		const link = path.join(tempRoot, 'ef.yaml')
		fs.symlinkSync(outsideFile, link)

		const result = await readRegularFileNoFollow(link)
		expect(result)
			.toEqual({ kind: 'not-a-regular-file' })
	})

	it('succeeds when expectedIdentity matches the file\'s real lstat identity', async () => {
		const target = path.join(tempRoot, 'req.md')
		fs.writeFileSync(target, 'content')
		const stats = fs.lstatSync(target)

		const result = await readRegularFileNoFollow(target, { dev: stats.dev, ino: stats.ino })
		expect(result.kind)
			.toBe('ok')
	})

	it('returns identity-mismatch when expectedIdentity does not match the observed file (bound-read discrepancy)', async () => {
		const target = path.join(tempRoot, 'req.md')
		fs.writeFileSync(target, 'content')
		const stats = fs.lstatSync(target)

		const result = await readRegularFileNoFollow(target, { dev: stats.dev, ino: stats.ino + 1 })
		expect(result)
			.toEqual({ kind: 'identity-mismatch' })
	})
})
