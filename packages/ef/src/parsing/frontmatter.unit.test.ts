import { describe, expect, it } from 'vitest'
import { isMap } from 'yaml'
import { parseFrontmatterDocument, splitFrontmatter } from './frontmatter'

const MINIMAL_REQ_ENVELOPE = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
`

function minimalEnvelopeSource(body = '# Search Result Filtering\n'): string {
	return `---\n${MINIMAL_REQ_ENVELOPE}---\n${body}`
}

describe('splitFrontmatter', () => {
	it('extracts frontmatter text, body text, and bodyStartLine from a minimal valid envelope', () => {
		const result = splitFrontmatter(minimalEnvelopeSource())

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.frontmatterText)
			.toBe(MINIMAL_REQ_ENVELOPE)
		expect(result.bodyText)
			.toBe('# Search Result Filtering\n')
		expect(result.bodyStartLine)
			.toBe(12)
	})

	it('handles CRLF line endings when detecting the delimiter boundary', () => {
		const source = '---\r\nschema: ef/requirement@1\r\n---\r\nbody\r\n'
		const result = splitFrontmatter(source)

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		// Line terminators within the extracted text are preserved verbatim
		// (not normalized); only the boundary-detection logic is CRLF-tolerant.
		expect(result.frontmatterText)
			.toBe('schema: ef/requirement@1\r\n')
		expect(result.bodyText)
			.toBe('body\r\n')
		expect(result.bodyStartLine)
			.toBe(4)
	})

	it('reports EF-ENV-001 when the file does not start with a delimiter line', () => {
		const result = splitFrontmatter('# Title\n---\nschema: x\n---\n')

		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.diagnostic)
			.toEqual({
				code: 'EF-ENV-001',
				severity: 'error',
				message: 'Frontmatter is missing; the file must begin with a \'---\' line.',
				path: undefined,
				field: undefined,
				location: { line: 1, column: 1 },
				related: [],
			})
	})

	it('reports EF-ENV-001 for a completely empty file', () => {
		const result = splitFrontmatter('')

		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.diagnostic.code)
			.toBe('EF-ENV-001')
		expect(result.diagnostic.message)
			.toContain('missing')
	})

	it('reports EF-ENV-001 when the closing delimiter is never found', () => {
		const result = splitFrontmatter('---\nschema: ef/requirement@1\ntitle: X\n')

		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.diagnostic)
			.toEqual({
				code: 'EF-ENV-001',
				severity: 'error',
				message: 'Frontmatter is unterminated; no closing \'---\' line was found.',
				path: undefined,
				field: undefined,
				location: { line: 1, column: 1 },
				related: [],
			})
	})

	it('accepts trailing spaces and tabs on the delimiter lines', () => {
		const result = splitFrontmatter('---  \nschema: x\n---\t\nbody\n')

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.frontmatterText)
			.toBe('schema: x\n')
		expect(result.bodyText)
			.toBe('body\n')
	})

	it('rejects a first line with extra dashes as a delimiter (----)', () => {
		const result = splitFrontmatter('----\nschema: x\n---\n')

		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.diagnostic.code)
			.toBe('EF-ENV-001')
		expect(result.diagnostic.message)
			.toContain('missing')
	})

	it('rejects a first line with trailing non-whitespace content (--- foo)', () => {
		const result = splitFrontmatter('--- foo\nschema: x\n---\n')

		expect(result.ok)
			.toBe(false)
		if (result.ok)
			return
		expect(result.diagnostic.code)
			.toBe('EF-ENV-001')
	})

	it('does not treat an indented \'---\' inside frontmatter content as the closing delimiter', () => {
		const source = '---\nsummary: |\n  Section break below.\n  ---\n  More text.\n---\nbody\n'
		const result = splitFrontmatter(source)

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.frontmatterText)
			.toBe('summary: |\n  Section break below.\n  ---\n  More text.\n')
		expect(result.bodyText)
			.toBe('body\n')
	})

	it('supports an empty frontmatter between back-to-back delimiters', () => {
		const result = splitFrontmatter('---\n---\nbody\n')

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.frontmatterText)
			.toBe('')
		expect(result.bodyText)
			.toBe('body\n')
		expect(result.bodyStartLine)
			.toBe(3)
	})

	it('returns an empty bodyText when the file ends immediately after the closing delimiter', () => {
		const result = splitFrontmatter('---\nschema: x\n---')

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.bodyText)
			.toBe('')
		expect(result.bodyStartLine)
			.toBe(4)
	})

	it('preserves multi-byte and astral-plane characters verbatim in the extracted text', () => {
		const result = splitFrontmatter('---\nsummary: café \u{1F600}\n---\nbody \u{1F600}\n')

		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.frontmatterText)
			.toBe('summary: café \u{1F600}\n')
		expect(result.bodyText)
			.toBe('body \u{1F600}\n')
	})
})

describe('parseFrontmatterDocument', () => {
	it('parses a minimal valid envelope with no diagnostics and exposes the mapping generically', () => {
		const { document, mapping, diagnostics } = parseFrontmatterDocument(MINIMAL_REQ_ENVELOPE, 'REQ-031.md')

		expect(diagnostics)
			.toEqual([])
		expect(mapping)
			.toBeDefined()
		expect(mapping && isMap(mapping))
			.toBe(true)
		expect(document.contents)
			.toBe(mapping)
		expect(mapping?.get('id'))
			.toBe('REQ-031')
		expect(mapping?.items.map(pair => (pair.key as { value: unknown }).value))
			.toEqual(['schema', 'type', 'id', 'title', 'status', 'summary', 'tags', 'relations', 'resources'])
	})

	it('does not flag field-level type mismatches, which are another module\'s responsibility', () => {
		const { diagnostics, mapping } = parseFrontmatterDocument('tags: search\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([])
		expect(mapping)
			.toBeDefined()
	})

	it('reports EF-ENV-002 when the frontmatter is empty', () => {
		const { diagnostics, mapping } = parseFrontmatterDocument('', 'REQ-031.md')

		expect(mapping)
			.toBeUndefined()
		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-002',
				severity: 'error',
				message: 'Frontmatter must contain exactly one top-level YAML mapping.',
				path: 'REQ-031.md',
				field: undefined,
				location: { line: 1, column: 1 },
				related: [],
			}])
	})

	it('reports EF-ENV-002 when the top-level node is a scalar', () => {
		const { diagnostics, mapping } = parseFrontmatterDocument('just a string\n', 'REQ-031.md')

		expect(mapping)
			.toBeUndefined()
		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-002',
				severity: 'error',
				message: 'Frontmatter must contain exactly one top-level YAML mapping.',
				path: 'REQ-031.md',
				field: undefined,
				location: { line: 1, column: 1 },
				related: [],
			}])
	})

	it('reports EF-ENV-002 when the top-level node is a sequence', () => {
		const { diagnostics, mapping } = parseFrontmatterDocument('- a\n- b\n', 'REQ-031.md')

		expect(mapping)
			.toBeUndefined()
		expect(diagnostics)
			.toHaveLength(1)
		expect(diagnostics[0]!.code)
			.toBe('EF-ENV-002')
		expect(diagnostics[0]!.location)
			.toEqual({ line: 1, column: 1 })
	})

	it('maps a general YAML structural error (MULTIPLE_TAGS) to EF-ENV-002', () => {
		const { diagnostics } = parseFrontmatterDocument('value: !!str !!int 1\n', 'REQ-031.md')

		expect(diagnostics)
			.toHaveLength(1)
		expect(diagnostics[0])
			.toMatchObject({
				code: 'EF-ENV-002',
				severity: 'error',
				path: 'REQ-031.md',
				location: { line: 1, column: 14 },
			})
		expect(diagnostics[0]!.message)
			.toContain('A node can have at most one tag')
	})

	it('reports EF-ENV-005 for a duplicate top-level mapping key with a related first-occurrence location', () => {
		const { diagnostics } = parseFrontmatterDocument('status: draft\nstatus: active\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-005',
				severity: 'error',
				message: 'Duplicate mapping key \'status\'.',
				path: 'REQ-031.md',
				field: 'status',
				location: { line: 2, column: 1 },
				related: [{
					path: 'REQ-031.md',
					field: 'status',
					location: { line: 1, column: 1 },
					message: 'First occurrence of key \'status\'.',
				}],
			}])
	})

	it('detects a duplicate key nested inside an array-of-mappings entry, with a structured field path', () => {
		const source = 'relations:\n  - type: derived-from\n    type: references\n    target: PRD-012\n'
		const { diagnostics } = parseFrontmatterDocument(source, 'REQ-031.md')

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-005',
				severity: 'error',
				message: 'Duplicate mapping key \'type\'.',
				path: 'REQ-031.md',
				field: 'relations[0].type',
				location: { line: 3, column: 5 },
				related: [{
					path: 'REQ-031.md',
					field: 'relations[0].type',
					location: { line: 2, column: 5 },
					message: 'First occurrence of key \'type\'.',
				}],
			}])
	})

	it('reports EF-ENV-010 for a YAML anchor', () => {
		const { diagnostics } = parseFrontmatterDocument('foo: &a bar\nbaz: qux\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-010',
				severity: 'error',
				message: 'YAML anchor \'&a\' is a forbidden construct in the artifact envelope.',
				path: 'REQ-031.md',
				field: 'foo',
				location: { line: 1, column: 9 },
				related: [],
			}])
	})

	it('reports EF-ENV-010 for both a YAML anchor and the alias that references it', () => {
		const { diagnostics } = parseFrontmatterDocument('foo: &a bar\nbaz: *a\n', 'REQ-031.md')

		expect(diagnostics)
			.toHaveLength(2)
		expect(diagnostics)
			.toContainEqual({
				code: 'EF-ENV-010',
				severity: 'error',
				message: 'YAML anchor \'&a\' is a forbidden construct in the artifact envelope.',
				path: 'REQ-031.md',
				field: 'foo',
				location: { line: 1, column: 9 },
				related: [],
			})
		expect(diagnostics)
			.toContainEqual({
				code: 'EF-ENV-010',
				severity: 'error',
				message: 'YAML alias is a forbidden construct in the artifact envelope.',
				path: 'REQ-031.md',
				field: 'baz',
				location: { line: 2, column: 6 },
				related: [],
			})
	})

	it('reports EF-ENV-010 for a merge key even without an alias value', () => {
		const { diagnostics } = parseFrontmatterDocument('<<: {x: 1}\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-010',
				severity: 'error',
				message: 'YAML merge key \'<<\' is a forbidden construct in the artifact envelope.',
				path: 'REQ-031.md',
				field: '<<',
				location: { line: 1, column: 1 },
				related: [],
			}])
	})

	it('reports EF-ENV-010 for a custom (non-standard) YAML tag', () => {
		const { diagnostics } = parseFrontmatterDocument('value: !mytag foo\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-010',
				severity: 'error',
				message: 'YAML custom tag \'!mytag\' is a forbidden construct in the artifact envelope.',
				path: 'REQ-031.md',
				field: 'value',
				location: { line: 1, column: 15 },
				related: [],
			}])
	})

	it('does not flag a standard explicit core-schema tag (!!int)', () => {
		const { diagnostics } = parseFrontmatterDocument('count: !!int "42"\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([])
	})

	it('does not flag a plain implicitly-typed scalar (no explicit tag)', () => {
		const { diagnostics } = parseFrontmatterDocument('count: 42\n', 'REQ-031.md')

		expect(diagnostics)
			.toEqual([])
	})

	it('computes one-based Unicode-scalar columns, not UTF-16 code units, across an astral-plane character', () => {
		const source = '{title: \u{1F600} lorem, count: 1}'
		const { mapping, locate } = parseFrontmatterDocument(source, 'REQ-031.md')

		expect(mapping)
			.toBeDefined()
		const countKey = mapping!.items[1]!.key as { range: [number, number, number] }
		// Raw UTF-16 offset is 18; the astral character collapses two UTF-16
		// units into one Unicode scalar value, so the column must also be 18
		// (not 19, which a UTF-16-based implementation would produce).
		expect(countKey.range[0])
			.toBe(18)
		expect(locate(countKey as never))
			.toEqual({ line: 1, column: 18 })
	})

	it('offsets locations by the startLine option to match the enclosing file', () => {
		const source = 'status: draft\nstatus: active\n'
		const withoutOffset = parseFrontmatterDocument(source, 'REQ-031.md')
		const withOffset = parseFrontmatterDocument(source, 'REQ-031.md', { startLine: 2 })

		expect(withoutOffset.diagnostics[0]!.location)
			.toEqual({ line: 2, column: 1 })
		expect(withOffset.diagnostics[0]!.location)
			.toEqual({ line: 3, column: 1 })
		expect(withOffset.diagnostics[0]!.related[0]!.location)
			.toEqual({ line: 2, column: 1 })
	})

	it('locate() returns undefined for a raw offset outside any known position and a null/undefined node', () => {
		const { locate } = parseFrontmatterDocument('schema: x\n', 'REQ-031.md')

		expect(locate(null))
			.toBeUndefined()
		expect(locate(undefined))
			.toBeUndefined()
	})

	it('full pipeline: splitFrontmatter output feeds parseFrontmatterDocument with startLine 2', () => {
		const source = '---\nstatus: draft\nstatus: active\n---\nbody\n'
		const split = splitFrontmatter(source)
		expect(split.ok)
			.toBe(true)
		if (!split.ok)
			return

		expect(split.bodyStartLine)
			.toBe(5)

		const { diagnostics } = parseFrontmatterDocument(split.frontmatterText, 'REQ-031.md', { startLine: 2 })

		expect(diagnostics)
			.toEqual([{
				code: 'EF-ENV-005',
				severity: 'error',
				message: 'Duplicate mapping key \'status\'.',
				path: 'REQ-031.md',
				field: 'status',
				location: { line: 3, column: 1 },
				related: [{
					path: 'REQ-031.md',
					field: 'status',
					location: { line: 2, column: 1 },
					message: 'First occurrence of key \'status\'.',
				}],
			}])
	})
})
