import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishViaHardLink, writeTempFileComplete } from './hard-link-publish'

const { linkMock } = vi.hoisted(() => ({ linkMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	linkMock.mockImplementation((...args: Parameters<typeof actual.link>) => actual.link(...args))
	return { ...actual, link: linkMock }
})

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
	linkMock.mockClear()
})

describe('writeTempFileComplete', () => {
	it('writes exactly the given bytes and makes them durable before returning', async () => {
		const target = path.join(tempRoot, '.tmp-REQ-031.md')
		const bytes = new TextEncoder()
			.encode('---\nschema: ef/requirement@1\n---\n')

		const result = await writeTempFileComplete(target, bytes)
		expect(result.outcome)
			.toBe('written')
		expect(new Uint8Array(fs.readFileSync(target)))
			.toEqual(bytes)

		// Finding (P0, fifteenth round): `identity` and `bytes` are captured
		// from the exact `open(target, 'wx+')` handle this call created --
		// via `handle.stat()` and a read back through that same handle --
		// BEFORE it closes, never re-derived from a later, independent
		// pathname observation of `target`.
		if (result.outcome !== 'written')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(result.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(new Uint8Array(result.bytes))
			.toEqual(bytes)
	})

	it('returns a distinct identity for two temporary files written in the same call sequence, both matching their own on-disk stat', async () => {
		const targetA = path.join(tempRoot, '.tmp-REQ-031.md')
		const targetB = path.join(tempRoot, '.tmp-REQ-032.md')
		const bytesA = new TextEncoder()
			.encode('A')
		const bytesB = new TextEncoder()
			.encode('B')

		const resultA = await writeTempFileComplete(targetA, bytesA)
		const resultB = await writeTempFileComplete(targetB, bytesB)
		if (resultA.outcome !== 'written' || resultB.outcome !== 'written')
			throw new Error('unreachable: both writes are expected to succeed')

		expect(resultA.identity)
			.toEqual({ dev: fs.statSync(targetA).dev, ino: fs.statSync(targetA).ino })
		expect(resultB.identity)
			.toEqual({ dev: fs.statSync(targetB).dev, ino: fs.statSync(targetB).ino })
		expect(resultA.identity)
			.not.toEqual(resultB.identity)
		expect(new Uint8Array(resultA.bytes))
			.toEqual(bytesA)
		expect(new Uint8Array(resultB.bytes))
			.toEqual(bytesB)
	})

	it('captures identity and a correct read-back even for a zero-byte temporary file', async () => {
		const target = path.join(tempRoot, '.tmp-empty.md')
		const result = await writeTempFileComplete(target, new Uint8Array())
		if (result.outcome !== 'written')
			throw new Error('unreachable: expected a successful write')

		expect(result.bytes.length)
			.toBe(0)
		const stats = fs.statSync(target)
		expect(result.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
	})

	it('reports already-exists rather than truncating a pre-existing temp path', async () => {
		const target = path.join(tempRoot, '.tmp-REQ-031.md')
		fs.writeFileSync(target, 'pre-existing')

		const result = await writeTempFileComplete(target, new TextEncoder()
			.encode('new content'))
		expect(result)
			.toEqual({ outcome: 'already-exists' })
		expect(fs.readFileSync(target, 'utf8'))
			.toBe('pre-existing')
	})

	it('reports a non-collision failure distinctly, such as a missing parent directory', async () => {
		const target = path.join(tempRoot, 'missing-parent', '.tmp-REQ-031.md')
		const result = await writeTempFileComplete(target, new Uint8Array())
		expect(result.outcome)
			.toBe('failed')
	})
})

describe('publishViaHardLink', () => {
	it('publishes the canonical target as a hard link preserving exact byte content', async () => {
		const tempPath = path.join(tempRoot, '.tmp-REQ-031.md')
		const targetPath = path.join(tempRoot, 'REQ-031.md')
		const bytes = new TextEncoder()
			.encode('---\nschema: ef/requirement@1\n---\n')
		fs.writeFileSync(tempPath, bytes)

		const result = await publishViaHardLink(tempPath, targetPath)
		expect(result)
			.toEqual({ outcome: 'published' })
		expect(new Uint8Array(fs.readFileSync(targetPath)))
			.toEqual(bytes)

		// Same inode: this is a hard link, not a copy.
		expect(fs.statSync(targetPath).ino)
			.toBe(fs.statSync(tempPath).ino)
		expect(fs.statSync(targetPath).nlink)
			.toBeGreaterThanOrEqual(2)
	})

	it('reports target-exists as a race rejection and never replaces existing content', async () => {
		const firstTemp = path.join(tempRoot, '.tmp-first.md')
		const secondTemp = path.join(tempRoot, '.tmp-second.md')
		const targetPath = path.join(tempRoot, 'REQ-031.md')
		fs.writeFileSync(firstTemp, 'first-published-content')
		fs.writeFileSync(secondTemp, 'second-racing-content-different')

		const firstResult = await publishViaHardLink(firstTemp, targetPath)
		expect(firstResult)
			.toEqual({ outcome: 'published' })

		const secondResult = await publishViaHardLink(secondTemp, targetPath)
		expect(secondResult)
			.toEqual({ outcome: 'target-exists' })

		expect(fs.readFileSync(targetPath, 'utf8'))
			.toBe('first-published-content')
	})

	it('reports unsupported for EPERM (hard-linking a directory is portably rejected by the OS)', async () => {
		const tempDir = path.join(tempRoot, 'not-a-file-dir')
		fs.mkdirSync(tempDir)
		const targetPath = path.join(tempRoot, 'REQ-031.md')

		const result = await publishViaHardLink(tempDir, targetPath)
		expect(result.outcome)
			.toBe('unsupported')
		expect(fs.existsSync(targetPath))
			.toBe(false)
	})

	it('reports unsupported for EXDEV (cross-device hard-link capability failure)', async () => {
		const tempPath = path.join(tempRoot, '.tmp-REQ-031.md')
		const targetPath = path.join(tempRoot, 'REQ-031.md')
		fs.writeFileSync(tempPath, 'x')

		const error = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
		linkMock.mockRejectedValueOnce(error)

		const result = await publishViaHardLink(tempPath, targetPath)
		expect(result)
			.toEqual({ outcome: 'unsupported', error })
	})

	it('reports a non-collision, non-capability failure distinctly, such as a missing temp file', async () => {
		const tempPath = path.join(tempRoot, 'does-not-exist.md')
		const targetPath = path.join(tempRoot, 'REQ-031.md')

		const result = await publishViaHardLink(tempPath, targetPath)
		expect(result.outcome)
			.toBe('failed')
	})
})
