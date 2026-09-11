/**
 * GFM Markdown body parsing (08-artifact-schemas, 10-query-and-trace).
 *
 * Builds the GFM AST for an Artifact body, exposes whole-file source
 * positions, and provides small classification helpers that body-schema rule
 * enforcement (another module) uses to check heading structure, meaningful
 * content, placeholders, required lists, and the PROJECT Terminology table.
 *
 * This module does not enforce EF-BODY-001..019 rules itself, except that
 * `parseBody` reports EF-BODY-015 when the supported GFM syntax cannot be
 * parsed at all.
 */

import type { Diagnostic } from '../domain/diagnostics'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { severityOf } from '../domain/diagnostic-codes'

/**
 * mdast/unist node types, derived from `fromMarkdown`'s own return type
 * instead of importing `mdast`/`unist` directly. Those packages are
 * transitive type-only dependencies reachable from `mdast-util-from-markdown`
 * and `mdast-util-gfm`'s own dependency trees, not from this package's direct
 * dependencies, so a direct `import type ... from 'mdast'` does not resolve
 * under pnpm's strict per-package node_modules.
 */
export type Root = ReturnType<typeof fromMarkdown>
export type RootContent = Root['children'][number]
export type Heading = Extract<RootContent, { type: 'heading' }>
export type Table = Extract<RootContent, { type: 'table' }>
export type Paragraph = Extract<RootContent, { type: 'paragraph' }>
type ListNode = Extract<RootContent, { type: 'list' }>
export type ListItem = ListNode['children'][number]
type Point = NonNullable<Root['position']>['start']

/** One-based line and one-based Unicode-scalar column (09-validation convention). */
export interface MarkdownPosition {
	line: number
	column: number
}

export interface ParseBodySuccess {
	ok: true
	/** GFM AST whose node positions are whole-file one-based (line shifted by `lineOffset`, column Unicode-scalar). */
	root: Root
}

export interface ParseBodyFailure {
	ok: false
	/** EF-BODY-015: Markdown cannot be parsed under the supported syntax. */
	diagnostic: Diagnostic
}

export type ParseBodyResult = ParseBodySuccess | ParseBodyFailure

/**
 * Parse an Artifact body (the GFM Markdown text after YAML frontmatter) into
 * an mdast Root. `lineOffset` is the number of whole-file lines that precede
 * the body (i.e. the frontmatter block plus its delimiters); it is added to
 * every reported line so callers can report whole-file one-based positions.
 *
 * `mdast-util-from-markdown` rarely throws for genuine Markdown text; any
 * thrown error is treated as unparseable input and reported as EF-BODY-015.
 */
export function parseBody(bodyText: string, lineOffset: number): ParseBodyResult {
	let tree: Root
	try {
		tree = fromMarkdown(bodyText, {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()],
		})
	}
	catch {
		return {
			ok: false,
			diagnostic: {
				code: 'EF-BODY-015',
				severity: severityOf('EF-BODY-015'),
				message: 'Markdown cannot be parsed under the supported syntax.',
				location: { line: lineOffset + 1, column: 1 },
				related: [],
			},
		}
	}

	const lines = bodyText.split(/\r\n|\r|\n/)
	return { ok: true, root: shiftNode(tree, lineOffset, lines) }
}

/** Convert a 1-based UTF-16 code-unit column (mdast/micromark convention) to a 1-based Unicode-scalar column. */
function toScalarColumn(lineText: string, utf16Column: number): number {
	const utf16Index = utf16Column - 1
	let unitsConsumed = 0
	let scalarCount = 0
	for (const ch of lineText) {
		if (unitsConsumed >= utf16Index)
			break
		unitsConsumed += ch.length
		scalarCount++
	}
	return scalarCount + 1
}

function shiftPoint(point: Point, lineOffset: number, lines: readonly string[]): Point {
	const rawLine = lines[point.line - 1] ?? ''
	return {
		line: point.line + lineOffset,
		column: toScalarColumn(rawLine, point.column),
	}
}

