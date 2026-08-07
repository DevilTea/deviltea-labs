import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExclusive, readInitMarker, writeInitMarker } from './exclusive-file'
import { generateNonce } from './nonce'

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
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

		// Finding (P0, matching `hard-link-publish.ts`'s `writeTempFileComplete`
		// finding): `identity` and `bytes` are captured from the exact
		// `open(target, 'wx+')` handle this call created -- via `handle.stat()`
		// and a read back through that same handle -- BEFORE it closes, never
		// re-derived from a later, independent pathname observation of `target`.
		if (result.outcome !== 'created')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(result.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(new Uint8Array(result.bytes))
			.toEqual(bytes)
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

	it('captures identity and a correct read-back even for a zero-byte file', async () => {
		const target = path.join(tempRoot, 'empty.json')
		const result = await createExclusive(target, new Uint8Array())
		if (result.outcome !== 'created')
			throw new Error('unreachable: expected a successful create')

		expect(result.bytes.length)
			.toBe(0)
		const stats = fs.statSync(target)
		expect(result.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
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
		// the same handle-bound `identity`/`bytes` through (Finding P0).
		if (writeResult.outcome !== 'created')
			throw new Error('unreachable: asserted above')
		const stats = fs.statSync(target)
		expect(writeResult.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
		expect(JSON.parse(Buffer.from(writeResult.bytes)
			.toString('utf8')))
			.toEqual({ schema: 'ef/init-state@1', nonce })

		const readResult = await readInitMarker(target)
		expect(readResult)
			.toEqual({ outcome: 'found', marker: { schema: 'ef/init-state@1', nonce } })
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
		await writeInitMarker(target, firstNonce)

		const secondNonce = generateNonce()
		const result = await writeInitMarker(target, secondNonce)
		expect(result)
			.toEqual({ outcome: 'already-exists' })

		const readResult = await readInitMarker(target)
		expect(readResult)
			.toEqual({ outcome: 'found', marker: { schema: 'ef/init-state@1', nonce: firstNonce } })
	})
})
