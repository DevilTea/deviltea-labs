import type { Table } from './markdown'
import { describe, expect, it } from 'vitest'
import { severityOf } from '../domain/diagnostic-codes'
import {
	extractSections,
	firstMeaningfulNode,
	firstNonEmptyParagraphText,
	isMeaningful,
	isPlaceholderOnly,
	listItems,
	parseBody,
	readGfmTable,
} from './markdown'

function parseOk(bodyText: string, lineOffset = 0) {
	const result = parseBody(bodyText, lineOffset)
	if (!result.ok)
		throw new Error(`expected parseBody to succeed, got diagnostic ${result.diagnostic.code}`)
	return result.root
}

describe('parseBody', () => {
	it('parses a minimal active REQ body into a root document', () => {
		const root = parseOk([
			'## Requirement',
			'',
			'The system must return a stable error code when a search filter is invalid.',
			'',
			'## Rationale',
			'',
			'Stable error codes allow clients to handle invalid input.',
			'',
			'## Acceptance Criteria',
			'',
			'- An unsupported filter returns `invalid_filter`.',
		].join('\n'))

		expect(root.type)
			.toBe('root')
		expect(root.children.filter(node => node.type === 'heading'))
			.toHaveLength(3)
	})

	it('shifts every reported line by lineOffset so positions are whole-file one-based', () => {
		const lineOffset = 10
		const root = parseOk('## Requirement\n\nBody text.\n', lineOffset)
		const heading = root.children[0]!
		expect(heading.position?.start.line)
			.toBe(1 + lineOffset)
		const paragraph = root.children[1]!
		expect(paragraph.position?.start.line)
			.toBe(3 + lineOffset)
	})

	it('reports columns as one-based Unicode-scalar positions, not UTF-16 code-unit positions', () => {
		// "😀x **bold**": scalar columns are 😀=1, x=2, space=3, first *=4, b=6.
		// mdast/micromark itself reports UTF-16 columns (😀 counts as 2 units), so
		// the strong node's inner text would be at UTF-16 column 7 without correction.
		const root = parseOk('😀x **bold**\n')
		const paragraph = root.children[0]!
		expect(paragraph.type)
			.toBe('paragraph')
		if (paragraph.type !== 'paragraph')
			throw new Error('unreachable')
		const strong = paragraph.children[1]!
		expect(strong.position?.start.column)
			.toBe(4)
		if (strong.type !== 'strong')
			throw new Error('unreachable')
		const boldText = strong.children[0]!
		expect(boldText.position?.start.column)
			.toBe(6)
	})

	it('reports EF-BODY-015 with the registered severity when the input cannot be parsed', () => {
		// mdast-util-from-markdown rarely throws for genuine Markdown text; a
		// non-string value forces its internal preprocessor to throw so the
		// defensive catch-and-report path is exercised.
		const result = parseBody(null as unknown as string, 5)
		expect(result.ok)
			.toBe(false)
		if (result.ok)
			throw new Error('unreachable')
		expect(result.diagnostic.code)
			.toBe('EF-BODY-015')
		expect(result.diagnostic.severity)
			.toBe(severityOf('EF-BODY-015'))
		expect(result.diagnostic.location)
			.toEqual({ line: 6, column: 1 })
		expect(result.diagnostic.related)
			.toEqual([])
	})
})

