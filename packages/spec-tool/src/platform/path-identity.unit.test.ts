import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeForComparison, isSameLocation } from './path-identity'

describe('canonicalizeForComparison (pure string normalization)', () => {
	it('normalizes backslash separators to forward slashes', () => {
		expect(canonicalizeForComparison('C:\\Users\\example\\project'))
			.toBe('c:/Users/example/project')
	})

	it('treats a forward-slash and a backslash form of the identical path as equal', () => {
		const forwardSlashForm = canonicalizeForComparison('C:/Users/example/project')
		const backslashForm = canonicalizeForComparison('C:\\Users\\example\\project')
		expect(forwardSlashForm)
			.toBe(backslashForm)
	})

	it('lower-cases a leading drive letter regardless of the source form\'s case', () => {
		expect(canonicalizeForComparison('C:/Users/example/project'))
			.toBe(canonicalizeForComparison('c:/Users/example/project'))
	})

	it('strips a Windows \\\\?\\ long-path prefix before normalizing', () => {
		expect(canonicalizeForComparison('\\\\?\\C:\\Users\\example\\project'))
			.toBe('c:/Users/example/project')
	})

	it('leaves an ordinary POSIX path untouched aside from pathe normalization', () => {
		expect(canonicalizeForComparison('/tmp/does-not-exist/nested'))
			.toBe('/tmp/does-not-exist/nested')
	})

	it('falls back to the normalized input, unresolved, when the path does not exist', () => {
		const missing = path.join(os.tmpdir(), 'ef-path-identity-does-not-exist', 'nested')
		expect(canonicalizeForComparison(missing))
			.toBe(missing.replaceAll('\\', '/'))
	})
})

describe('isSameLocation (pure string comparison)', () => {
	it('reports true for the same path in different separator styles', () => {
		expect(isSameLocation('C:/Users/example/project', 'C:\\Users\\example\\project'))
			.toBe(true)
	})

	it('reports true for the same path with different drive-letter case', () => {
		// Only the drive letter's case is unified; the rest of the path is
		// compared verbatim (callers that need whole-path case-insensitive
		// comparison rely on the filesystem-backed realpath resolution
		// exercised in the "real filesystem" suite below).
		expect(isSameLocation('C:/Users/example/project', 'c:/Users/example/project'))
			.toBe(true)
	})

	it('reports false for genuinely different paths', () => {
		expect(isSameLocation('/tmp/a', '/tmp/b'))
			.toBe(false)
	})
})

describe('canonicalizeForComparison / isSameLocation (real filesystem, POSIX)', () => {
	let tempRoot: string

	beforeEach(() => {
		tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ef-test-')))
	})

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	})

	it('resolves a symlinked directory to the same canonical form as its real target', () => {
		const realDir = path.join(tempRoot, 'real')
		fs.mkdirSync(realDir)
		const linkDir = path.join(tempRoot, 'link')
		fs.symlinkSync(realDir, linkDir, 'dir')

		expect(isSameLocation(realDir, linkDir))
			.toBe(true)
	})

	it('resolves a nested path reached through a symlinked ancestor to the same location', () => {
		const realDir = path.join(tempRoot, 'real')
		fs.mkdirSync(path.join(realDir, 'nested'), { recursive: true })
		const linkDir = path.join(tempRoot, 'link')
		fs.symlinkSync(realDir, linkDir, 'dir')

		const throughSymlink = path.join(linkDir, 'nested')
		const direct = path.join(realDir, 'nested')
		expect(isSameLocation(throughSymlink, direct))
			.toBe(true)
	})

	it('reports false for two distinct real directories, even both freshly realpath-resolved', () => {
		const dirA = path.join(tempRoot, 'a')
		const dirB = path.join(tempRoot, 'b')
		fs.mkdirSync(dirA)
		fs.mkdirSync(dirB)

		expect(isSameLocation(dirA, dirB))
			.toBe(false)
	})
})
