import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimDirectory } from './claim-directory'

// `mkdirMock` lets a test inject an attacker action strictly inside the one
// residual window `claimDirectory` itself cannot close: between the real
// `mkdir` returning and its own immediate ownership-proving `lstat`/`readdir`
// (see the module's own documentation). Every test that does not explicitly
// arm it gets a plain passthrough to the real `mkdir`.
const { mkdirMock, realFns } = vi.hoisted(() => ({
	mkdirMock: vi.fn(),
	realFns: { mkdir: undefined as unknown as typeof import('node:fs/promises').mkdir },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	realFns.mkdir = actual.mkdir
	mkdirMock.mockImplementation((...args: Parameters<typeof actual.mkdir>) => actual.mkdir(...args))
	return { ...actual, mkdir: mkdirMock }
})

let tempRoot: string

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-'))
	mkdirMock.mockImplementation((...args: Parameters<typeof realFns.mkdir>) => realFns.mkdir(...args))
})

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true })
	mkdirMock.mockClear()
})

describe('claimDirectory', () => {
	it('claims a previously absent directory with one non-recursive mkdir, returning the claimed directory\'s own identity', async () => {
		const target = path.join(tempRoot, '.engineering')
		const result = await claimDirectory(target)
		expect(result.outcome)
			.toBe('claimed')
		const stats = fs.statSync(target)
		expect(stats.isDirectory())
			.toBe(true)
		expect(result.outcome === 'claimed' && result.identity)
			.toEqual({ dev: stats.dev, ino: stats.ino })
	})

	it('reports already-exists without modifying a directory claimed by a previous call', async () => {
		const target = path.join(tempRoot, '.engineering')
		const first = await claimDirectory(target)
		expect(first.outcome)
			.toBe('claimed')

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

	// FINDING 1 (P0): `mkdir` succeeding alone is not ownership. `claimDirectory`
	// must establish ownership itself, immediately, and fail closed WITHOUT any
	// destructive cleanup when it cannot -- never delete whatever now occupies
	// `path`, since that might be a real, pre-existing victim.
	describe('fails closed without destructive cleanup when ownership cannot be proven immediately after mkdir (Finding 1)', () => {
		it('reports claim-unprovable and leaves a pre-populated real victim substituted for the newly claimed directory completely untouched', async () => {
			const target = path.join(tempRoot, '.engineering')

			mkdirMock.mockImplementation(async (...args: Parameters<typeof realFns.mkdir>) => {
				await realFns.mkdir(...args)
				// Simulate an attacker race landing strictly inside the window
				// between `mkdir` returning and this function's own ownership-proving
				// observation: replace the just-created EMPTY directory with a real,
				// pre-populated victim directory at the identical path.
				await fs.promises.rm(target, { recursive: true, force: true })
				await fs.promises.mkdir(target)
				await fs.promises.writeFile(path.join(target, 'victim-marker.txt'), 'pre-existing victim data')
			})

			const result = await claimDirectory(target)

			expect(result.outcome)
				.toBe('claim-unprovable')
			expect(fs.statSync(target)
				.isDirectory())
				.toBe(true)
			expect(fs.readFileSync(path.join(target, 'victim-marker.txt'), 'utf8'))
				.toBe('pre-existing victim data')
		})

		it('reports claim-unprovable and neither follows nor removes a symlink substituted for the newly claimed directory', async () => {
			const target = path.join(tempRoot, '.engineering')
			const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-claim-outside-'))
			fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'must not be disturbed')

			try {
				mkdirMock.mockImplementation(async (...args: Parameters<typeof realFns.mkdir>) => {
					await realFns.mkdir(...args)
					await fs.promises.rm(target, { recursive: true, force: true })
					await fs.promises.symlink(outsideDir, target)
				})

				const result = await claimDirectory(target)

				expect(result.outcome)
					.toBe('claim-unprovable')
				expect(fs.lstatSync(target)
					.isSymbolicLink())
					.toBe(true)
				expect(fs.existsSync(outsideDir))
					.toBe(true)
				expect(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8'))
					.toBe('must not be disturbed')
			}
			finally {
				fs.rmSync(outsideDir, { recursive: true, force: true })
			}
		})

		it('reports claim-unprovable (not claimed) for a non-empty directory substituted for the newly claimed empty one, without deleting its contents', async () => {
			const target = path.join(tempRoot, '.engineering')

			mkdirMock.mockImplementation(async (...args: Parameters<typeof realFns.mkdir>) => {
				await realFns.mkdir(...args)
				await fs.promises.writeFile(path.join(target, 'already-here.txt'), 'not created by this invocation')
			})

			const result = await claimDirectory(target)

			expect(result.outcome)
				.toBe('claim-unprovable')
			expect(fs.readFileSync(path.join(target, 'already-here.txt'), 'utf8'))
				.toBe('not created by this invocation')
		})
	})
})