describe('extractSections', () => {
	it('splits required core sections for the minimal active REQ body', () => {
		const root = parseOk([
			'## Requirement',
			'',
			'Text.',
			'',
			'## Rationale',
			'',
			'Text.',
			'',
			'## Acceptance Criteria',
			'',
			'- Item.',
		].join('\n'), 3)

		const { preH2Nodes, h1Headings, sections } = extractSections(root)
		expect(preH2Nodes)
			.toEqual([])
		expect(h1Headings)
			.toEqual([])
		expect(sections.map(section => section.heading.children[0]))
			.toEqual([
				expect.objectContaining({ value: 'Requirement' }),
				expect.objectContaining({ value: 'Rationale' }),
				expect.objectContaining({ value: 'Acceptance Criteria' }),
			])
		expect(sections.map(section => section.headingLine))
			.toEqual([1 + 3, 5 + 3, 9 + 3])
		expect(sections[0]!.nodes)
			.toHaveLength(1)
		expect(sections[2]!.nodes[0]?.type)
			.toBe('list')
	})

	it('collects content before the first H2 into preH2Nodes', () => {
		const root = parseOk([
			'Stray content before any heading.',
			'',
			'## Requirement',
			'',
			'Text.',
		].join('\n'))

		const { preH2Nodes, sections } = extractSections(root)
		expect(preH2Nodes)
			.toHaveLength(1)
		expect(preH2Nodes[0]?.type)
			.toBe('paragraph')
		expect(sections)
			.toHaveLength(1)
	})

	it('records the position of every H1 heading found anywhere in the body', () => {
		const root = parseOk([
			'## Requirement',
			'',
			'# Unexpected H1',
			'',
			'Text.',
		].join('\n'), 2)

		const { h1Headings } = extractSections(root)
		expect(h1Headings)
			.toEqual([{ line: 3 + 2, column: 1 }])
	})

	it('keeps H3+ subsections inside their enclosing H2 section instead of starting a new section', () => {
		const root = parseOk([
			'## Context',
			'',
			'### System Boundaries',
			'',
			'Boundary text.',
			'',
			'## Terminology',
		].join('\n'))

		const { sections } = extractSections(root)
		expect(sections)
			.toHaveLength(2)
		expect(sections[0]!.nodes.map(node => node.type))
			.toEqual(['heading', 'paragraph'])
		const h3 = sections[0]!.nodes[0]!
		expect(h3.type === 'heading' && h3.depth)
			.toBe(3)
	})

	it('does not treat headings inside a fenced code block or inline code as body-section headings', () => {
		const root = parseOk([
			'## Requirement',
			'',
			'```text',
			'## Not a heading',
			'```',
			'',
			'Using `## also not a heading` inline.',
			'',
			'## Rationale',
		].join('\n'))

		const { sections } = extractSections(root)
		expect(sections)
			.toHaveLength(2)
		expect(sections.map(section => section.heading.children[0]))
			.toEqual([
				expect.objectContaining({ value: 'Requirement' }),
				expect.objectContaining({ value: 'Rationale' }),
			])
		expect(sections[0]!.nodes.map(node => node.type))
			.toEqual(['code', 'paragraph'])
	})
})

