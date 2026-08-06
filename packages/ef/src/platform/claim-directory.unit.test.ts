import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimDirectory } from './claim-directory'

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('claimDirectory', () => {
	it('claims a previously absent directory with one non-recursive mkdir', async () => {
		const target = path.join(tempRoot, '.engineering')
		const result = await claimDirectory(target)
		expect(result)
			.toEqual({ outcome: 'claimed' })
		expect(fs.statSync(target)
			.isDirectory())
			.toBe(true)
	})

	it('reports already-exists without modifying a directory claimed by a previous call', async () => {
		const target = path.join(tempRoot, '.engineering')
		const first = await claimDirectory(target)
		expect(first)
			.toEqual({ outcome: 'claimed' })

		fs.writeFileSync(path.join(target, 'marker.txt'), 'owned-by-first')

		const second = await claimDirectory(target)
		expect(second)
			.toEqual({ outcome: 'already-exists' })
		expect(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'))
			.toBe('owned-by-first')
	})

	it('reports already-exists when the path exists but is a regular file', async () => {
		const target = path.join(tempRoot, 'not-a-directory')
		fs.writeFileSync(target, 'x')

		const result = await claimDirectory(target)
		expect(result)
			.toEqual({ outcome: 'already-exists' })
	})

	it('does not create intermediate directories: reports a failure for a missing parent', async () => {
		const target = path.join(tempRoot, 'missing-parent', '.engineering')

		const result = await claimDirectory(target)
		expect(result.outcome)
			.toBe('failed')
		expect(fs.existsSync(target))
			.toBe(false)
	})

	it('lets exactly one of two concurrent claims win the race', async () => {
		const target = path.join(tempRoot, '.engineering')

		const [first, second] = await Promise.all([
			claimDirectory(target),
			claimDirectory(target),
		])

		const outcomes = [first.outcome, second.outcome].sort()
		expect(outcomes)
			.toEqual(['already-exists', 'claimed'])
		expect(fs.statSync(target)
			.isDirectory())
			.toBe(true)
	})
})
