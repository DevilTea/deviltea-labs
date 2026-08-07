import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExclusive, readInitMarker, writeInitMarker } from './exclusive-file'
import { generateNonce } from './nonce'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	openMock.mockImplementation((...args: Parameters<typeof actual.open>) => actual.open(...args))
	return { ...actual, open: openMock }
})

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
	openMock.mockClear()
})

describe('createExclusive', () => {
	it('creates a previously absent file with exactly the given bytes', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const bytes = new TextEncoder()
			.encode('{"schema":"ef/init-state@1","nonce":"aa"}')

		const result = await createExclusive(target, bytes)
		expect(result.outcome)
			.toBe('created')
		expect(new Uint8Array(fs.readFileSync(target)))
			.toEqual(bytes)

		// Finding (P0, fifteenth round): identity/bytes are captured from the
		// exact `open(target, 'wx+')` handle this call created -- via
		// `handle.stat()` and a read back through that same handle -- before
		// it is ever closed. Sixteenth round: they are exposed through the
		// returned `OwnedFileLease`, whose creating handle stays open rather
		// than being closed here (see the dedicated describe block below).
		if (result.outcome !== 'created')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(result.lease.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(new Uint8Array(result.lease.bytes))
			.toEqual(bytes)

		await result.lease.release()
	})

	it('returns a distinct identity for two exclusive files created in the same call sequence, both matching their own on-disk stat', async () => {
		const targetA = path.join(tempRoot, 'a.json')
		const targetB = path.join(tempRoot, 'b.json')
		const bytesA = new TextEncoder()
			.encode('A')
		const bytesB = new TextEncoder()
			.encode('B')

		const resultA = await createExclusive(targetA, bytesA)
		const resultB = await createExclusive(targetB, bytesB)
		if (resultA.outcome !== 'created' || resultB.outcome !== 'created')
			throw new Error('unreachable: both creates are expected to succeed')

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

	it('captures identity and a correct read-back even for a zero-byte file', async () => {
		const target = path.join(tempRoot, 'empty.json')
		const result = await createExclusive(target, new Uint8Array())
		if (result.outcome !== 'created')
			throw new Error('unreachable: expected a successful create')

		expect(result.lease.bytes.length)
			.toBe(0)
		const stats = fs.statSync(target)
		expect(result.lease.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })

		await result.lease.release()
	})

	it('reports already-exists and leaves the original bytes untouched on collision', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const first = new TextEncoder()
			.encode('first-owner-bytes')
		const second = new TextEncoder()
			.encode('second-owner-bytes-different-length')

		const firstResult = await createExclusive(target, first)
		expect(firstResult.outcome)
			.toBe('created')
		if (firstResult.outcome === 'created')
			await firstResult.lease.release()

		const secondResult = await createExclusive(target, second)
		expect(secondResult)
			.toEqual({ outcome: 'already-exists' })
		expect(new Uint8Array(fs.readFileSync(target)))
			.toEqual(first)
	})

	it('reports a non-collision failure distinctly, such as a missing parent directory', async () => {
		const target = path.join(tempRoot, 'missing-parent', 'init-state.json')
		const result = await createExclusive(target, new Uint8Array())
		expect(result.outcome)
			.toBe('failed')
	})

	it('lets exactly one of two concurrent creates win the race', async () => {
		const target = path.join(tempRoot, 'init-state.json')

		const [first, second] = await Promise.all([
			createExclusive(target, new TextEncoder()
				.encode('a')),
			createExclusive(target, new TextEncoder()
				.encode('b')),
		])

		const outcomes = [first.outcome, second.outcome].sort()
		expect(outcomes)
			.toEqual(['already-exists', 'created'])

		for (const result of [first, second]) {
			if (result.outcome === 'created')
				await result.lease.release()
		}
	})

	// Finding (P0, sixteenth round, matching `platform/hard-link-publish.ts`):
	// capturing identity/bytes from the creating handle and then closing it
	// before returning (the fifteenth-round fix) is still not enough -- once
	// closed, a recycled, byte-identical foreign replacement at the same path
	// can report the exact same `(dev, ino)`. The handle must stay open,
	// retained by the returned lease, for as long as a destructive ownership
	// decision might still be made against it.
	describe('ownedFileLease (Finding, sixteenth round)', () => {
		it('keeps the creating handle open on success: fstatLive reports the same identity right after the create, before release()', async () => {
			const target = path.join(tempRoot, 'lease.json')
			const result = await createExclusive(target, new TextEncoder()
				.encode('lease content'))
			if (result.outcome !== 'created')
				throw new Error('unreachable: expected a successful create')

			expect(await result.lease.fstatLive())
				.toEqual(result.lease.identity)

			await result.lease.release()
		})

		it('fstatLive returns undefined once the lease has been released', async () => {
			const target = path.join(tempRoot, 'lease-released.json')
			const result = await createExclusive(target, new TextEncoder()
				.encode('x'))
			if (result.outcome !== 'created')
				throw new Error('unreachable: expected a successful create')

			const releaseResult = await result.lease.release()
			expect(releaseResult)
				.toEqual({ outcome: 'released' })
			expect(await result.lease.fstatLive())
				.toBeUndefined()
		})

		it('fstatLive returns undefined -- never the foreign file\'s own identity -- once the original tracked file is removed and a byte-identical foreign file is installed at the same path', async () => {
			const target = path.join(tempRoot, 'lease-aba.json')
			const bytes = new TextEncoder()
				.encode('original content')
			const result = await createExclusive(target, bytes)
			if (result.outcome !== 'created')
				throw new Error('unreachable: expected a successful create')

			const originalIdentity = result.lease.identity

			fs.unlinkSync(target)
			fs.writeFileSync(target, bytes) // byte-for-byte identical foreign replacement
			const foreignIdentity = { dev: fs.statSync(target).dev, ino: fs.statSync(target).ino }

			expect(foreignIdentity)
				.not.toEqual(originalIdentity)
			expect(await result.lease.fstatLive())
				.toBeUndefined()

			await result.lease.release()
		})

		// Finding 2 (P1, sixteenth round): a rejection from the creating
		// handle's own `close()` must never override `createExclusive`'s
		// already-decided `{ outcome: 'failed', error }` result.
		it('reports the ORIGINAL write failure, not a close() rejection, when both the write and the cleanup close fail', async () => {
			const target = path.join(tempRoot, 'write-and-close-fail.json')
			const writeError = Object.assign(new Error('input/output error'), { code: 'EIO' })
			const closeError = Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })

			openMock.mockImplementationOnce(async (...args: Parameters<typeof fs.promises.open>) => {
				const real = await fs.promises.open(...args)
				return {
					writeFile: async () => {
						throw writeError
					},
					stat: real.stat.bind(real),
					read: real.read.bind(real),
					close: async () => {
						await real.close()
						throw closeError
					},
				} as unknown as FileHandle
			})

			const result = await createExclusive(target, new TextEncoder()
				.encode('x'))

			expect(result)
				.toEqual({ outcome: 'failed', error: writeError })
		})
	})
})

