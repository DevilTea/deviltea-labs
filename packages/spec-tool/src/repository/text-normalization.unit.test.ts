import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { walkDirectory } from '../platform/fs-facts'
import { checkPathNormalization, checkTextNormalization } from './text-normalization'

const encoder = new TextEncoder()

describe('checkTextNormalization', () => {
	it('returns no diagnostics for a compliant file (UTF-8, LF, no BOM, one final newline)', () => {
		const bytes = encoder.encode('schema: ef/config@1\n')
		expect(checkTextNormalization('.engineering/ef.yaml', bytes))
			.toEqual([])
	})

	it('reports a leading UTF-8 BOM', () => {
		const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...encoder.encode('a\n')])
		const diagnostics = checkTextNormalization('.engineering/ef.yaml', bytes)
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-005', severity: 'error', path: '.engineering/ef.yaml', location: { line: 1, column: 1 } }),
			])
	})

	it('reports every CRLF line ending independently', () => {
		const bytes = encoder.encode('a\r\nb\r\nc\n')
		const diagnostics = checkTextNormalization('.engineering/.gitignore', bytes)
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-005', location: { line: 1, column: 1 } }),
				expect.objectContaining({ code: 'EF-FS-005', location: { line: 2, column: 1 } }),
			])
	})

	it('reports a missing final newline', () => {
		const bytes = encoder.encode('no trailing newline')
		const diagnostics = checkTextNormalization('.engineering/req/REQ-031.md', bytes)
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-005', path: '.engineering/req/REQ-031.md' }),
			])
	})

	it('reports invalid UTF-8', () => {
		const bytes = new Uint8Array([0x61, 0xFF, 0x0A])
		const diagnostics = checkTextNormalization('.engineering/req/REQ-031.md', bytes)
		expect(diagnostics.some(d => d.code === 'EF-FS-005' && d.message.includes('invalid UTF-8')))
			.toBe(true)
	})

	it('reports multiple independent violations for the same file', () => {
		const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x0D, 0x0A, 0x62])
		const diagnostics = checkTextNormalization('.engineering/ef.yaml', bytes)
		const messages = diagnostics.map(d => d.message)
		expect(messages.some(m => m.includes('byte-order mark')))
			.toBe(true)
		expect(messages.some(m => m.includes('CRLF')))
			.toBe(true)
		expect(messages.some(m => m.includes('final newline')))
			.toBe(true)
	})
})

describe('checkPathNormalization', () => {
	it('returns no diagnostics for a normalized, exactly matching path', () => {
		expect(checkPathNormalization([{ path: '.engineering/req/REQ-031.md', actualPath: '.engineering/req/REQ-031.md' }]))
			.toEqual([])
	})

	it('returns no diagnostics when there is no actual-path cross-reference and the path is already NFC', () => {
		expect(checkPathNormalization([{ path: '.engineering/req/REQ-031.md' }]))
			.toEqual([])
	})

	it('reports a path that is not Unicode NFC normalized', () => {
		const nfd = 'café'.normalize('NFD')
		const nfc = nfd.normalize('NFC')
		expect(nfd).not.toBe(nfc)
		const diagnostics = checkPathNormalization([{ path: `.engineering/resources/REQ-031/${nfd}.txt` }])
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-006', severity: 'error' }),
			])
	})

	it('reports a case mismatch between a declared path and its on-disk entry', () => {
		const diagnostics = checkPathNormalization([{ path: '.engineering/resources/REQ-031/File.png', actualPath: '.engineering/resources/REQ-031/file.png' }])
		expect(diagnostics)
			.toEqual([
				expect.objectContaining({ code: 'EF-FS-006', path: '.engineering/resources/REQ-031/File.png' }),
			])
	})

	it('does not double-report both non-NFC and case mismatch for the same entry', () => {
		const nfd = 'café'.normalize('NFD')
		const diagnostics = checkPathNormalization([{ path: nfd, actualPath: `${nfd}-different` }])
		expect(diagnostics)
			.toHaveLength(1)
		expect(diagnostics[0])
			.toMatchObject({ code: 'EF-FS-006' })
	})

	it('detects a real on-disk NFD-normalized filename created via raw bytes', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-test-'))
		try {
			const nfc = 'café'
			const nfd = nfc.normalize('NFD')
			expect(nfd).not.toBe(nfc)
			await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
			// Write using the raw NFD byte sequence directly so the on-disk name is
			// not silently renormalized by a higher-level string API.
			const filePath = Buffer.concat([
				Buffer.from(path.join(tempDir, '.engineering') + path.sep, 'utf8'),
				Buffer.from(`${nfd}.md`, 'utf8'),
			])
			await fs.writeFile(filePath, 'content\n')

			const entries = await walkDirectory(path.join(tempDir, '.engineering'))
			expect(entries)
				.toHaveLength(1)
			const discoveredName = entries[0]!.relativePath

			const diagnostics = checkPathNormalization([{ path: discoveredName }])
			expect(diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-006' }),
				])
		}
		finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
