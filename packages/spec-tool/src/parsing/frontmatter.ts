import type { YAMLMap, Node as YamlNode } from 'yaml'
import type { Diagnostic, SourceLocation } from '../domain/diagnostics'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import { diagnostic } from '../domain/diagnostics'

interface SourceLine {
	content: string
	start: number
	terminator: number
}

function linesOf(source: string): SourceLine[] {
	const lines: SourceLine[] = []
	let start = 0
	while (true) {
		const newline = source.indexOf('\n', start)
		if (newline < 0) {
			lines.push({ content: source.slice(start), start, terminator: 0 })
			return lines
		}
		const cr = newline > start && source[newline - 1] === '\r'
		const contentEnd = cr ? newline - 1 : newline
		lines.push({ content: source.slice(start, contentEnd), start, terminator: newline + 1 - contentEnd })
		start = newline + 1
	}
}

function scalarLength(value: string): number {
	let length = 0
	for (const _ of value)
		length++
	return length
}

function locateOffset(source: string, offset: number, startLine: number): SourceLocation {
	const lines = linesOf(source)
	const line = lines.findIndex((item) => {
		const end = item.start + item.content.length + item.terminator
		return offset < end
	})
	const index = line < 0 ? lines.length - 1 : line
	const current = lines[index] ?? { content: '', start: 0, terminator: 0 }
	return { line: startLine + index, column: scalarLength(source.slice(current.start, Math.max(current.start, offset))) + 1 }
}

function delimiter(content: string): boolean {
	return /^---[ \t]*$/.test(content)
}

export interface FrontmatterSplitSuccess {
	ok: true
	frontmatterText: string
	bodyText: string
	bodyStartLine: number
}

export interface FrontmatterSplitFailure {
	ok: false
	diagnostic: Diagnostic
}

export type FrontmatterSplitResult = FrontmatterSplitSuccess | FrontmatterSplitFailure

export function splitFrontmatter(source: string): FrontmatterSplitResult {
	const lines = linesOf(source)
	if (!lines[0] || !delimiter(lines[0].content))
		return { ok: false, diagnostic: diagnostic('SPEC-ARTIFACT-PARSE', 'Artifact must begin with a YAML frontmatter delimiter (---).', { location: { line: 1, column: 1 } }) }
	const closing = lines.findIndex((line, index) => index > 0 && delimiter(line.content))
	if (closing < 0)
		return { ok: false, diagnostic: diagnostic('SPEC-ARTIFACT-PARSE', 'Artifact frontmatter is missing its closing delimiter (---).', { location: { line: 1, column: 1 } }) }
	const firstBody = lines[1]?.start ?? lines[0]!.start + lines[0]!.content.length + lines[0]!.terminator
	const close = lines[closing]!
	const bodyStart = close.start + close.content.length + close.terminator
	return {
		ok: true,
		frontmatterText: source.slice(firstBody, close.start),
		bodyText: source.slice(bodyStart),
		bodyStartLine: closing + 2,
	}
}

const CORE_YAML_TAGS = new Set([
	'tag:yaml.org,2002:map',
	'tag:yaml.org,2002:seq',
	'tag:yaml.org,2002:str',
	'tag:yaml.org,2002:int',
	'tag:yaml.org,2002:float',
	'tag:yaml.org,2002:bool',
	'tag:yaml.org,2002:null',
])

export interface ParseFrontmatterDocumentOptions {
	startLine?: number
}

export type FrontmatterDocument = ReturnType<typeof parseDocument>

export interface ParsedFrontmatterDocument {
	document: FrontmatterDocument
	mapping: YAMLMap<unknown, unknown> | undefined
	diagnostics: Diagnostic[]
	locate: (nodeOrOffset: YamlNode | number | null | undefined) => SourceLocation | undefined
}

export function parseFrontmatterDocument(
	frontmatterText: string,
	path: string,
	options: ParseFrontmatterDocumentOptions = {},
): ParsedFrontmatterDocument {
	const startLine = options.startLine ?? 1
	const document = parseDocument(frontmatterText, { uniqueKeys: true, merge: false })
	const locate = (nodeOrOffset: YamlNode | number | null | undefined): SourceLocation | undefined => {
		if (nodeOrOffset === null || nodeOrOffset === undefined)
			return undefined
		const offset = typeof nodeOrOffset === 'number' ? nodeOrOffset : nodeOrOffset.range?.[0]
		return offset === undefined ? undefined : locateOffset(frontmatterText, offset, startLine)
	}
	const diagnostics: Diagnostic[] = document.errors
		.filter(error => error.code !== 'DUPLICATE_KEY')
		.map(error => diagnostic('SPEC-ARTIFACT-PARSE', `Frontmatter YAML could not be parsed: ${error.message}`, { path, location: locate(error.pos[0]) }))
	const contents = document.contents
	if (contents !== null && contents !== undefined)
		scanForbidden(contents as YamlNode, path, locate, diagnostics)
	const mapping = contents !== null && contents !== undefined && isMap(contents) ? contents : undefined
	if (!mapping && document.errors.length === 0)
		diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', 'Artifact frontmatter must contain one top-level YAML mapping.', { path, location: locate(0) }))
	return { document, mapping, diagnostics, locate }
}

function scanForbidden(
	node: YamlNode,
	path: string,
	locate: (node: YamlNode | number | null | undefined) => SourceLocation | undefined,
	diagnostics: Diagnostic[],
): void {
	if (isAlias(node)) {
		diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', 'YAML aliases are not allowed in Spec frontmatter.', { path, location: locate(node) }))
		return
	}
	if (node.anchor)
		diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', 'YAML anchors are not allowed in Spec frontmatter.', { path, location: locate(node) }))
	if (node.tag && !CORE_YAML_TAGS.has(node.tag))
		diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', `YAML tag '${node.tag}' is not allowed in Spec frontmatter.`, { path, location: locate(node) }))
	if (isMap(node)) {
		const seen = new Set<string>()
		for (const pair of node.items) {
			const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined
			if (key === '<<')
				diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', 'YAML merge keys are not allowed in Spec frontmatter.', { path, field: key, location: locate(pair.key as YamlNode) }))
			if (key !== undefined && seen.has(key))
				diagnostics.push(diagnostic('SPEC-ARTIFACT-PARSE', `Duplicate frontmatter field '${key}'.`, { path, field: key, location: locate(pair.key as YamlNode) }))
			if (key !== undefined)
				seen.add(key)
			if (isNode(pair.key))
				scanForbidden(pair.key, path, locate, diagnostics)
			if (isNode(pair.value))
				scanForbidden(pair.value, path, locate, diagnostics)
		}
	}
	else if (isSeq(node)) {
		for (const item of node.items) {
			if (isNode(item))
				scanForbidden(item, path, locate, diagnostics)
		}
	}
}