describe('writeInitMarker / readInitMarker', () => {
	it('round-trips the exact ef/init-state@1 shape', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const nonce = generateNonce()

		const writeResult = await writeInitMarker(target, nonce)
		expect(writeResult.outcome)
			.toBe('created')

		const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown
		expect(raw)
			.toEqual({ schema: 'ef/init-state@1', nonce })

		// `writeInitMarker` layers directly on `createExclusive`, so it carries
		// the same handle-bound, still-open lease through (Finding P0).
		if (writeResult.outcome !== 'created')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(writeResult.lease.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(JSON.parse(Buffer.from(writeResult.lease.bytes)
			.toString('utf8')))
			.toEqual({ schema: 'ef/init-state@1', nonce })

		const readResult = await readInitMarker(target)
		expect(readResult)
			.toEqual({ outcome: 'found', marker: { schema: 'ef/init-state@1', nonce } })

		await writeResult.lease.release()
	})

	it('reports missing for an absent marker path', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'missing' })
	})

	it('reports invalid for malformed JSON', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		fs.writeFileSync(target, '{not json')
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'invalid' })
	})

	it('reports invalid when the schema field does not match ef/init-state@1', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		fs.writeFileSync(target, JSON.stringify({ schema: 'ef/other@1', nonce: generateNonce() }))
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'invalid' })
	})

	it('reports invalid when nonce is not a 128-bit lowercase hexadecimal string', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		fs.writeFileSync(target, JSON.stringify({ schema: 'ef/init-state@1', nonce: 'NOT-HEX' }))
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'invalid' })
	})

	it('reports invalid when the parsed JSON value is not an object at all (e.g. a bare string)', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		fs.writeFileSync(target, JSON.stringify('just-a-string'))
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'invalid' })
	})

	it('reports invalid when the parsed JSON value is the literal null', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		fs.writeFileSync(target, 'null')
		const result = await readInitMarker(target)
		expect(result)
			.toEqual({ outcome: 'invalid' })
	})

	it('reports a non-ENOENT read failure distinctly rather than as missing', async () => {
		const target = path.join(tempRoot, 'a-directory')
		fs.mkdirSync(target)
		const result = await readInitMarker(target)
		expect(result.outcome)
			.toBe('failed')
		if (result.outcome === 'failed') {
			expect(result.error.code)
				.toBe('EISDIR')
		}
	})

	it('writeInitMarker reports already-exists rather than overwriting a marker from another invocation', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const firstNonce = generateNonce()
		const firstResult = await writeInitMarker(target, firstNonce)
		if (firstResult.outcome === 'created')
			await firstResult.lease.release()

		const secondNonce = generateNonce()
		const result = await writeInitMarker(target, secondNonce)
		expect(result)
			.toEqual({ outcome: 'already-exists' })

		const readResult = await readInitMarker(target)
		expect(readResult)
			.toEqual({ outcome: 'found', marker: { schema: 'ef/init-state@1', nonce: firstNonce } })
	})
})