/** Deep-clone a node tree, shifting every `position` to whole-file coordinates. */
function shiftNode<T>(node: T, lineOffset: number, lines: readonly string[]): T {
	if (node === null || typeof node !== 'object')
		return node

	if (Array.isArray(node))
		return node.map(item => shiftNode(item, lineOffset, lines)) as unknown as T

	const source = node as Record<string, unknown>
	const clone: Record<string, unknown> = {}
	for (const key of Object.keys(source)) {
		if (key === 'position' && source.position && typeof source.position === 'object') {
			const position = source.position as { start: Point, end: Point }
			clone.position = {
				start: shiftPoint(position.start, lineOffset, lines),
				end: shiftPoint(position.end, lineOffset, lines),
			}
		}
		else {
			clone[key] = shiftNode(source[key], lineOffset, lines)
		}
	}
	return clone as T
}

/** One top-level H2 section: its heading node, whole-file heading line, and the nodes belonging to it. */
export interface BodySection {
	heading: Heading
	headingLine: number
	nodes: RootContent[]
}

export interface ExtractedSections {
	/** Content before the first H2 heading (excluding the H1 headings tracked separately). */
	preH2Nodes: RootContent[]
	/** Position of every H1 heading found anywhere in the body. */
	h1Headings: MarkdownPosition[]
	sections: BodySection[]
}

/**
 * Split a parsed body into top-level H2 sections. mdast headings are flat
 * siblings of other block content (not nested containers), so this walks
 * `root.children` in order and buckets everything between one H2 heading and
 * the next. H3+ headings and their following content remain inside the
 * enclosing H2 section's `nodes`, matching "H3 and deeper headings MAY
 * organize content inside an H2 section" (08-artifact-schemas).
 */
export function extractSections(root: Root): ExtractedSections {
	const preH2Nodes: RootContent[] = []
	const h1Headings: MarkdownPosition[] = []
	const sections: BodySection[] = []
	let current: BodySection | undefined

	for (const node of root.children) {
		if (node.type === 'heading' && node.depth === 1 && node.position) {
			h1Headings.push({ line: node.position.start.line, column: node.position.start.column })
		}

		if (node.type === 'heading' && node.depth === 2) {
			current = {
				heading: node,
				headingLine: node.position?.start.line ?? 0,
				nodes: [],
			}
			sections.push(current)
			continue
		}

		if (current)
			current.nodes.push(node)
		else
			preH2Nodes.push(node)
	}

	return { preH2Nodes, h1Headings, sections }
}

function isBlankOrCommentHtml(value: string): boolean {
	const trimmed = value.trim()
	if (trimmed === '')
		return true
	return /^<!--[\s\S]*-->$/.test(trimmed)
}

/** Whether a node contributes non-empty, non-whitespace, non-HTML-comment content. */
function nodeHasMeaningfulContent(node: RootContent): boolean {
	switch (node.type) {
		case 'html':
			return !isBlankOrCommentHtml(node.value)
		case 'text':
			return node.value.trim() !== ''
		case 'break':
			return false
		case 'thematicBreak':
			return true
		case 'code':
		case 'inlineCode':
			return node.value.trim() !== ''
		case 'image':
		case 'imageReference':
			return true
		default:
			break
	}

	if ('children' in node && Array.isArray(node.children))
		return (node.children as RootContent[]).some(child => nodeHasMeaningfulContent(child))

	return true
}

/** At least one non-empty Markdown AST node other than whitespace or an HTML comment (08-artifact-schemas). */
export function isMeaningful(nodes: readonly RootContent[]): boolean {
	return nodes.some(node => nodeHasMeaningfulContent(node))
}

const PLACEHOLDER_PATTERN = /^[\s\p{P}]*(?:todo|tbd|lorem ipsum)[\s\p{P}]*$/iu

/** Plain text of a node, ignoring fenced/inline code and blank-or-comment HTML (their content neither counts as substantive nor as a placeholder trigger). */
function collectPlaceholderText(node: RootContent, parts: string[]): void {
	switch (node.type) {
		case 'code':
		case 'inlineCode':
			return
		case 'html':
			return
		case 'text':
			parts.push(node.value)
			return
		default:
			break
	}

	if ('children' in node && Array.isArray(node.children)) {
		for (const child of node.children as RootContent[])
			collectPlaceholderText(child, parts)
	}
}

