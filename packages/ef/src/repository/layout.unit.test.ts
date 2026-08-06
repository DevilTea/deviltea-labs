import type { WalkEntry } from '../platform/fs-facts'
import { describe, expect, it } from 'vitest'
import { listArtifactFiles } from './layout'

function file(relativePath: string): WalkEntry {
	return { relativePath, isRegularFile: true, isDirectory: false, isSymlink: false }
}

function dir(relativePath: string): WalkEntry {
	return { relativePath, isRegularFile: false, isDirectory: true, isSymlink: false }
}

function symlink(relativePath: string): WalkEntry {
	return { relativePath, isRegularFile: false, isDirectory: false, isSymlink: true }
}

describe('listArtifactFiles', () => {
	it('finds PROJECT.md plus every *.md directly inside the five canonical directories', () => {
		const result = listArtifactFiles([
			file('PROJECT.md'),
			file('ef.yaml'),
			file('.gitignore'),
			dir('prd'),
			file('prd/PRD-001.md'),
			dir('req'),
			file('req/REQ-031.md'),
			file('req/REQ-032.md'),
			dir('adr'),
			file('adr/ADR-001.md'),
			dir('pol'),
			file('pol/POL-001.md'),
			dir('chg'),
			file('chg/CHG-001.md'),
			dir('resources'),
		])

		expect(result.diagnostics)
			.toEqual([])
		expect(result.artifactFiles)
			.toEqual([
				'.engineering/PROJECT.md',
				'.engineering/adr/ADR-001.md',
				'.engineering/chg/CHG-001.md',
				'.engineering/pol/POL-001.md',
				'.engineering/prd/PRD-001.md',
				'.engineering/req/REQ-031.md',
				'.engineering/req/REQ-032.md',
			])
	})

	it('returns an empty result for an .engineering with no entries at all', () => {
		const result = listArtifactFiles([])
		expect(result)
			.toEqual({ artifactFiles: [], diagnostics: [] })
	})

	it('tolerates absent canonical directories (Git does not preserve empty directories)', () => {
		const result = listArtifactFiles([file('PROJECT.md')])
		expect(result.diagnostics)
			.toEqual([])
		expect(result.artifactFiles)
			.toEqual(['.engineering/PROJECT.md'])
	})

	describe('control files, resources, and runtime paths are out of scope', () => {
		it('does not flag ef.yaml, .gitignore, resources/**, or the four runtime paths', () => {
			const result = listArtifactFiles([
				file('ef.yaml'),
				file('.gitignore'),
				dir('resources'),
				dir('resources/REQ-031'),
				file('resources/REQ-031/schema.json'),
				file('resources/orphan.txt'),
				dir('.cache'),
				file('.cache/anything'),
				dir('.generated'),
				file('.generated/anything'),
				dir('.tmp'),
				file('.tmp/init-state.json'),
				file('.lock'),
			])
			expect(result.diagnostics)
				.toEqual([])
			expect(result.artifactFiles)
				.toEqual([])
		})
	})

	describe('eF-FS-003 unexpected entries', () => {
		it('reports an unexpected top-level file', () => {
			const result = listArtifactFiles([file('README.md')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', severity: 'error', path: '.engineering/README.md' }),
				])
			expect(result.artifactFiles)
				.toEqual([])
		})

		it('reports an unexpected top-level directory once and suppresses its descendants', () => {
			const result = listArtifactFiles([
				dir('notes'),
				file('notes/a.md'),
				dir('notes/sub'),
				file('notes/sub/b.md'),
			])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/notes' }),
				])
		})

		it('reports a non-.md file directly inside a canonical directory', () => {
			const result = listArtifactFiles([dir('req'), file('req/notes.txt')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/req/notes.txt' }),
				])
		})

		it('reports an uppercase .MD extension as non-canonical', () => {
			const result = listArtifactFiles([dir('req'), file('req/REQ-031.MD')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/req/REQ-031.MD' }),
				])
		})

		it('reports a subdirectory nested inside a canonical directory, and suppresses its descendants', () => {
			const result = listArtifactFiles([
				dir('req'),
				dir('req/archive'),
				file('req/archive/REQ-999.md'),
			])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/req/archive' }),
				])
		})

		it('reports a canonical directory name that is actually a regular file', () => {
			const result = listArtifactFiles([file('req')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/req' }),
				])
		})

		it('reports a runtime path name that is actually a regular file, not a directory', () => {
			const result = listArtifactFiles([file('.cache')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/.cache' }),
				])
		})

		it('reports "resources" when it is a regular file rather than a directory', () => {
			const result = listArtifactFiles([file('resources')])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/resources' }),
				])
		})

		it('does not treat PROJECT.md as unexpected when it is a directory or symlink (a different owning check applies)', () => {
			expect(listArtifactFiles([dir('PROJECT.md')]).diagnostics)
				.toEqual([])
			expect(listArtifactFiles([symlink('PROJECT.md')]).diagnostics)
				.toEqual([])
			expect(listArtifactFiles([dir('PROJECT.md')]).artifactFiles)
				.toEqual([])
		})

		it('reports a synthetic entry deeper than a direct canonical-directory child (defensive, non-recursive-walk input)', () => {
			const result = listArtifactFiles([{ relativePath: 'req/sub/deep.md', isRegularFile: true, isDirectory: false, isSymlink: false }])
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-003', path: '.engineering/req/sub/deep.md' }),
				])
		})
	})

	it('sorts artifactFiles bytewise, with PROJECT.md first', () => {
		const result = listArtifactFiles([
			file('PROJECT.md'),
			dir('req'),
			file('req/REQ-002.md'),
			file('req/REQ-001.md'),
			dir('adr'),
			file('adr/ADR-001.md'),
		])
		expect(result.artifactFiles)
			.toEqual([
				'.engineering/PROJECT.md',
				'.engineering/adr/ADR-001.md',
				'.engineering/req/REQ-001.md',
				'.engineering/req/REQ-002.md',
			])
	})
})
