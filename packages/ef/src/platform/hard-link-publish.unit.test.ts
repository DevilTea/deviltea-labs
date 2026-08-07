import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishViaHardLink, writeTempFileComplete } from './hard-link-publish'

const { linkMock, openMock } = vi.hoisted(() => ({ linkMock: vi.fn(), openMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	linkMock.mockImplementation((...args: Parameters<typeof actual.link>) => actual.link(...args))
	openMock.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args))
	return { ...actual, link: linkMock, open: openMock }
})

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
	linkMock.mockClear()
	openMock.mockClear()
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

		// Finding (P0, fifteenth round): identity/bytes are captured from the
		// exact `open(target, 'wx+')` handle this call created -- via
		// `handle.stat()` and a read back through that same handle -- before
		// it is ever closed, never re-derived from a later, independent
		// pathname observation of `target`. Sixteenth round: they are exposed
		// through the returned `OwnedFileLease`, whose creating handle stays
		// open rather than being closed here (see the dedicated describe
		// block below).
		if (result.outcome !== 'written')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(result.lease.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(new Uint8Array(result.lease.bytes))
			.toEqual(bytes)

		await result.lease.release()
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

		expect(resultA.lease.identity)
			.toEqual({ dev: fs.statSync(targetA).dev, ino: fs.statSync(targetA).ino })
		expect(resultB.lease.identity)
			.toEqual({ dev: fs.statSync(targetB).dev, ino: fs.statSync(targetB).ino })
		expect(resultA.lease.identity)
			.not.toEqual(resultB.lease.identity)
		expect(new Uint8Array(resultA.lease.bytes))
			.toEqual(bytesA)
		expect(new Uint8Array(resultB.lease.bytes))
			.toEqual(bytesB)

		await resultA.lease.release()
		await resultB.lease.release()
	})

	it('captures identity and a correct read-back even for a zero-byte temporary file', async () => {
		const target = path.join(tempRoot, '.tmp-empty.md')
		const result = await writeTempFileComplete(target, new Uint8Array())
		if (result.outcome !== 'written')
			throw new Error('unreachable: expected a successful write')

		expect(result.lease.bytes.length)
			.toBe(0)
		const stats = fs.statSync(target)
		expect(result.lease.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })

		await result.lease.release()
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

	// Finding (P0, sixteenth round): capturing identity/bytes from the
	// creating handle and then closing it before returning (the fifteenth-
	// round fix) is still not enough -- once closed, the temporary file has
	// only its pathname link, and a filesystem that recycles that freed
	// inode for a byte-identical foreign replacement at the same path can
	// report the exact same `(dev, ino)`. The handle must stay open,
	// retained by the returned lease, for as long as a destructive ownership
	// decision might still be made against it.
	describe('ownedFileLease (Finding, sixteenth round)', () => {
		it('keeps the creating handle open on success: fstatLive reports the same identity right after the write, before release()', async () => {
			const target = path.join(tempRoot, '.tmp-lease.md')
			const bytes = new TextEncoder()
				.encode('lease content')

			const result = await writeTempFileComplete(target, bytes)
			if (result.outcome !== 'written')
				throw new Error('unreachable: expected a successful write')

			const live = await result.lease.fstatLive()
			expect(live)
				.toEqual(result.lease.identity)

			await result.lease.release()
		})

		it('fstatLive returns undefined once the lease has been released', async () => {
			const target = path.join(tempRoot, '.tmp-lease-released.md')
			const result = await writeTempFileComplete(target, new TextEncoder()
				.encode('x'))
			if (result.outcome !== 'written')
				throw new Error('unreachable: expected a successful write')

			const releaseResult = await result.lease.release()
			expect(releaseResult)
				.toEqual({ outcome: 'released' })
			expect(await result.lease.fstatLive())
				.toBeUndefined()
		})

		it('release() is idempotent: calling it twice reports the same outcome without throwing', async () => {
			const target = path.join(tempRoot, '.tmp-lease-double-release.md')
			const result = await writeTempFileComplete(target, new TextEncoder()
				.encode('x'))
			if (result.outcome !== 'written')
				throw new Error('unreachable: expected a successful write')

			const first = await result.lease.release()
			const second = await result.lease.release()
			expect(first)
				.toEqual({ outcome: 'released' })
			expect(second)
				.toEqual({ outcome: 'released' })
		})

		it('fstatLive returns undefined once the leased file\'s last pathname link is removed (nlink reaches zero), even though the handle itself is still open', async () => {
			const target = path.join(tempRoot, '.tmp-lease-unlinked.md')
			const result = await writeTempFileComplete(target, new TextEncoder()
				.encode('unlinked content'))
			if (result.outcome !== 'written')
				throw new Error('unreachable: expected a successful write')

			// Node opens the handle with Windows' `FILE_SHARE_DELETE` sharing
			// flag by default, so this real, unmocked removal succeeds while
			// the lease's handle is still open on every platform this package
			// targets.
			fs.unlinkSync(target)

			expect(await result.lease.fstatLive())
				.toBeUndefined()

			await result.lease.release()
		})

		it('fstatLive reports undefined -- never the foreign file\'s own identity -- once the original temp file is removed and a byte-identical foreign file is installed at the same basename', async () => {
			const target = path.join(tempRoot, '.tmp-lease-aba.md')
			const bytes = new TextEncoder()
				.encode('original content')
			const result = await writeTempFileComplete(target, bytes)
			if (result.outcome !== 'written')
				throw new Error('unreachable: expected a successful write')

			const originalIdentity = result.lease.identity

			fs.unlinkSync(target)
			fs.writeFileSync(target, bytes) // byte-for-byte identical foreign replacement
			const foreignIdentity = { dev: fs.statSync(target).dev, ino: fs.statSync(target).ino }

			// While the lease's handle stays open, POSIX guarantees the
			// original inode cannot have been recycled for the foreign file
			// above -- the two identities are necessarily distinct, in
			// reality, with no forcing required. `fstatLive()` reports
			// `undefined` (the original file's last pathname link is gone,
			// `nlink === 0`) rather than either identity, so a caller
			// comparing it against a fresh pathname observation of `target`
			// (which would report `foreignIdentity`) can never conclude a
			// match either way -- exactly the fail-closed behavior
			// `fileOwnershipProven` (`application/artifact-create.ts`) relies
			// on.
			expect(foreignIdentity)
				.not.toEqual(originalIdentity)
			expect(await result.lease.fstatLive())
				.toBeUndefined()

			await result.lease.release()
		})

		// Finding 2 (P1, sixteenth round): a rejection from the creating
		// handle's own `close()` must never override `writeTempFileComplete`'s
		// already-decided `{ outcome: 'failed', error }` result -- the write
		// itself failed first, and that is the error a caller needs to see.
		it('reports the ORIGINAL write failure, not a close() rejection, when both the write and the cleanup close fail', async () => {
			const target = path.join(tempRoot, '.tmp-write-and-close-fail.md')
			const writeError = Object.assign(new Error('input/output error'), { code: 'EIO' })
			const closeError = Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })

			openMock.mockImplementationOnce(async (...args: Parameters<typeof fs.promises.open>) => {
				const real = await fs.promises.open(...args)
				return {
					writeFile: async () => {
						throw writeError
					},
					sync: real.sync.bind(real),
					stat: real.stat.bind(real),
					read: real.read.bind(real),
					close: async () => {
						await real.close()
						throw closeError
					},
				} as unknown as FileHandle
			})

			const result = await writeTempFileComplete(target, new TextEncoder()
				.encode('x'))

			expect(result)
				.toEqual({ outcome: 'failed', error: writeError })
		})
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