/**
 * Whether the given nodes' entire meaningful content is a placeholder: a
 * case-insensitive form of `TODO`, `TBD`, or `Lorem ipsum`, optionally
 * surrounded by punctuation or Markdown emphasis (already unwrapped by the
 * AST). Occurrences inside code or alongside other substantive content do
 * not trigger this (08-artifact-schemas "Placeholder content").
 */
export function isPlaceholderOnly(nodes: readonly RootContent[]): boolean {
	const meaningfulNodes = nodes.filter(node => nodeHasMeaningfulContent(node))
	if (meaningfulNodes.length === 0)
		return false

	const parts: string[] = []
	for (const node of meaningfulNodes)
		collectPlaceholderText(node, parts)

	const text = parts.join(' ')
		.trim()
	if (text === '')
		return false

	return PLACEHOLDER_PATTERN.test(text)
}

function collectListItems(nodes: readonly RootContent[], out: ListItem[]): void {
	for (const node of nodes) {
		if (node.type === 'listItem')
			out.push(node)
		if ('children' in node && Array.isArray(node.children))
			collectListItems(node.children as RootContent[], out)
	}
}

export interface ListItemLocation {
	item: ListItem
	line: number
	column: number
}

/** Every non-empty GFM list item found anywhere within `nodes` (08-artifact-schemas "Required list content"). */
export function listItems(nodes: readonly RootContent[]): ListItemLocation[] {
	const allItems: ListItem[] = []
	collectListItems(nodes, allItems)
	return allItems
		.filter(item => nodeHasMeaningfulContent(item))
		.map(item => ({
			item,
			line: item.position?.start.line ?? 0,
			column: item.position?.start.column ?? 0,
		}))
}

function plainText(node: RootContent): string {
	if (node.type === 'text')
		return node.value
	if (node.type === 'inlineCode')
		return node.value
	if (node.type === 'code')
		return node.value
	if ('children' in node && Array.isArray(node.children)) {
		return (node.children as RootContent[]).map(plainText)
			.join('')
	}
	return ''
}

export interface ParagraphText {
	node: Paragraph
	text: string
	line: number
	column: number
}

/** The first top-level paragraph with meaningful content, and its plain text (used to check CHG `Result:` markers). */
export function firstNonEmptyParagraphText(nodes: readonly RootContent[]): ParagraphText | undefined {
	for (const node of nodes) {
		if (node.type !== 'paragraph')
			continue
		if (!nodeHasMeaningfulContent(node))
			continue
		return {
			node,
			text: plainText(node),
			line: node.position?.start.line ?? 0,
			column: node.position?.start.column ?? 0,
		}
	}
	return undefined
}

/** The first meaningful node among `nodes`, or `undefined` when none is meaningful (used for e.g. "table MUST be its first meaningful node"). */
export function firstMeaningfulNode(nodes: readonly RootContent[]): RootContent | undefined {
	return nodes.find(node => nodeHasMeaningfulContent(node))
}

export interface GfmTableCell {
	text: string
	line: number
	column: number
}

export interface GfmTableInfo {
	node: Table
	line: number
	column: number
	header: GfmTableCell[]
	rows: GfmTableCell[][]
}

/** Read a GFM table's header cells and data-row cells as plain text with positions (for the PROJECT Terminology table). */
export function readGfmTable(table: Table): GfmTableInfo {
	const [headerRow, ...dataRows] = table.children

	function readRow(row: typeof table.children[number] | undefined): GfmTableCell[] {
		if (!row)
			return []
		return row.children.map(cell => ({
			text: plainText(cell)
				.trim(),
			line: cell.position?.start.line ?? 0,
			column: cell.position?.start.column ?? 0,
		}))
	}

	return {
		node: table,
		line: table.position?.start.line ?? 0,
		column: table.position?.start.column ?? 0,
		header: readRow(headerRow),
		rows: dataRows.map(row => readRow(row)),
	}
}