describe('isMeaningful', () => {
	it('is false for an empty node list', () => {
		expect(isMeaningful([]))
			.toBe(false)
	})

	it('is true when a paragraph has real text', () => {
		const root = parseOk('## Requirement\n\nReal content.\n')
		const { sections } = extractSections(root)
		expect(isMeaningful(sections[0]!.nodes))
			.toBe(true)
	})

	it('is false when the only content is an HTML comment', () => {
		const root = parseOk('## Requirement\n\n<!-- pending -->\n')
		const { sections } = extractSections(root)
		expect(isMeaningful(sections[0]!.nodes))
			.toBe(false)
	})

	it('is true for a header-only GFM table (valid initial empty glossary)', () => {
		const root = parseOk([
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const { sections } = extractSections(root)
		expect(isMeaningful(sections[0]!.nodes))
			.toBe(true)
	})
})

describe('isPlaceholderOnly', () => {
	it('is true for a section whose only content is TODO', () => {
		const root = parseOk('## Requirement\n\nTODO\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is true for a section whose only content is TBD', () => {
		const root = parseOk('## Rationale\n\nTBD\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is true for a single list item that is only "Lorem ipsum."', () => {
		const root = parseOk('## Acceptance Criteria\n\n- Lorem ipsum.\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is true when the placeholder is wrapped in Markdown emphasis', () => {
		const root = parseOk('## Requirement\n\n**TODO**\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is true when the placeholder is wrapped in surrounding punctuation', () => {
		const root = parseOk('## Requirement\n\n(TODO)\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is false (case-insensitive match) is still detected for lowercase placeholder text', () => {
		const root = parseOk('## Requirement\n\ntodo\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(true)
	})

	it('is false when substantive content accompanies the placeholder word', () => {
		const root = parseOk('## Requirement\n\nTODO: implement rate limiting for search filters.\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(false)
	})

	it('is false when the placeholder word only occurs inside a fenced code block', () => {
		const root = parseOk('## Requirement\n\n```text\nTODO\n```\n')
		const { sections } = extractSections(root)
		expect(isMeaningful(sections[0]!.nodes))
			.toBe(true)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(false)
	})

	it('is false for ordinary substantive content', () => {
		const root = parseOk('## Requirement\n\nThe system must reject unsupported filters.\n')
		const { sections } = extractSections(root)
		expect(isPlaceholderOnly(sections[0]!.nodes))
			.toBe(false)
	})

	it('is false for an empty node list', () => {
		expect(isPlaceholderOnly([]))
			.toBe(false)
	})
})

describe('listItems', () => {
	it('returns only non-empty list items, skipping an empty item', () => {
		const root = parseOk('## Compliance\n\n- \n- Real item\n')
		const { sections } = extractSections(root)
		const items = listItems(sections[0]!.nodes)
		expect(items)
			.toHaveLength(1)
		expect(items[0]!.line)
			.toBe(4)
	})

	it('returns an empty array for a required-list section with no list at all', () => {
		const root = parseOk('## Success Criteria\n\nProse only, no list.\n')
		const { sections } = extractSections(root)
		expect(listItems(sections[0]!.nodes))
			.toEqual([])
	})

	it('finds list items nested inside a list item', () => {
		const root = parseOk([
			'## Compliance',
			'',
			'- Outer item',
			'  - Nested item',
		].join('\n'))
		const { sections } = extractSections(root)
		const items = listItems(sections[0]!.nodes)
		expect(items)
			.toHaveLength(2)
	})
})

describe('firstNonEmptyParagraphText', () => {
	it('returns the first meaningful paragraph text and position (CHG Result marker)', () => {
		const root = parseOk('## Verification\n\nResult: passed\n\nMore detail.\n', 7)
		const { sections } = extractSections(root)
		const paragraph = firstNonEmptyParagraphText(sections[0]!.nodes)
		expect(paragraph?.text)
			.toBe('Result: passed')
		expect(paragraph?.line)
			.toBe(3 + 7)
	})

	it('skips a leading HTML comment and returns the first real paragraph', () => {
		const root = parseOk('## Verification\n\n<!-- draft note -->\n\nResult: pending\n')
		const { sections } = extractSections(root)
		const paragraph = firstNonEmptyParagraphText(sections[0]!.nodes)
		expect(paragraph?.text)
			.toBe('Result: pending')
	})

	it('returns undefined when there is no top-level paragraph at all', () => {
		const root = parseOk('## Verification\n\n- not a paragraph\n')
		const { sections } = extractSections(root)
		expect(firstNonEmptyParagraphText(sections[0]!.nodes))
			.toBeUndefined()
	})
})

describe('firstMeaningfulNode and readGfmTable (PROJECT Terminology table)', () => {
	it('reads header cells and data-row cells as trimmed plain text with positions', () => {
		const root = parseOk([
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'| Artifact | A formal EF document with stable project-scoped identity. | record, entity |',
			'| Workspace | The project repository together with its declared linked-repository slots. | project group |',
		].join('\n'))

		const { sections } = extractSections(root)
		const node = firstMeaningfulNode(sections[0]!.nodes)
		expect(node?.type)
			.toBe('table')
		const table = readGfmTable(node as Table)
		expect(table.header.map(cell => cell.text))
			.toEqual(['Term', 'Definition', 'Avoid or aliases'])
		expect(table.rows)
			.toHaveLength(2)
		expect(table.rows[0]!.map(cell => cell.text))
			.toEqual(['Artifact', 'A formal EF document with stable project-scoped identity.', 'record, entity'])
		expect(table.rows[1]!.map(cell => cell.text))
			.toEqual(['Workspace', 'The project repository together with its declared linked-repository slots.', 'project group'])
		expect(table.line)
			.toBe(3)
	})

	it('reads zero data rows for a header-only glossary table', () => {
		const root = parseOk([
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const { sections } = extractSections(root)
		const table = readGfmTable(firstMeaningfulNode(sections[0]!.nodes) as Table)
		expect(table.rows)
			.toEqual([])
		expect(table.header.map(cell => cell.text))
			.toEqual(['Term', 'Definition', 'Avoid or aliases'])
	})

	it('finds a preceding paragraph instead of the table when the table is not first (invalid placement)', () => {
		const root = parseOk([
			'## Terminology',
			'',
			'Some explanatory prose before the table.',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const { sections } = extractSections(root)
		const node = firstMeaningfulNode(sections[0]!.nodes)
		expect(node?.type)
			.toBe('paragraph')
	})
})
