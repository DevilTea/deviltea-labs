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
		expect(result)
			.toEqual({ outcome: 'created' })
		expect(new Uint8Array(fs.readFileSync(target)))
			.toEqual(bytes)
	})

	it('reports already-exists and leaves the original bytes untouched on collision', async () => {
		const target = path.join(tempRoot, 'init-state.json')
		const first = new TextEncoder()
			.encode('first-owner-bytes')
		const second = new TextEncoder()
			.encode('second-owner-bytes-different-length')

		const firstResult = await createExclusive(target, first)
		expect(firstResult)
			.toEqual({ outcome: 'created' })

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
		expect(writeResult)
			.toEqual({ outcome: 'created' })

		const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown
		expect(raw)
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
