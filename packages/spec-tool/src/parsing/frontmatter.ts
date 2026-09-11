/**
 * YAML frontmatter boundary detection and YAML-level parsing for the EF
 * artifact envelope (01-artifact-envelope.md "YAML boundary" section,
 * 09-validation.md Parse phase and diagnostic contract).
 *
 * This module only establishes the frontmatter/body boundary and produces a
 * generic parsed YAML document plus structural (non-envelope-schema)
 * diagnostics: unterminated frontmatter, wrong top-level shape, duplicate
 * mapping keys, and forbidden YAML constructs (anchors, aliases, merge keys,
 * custom tags). Envelope field-level decoding (EF-ENV-003 and later) is a
 * separate module's responsibility; this module exposes the parsed mapping
 * generically for that module to consume.
 */

import type { YAMLMap, Node as YamlNode } from 'yaml'
import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic, RelatedLocation, SourceLocation } from '../domain/diagnostics'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import { severityOf } from '../domain/diagnostic-codes'

// ---------------------------------------------------------------------------
// Line splitting and Unicode-scalar-aware source locations
// ---------------------------------------------------------------------------

interface SourceLine {
	content: string
	startOffset: number
	terminatorLength: number
}

/** Split `source` into lines, tolerant of `\n` and `\r\n` terminators. */
function splitLines(source: string): SourceLine[] {
	const lines: SourceLine[] = []
	let pos = 0

	while (true) {
		const nlIndex = source.indexOf('\n', pos)
		if (nlIndex === -1) {
			lines.push({ content: source.slice(pos), startOffset: pos, terminatorLength: 0 })
			break
		}
		const hasCR = nlIndex > pos && source[nlIndex - 1] === '\r'
		const contentEnd = hasCR ? nlIndex - 1 : nlIndex
		lines.push({
			content: source.slice(pos, contentEnd),
			startOffset: pos,
			terminatorLength: nlIndex + 1 - contentEnd,
		})
		pos = nlIndex + 1
	}
	return lines
}

const DELIMITER_PATTERN = /^---[ \t]*$/

function isDelimiterLine(content: string): boolean {
	return DELIMITER_PATTERN.test(content)
}

/** Count Unicode scalar values (not UTF-16 code units) in `text`. */
function scalarLength(text: string): number {
	let count = 0

	for (const _ of text)
		count++
	return count
}

/** One-based line and Unicode-scalar column of `offset` within `text`. */
function locateOffsetInText(text: string, offset: number): SourceLocation {
	const lines = splitLines(text)
	let line = 1
	let lineStart = 0
	for (let i = 0; i < lines.length; i++) {
		const current = lines[i]!
		const nextStart = current.startOffset + current.content.length + current.terminatorLength
		line = i + 1
		lineStart = current.startOffset
		if (offset < nextStart || i === lines.length - 1)
			break
	}
	const column = scalarLength(text.slice(lineStart, offset)) + 1
	return { line, column }
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: {
		path?: string
		field?: string
		location?: SourceLocation
		related?: RelatedLocation[]
	} = {},
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		field: options.field,
		location: options.location,
		related: options.related ?? [],
	}
}

// ---------------------------------------------------------------------------
// splitFrontmatter
// ---------------------------------------------------------------------------

export interface FrontmatterSplitSuccess {
	ok: true
	/** Raw YAML text strictly between the opening and closing `---` lines. */
	frontmatterText: string
	/** Source text after the closing `---` line and its terminator. */
	bodyText: string
	/** One-based line number, in `source`, of the first line of `bodyText`. */
	bodyStartLine: number
}

export interface FrontmatterSplitFailure {
	ok: false
	/** EF-ENV-001: missing or unterminated frontmatter. */
	diagnostic: Diagnostic
}

export type FrontmatterSplitResult = FrontmatterSplitSuccess | FrontmatterSplitFailure

/**
 * Detect the `---`-delimited frontmatter boundary at the start of `source`
 * (01-artifact-envelope.md YAML boundary). The opening delimiter MUST be the
 * file's first line; the closing delimiter is the first subsequent line that
 * is `---` (optionally followed by trailing spaces/tabs) with no leading
 * whitespace, matching real YAML block-scalar indentation rules so that an
 * indented `---` inside frontmatter content never falsely closes it.
 */
export function splitFrontmatter(source: string): FrontmatterSplitResult {
	const lines = splitLines(source)
	const first = lines[0]

	if (!first || !isDelimiterLine(first.content)) {
		return {
			ok: false,
			diagnostic: makeDiagnostic(
				'EF-ENV-001',
				'Frontmatter is missing; the file must begin with a \'---\' line.',
				{ location: { line: 1, column: 1 } },
			),
		}
	}

	let closingIndex = -1
	for (let i = 1; i < lines.length; i++) {
		if (isDelimiterLine(lines[i]!.content)) {
			closingIndex = i
			break
		}
	}

	if (closingIndex === -1) {
		return {
			ok: false,
			diagnostic: makeDiagnostic(
				'EF-ENV-001',
				'Frontmatter is unterminated; no closing \'---\' line was found.',
				{ location: { line: 1, column: 1 } },
			),
		}
	}

	const contentStart = lines[1]!.startOffset
	const closingLine = lines[closingIndex]!
	const frontmatterText = source.slice(contentStart, closingLine.startOffset)
	const bodyStart = closingLine.startOffset + closingLine.content.length + closingLine.terminatorLength
	const bodyText = source.slice(bodyStart)

	return {
		ok: true,
		frontmatterText,
		bodyText,
		bodyStartLine: closingIndex + 2,
	}
}

// ---------------------------------------------------------------------------
// parseFrontmatterDocument
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
	'tag:yaml.org,2002:map',
	'tag:yaml.org,2002:seq',
	'tag:yaml.org,2002:str',
	'tag:yaml.org,2002:int',
	'tag:yaml.org,2002:float',
	'tag:yaml.org,2002:bool',
	'tag:yaml.org,2002:null',
])

export interface ParseFrontmatterDocumentOptions {
	/**
	 * One-based line number, in the enclosing file, corresponding to line 1 of
	 * `frontmatterText`. Defaults to 1. Pass `bodyStartLine`'s sibling value
	 * (always 2 for text produced by `splitFrontmatter`, since the opening
	 * `---` always occupies file line 1) so that returned locations are
	 * relative to the enclosing file rather than the extracted YAML text.
	 */
	startLine?: number
}

/** The `yaml` package's parsed-document return shape, reused verbatim. */
export type FrontmatterDocument = ReturnType<typeof parseDocument>

export interface ParsedFrontmatterDocument {
	/** The full parsed `yaml` Document, including its own `errors`/`warnings`. */
	document: FrontmatterDocument
	/** The top-level YAML mapping, present only when the shape check passes. */
	mapping: YAMLMap<unknown, unknown> | undefined
	/** EF-ENV-002, EF-ENV-005, and EF-ENV-010 findings for this frontmatter. */
	diagnostics: Diagnostic[]
	/**
	 * One-based line and Unicode-scalar-column location of a parsed YAML node,
	 * or of a raw character offset into `frontmatterText`. Returns `undefined`
	 * when no source position is available.
	 */
	locate: (nodeOrOffset: YamlNode | number | null | undefined) => SourceLocation | undefined
}

function joinField(base: string | undefined, key: string): string {
	return base ? `${base}.${key}` : key
}

function indexField(base: string | undefined, index: number): string {
	return `${base ?? ''}[${index}]`
}

function scalarStringValue(node: unknown): string | undefined {
	if (isScalar(node) && typeof node.value === 'string')
		return node.value
	return undefined
}

/**
 * Parse YAML 1.2 frontmatter text and report structural envelope
 * diagnostics: not exactly one top-level mapping (EF-ENV-002), duplicate
 * mapping keys (EF-ENV-005), and forbidden constructs — anchors, aliases,
 * merge keys, custom tags (EF-ENV-010).
 */
export function parseFrontmatterDocument(
	frontmatterText: string,
	path: string,
	options: ParseFrontmatterDocumentOptions = {},
): ParsedFrontmatterDocument {
	const startLine = options.startLine ?? 1

	const locate = (nodeOrOffset: YamlNode | number | null | undefined): SourceLocation | undefined => {
		let offset: number | undefined
		if (typeof nodeOrOffset === 'number')
			offset = nodeOrOffset
		else if (nodeOrOffset != null && nodeOrOffset.range != null)
			offset = nodeOrOffset.range[0]
		if (offset === undefined)
			return undefined
		const local = locateOffsetInText(frontmatterText, offset)
		return { line: local.line + (startLine - 1), column: local.column }
	}

	const document = parseDocument(frontmatterText, {
		uniqueKeys: true,
		merge: false,
	})

	const diagnostics: Diagnostic[] = []

	// Duplicate mapping keys are detected independently below (with a
	// `related` first-occurrence location); the library's own DUPLICATE_KEY
	// errors are excluded here to avoid reporting the same violation twice.
	const structuralErrors = document.errors.filter(error => error.code !== 'DUPLICATE_KEY')
	for (const error of structuralErrors) {
		diagnostics.push(makeDiagnostic(
			'EF-ENV-002',
			`Frontmatter YAML could not be parsed as a single mapping: ${error.message}`,
			{ path, location: locate(error.pos[0]) },
		))
	}

	const contents = document.contents ?? undefined
	const mapping = contents !== undefined && isMap(contents) ? contents : undefined

	if (structuralErrors.length === 0 && !mapping) {
		diagnostics.push(makeDiagnostic(
			'EF-ENV-002',
			'Frontmatter must contain exactly one top-level YAML mapping.',
			{ path, location: contents !== undefined ? locate(contents) : locate(0) },
		))
	}

	if (contents !== undefined)
		diagnostics.push(...scanForbiddenAndDuplicates(contents, path, locate))

	return { document, mapping, diagnostics, locate }
}

function scanForbiddenAndDuplicates(
	root: YamlNode,
	path: string,
	locate: (nodeOrOffset: YamlNode | number | null | undefined) => SourceLocation | undefined,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	function checkNode(node: unknown, field: string | undefined): void {
		if (!isNode(node))
			return

		if (isAlias(node)) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-010',
				'YAML alias is a forbidden construct in the artifact envelope.',
				{ path, field, location: locate(node) },
			))
			return
		}

		if (node.anchor) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-010',
				`YAML anchor '&${node.anchor}' is a forbidden construct in the artifact envelope.`,
				{ path, field, location: locate(node) },
			))
		}

		if (node.tag && !ALLOWED_TAGS.has(node.tag)) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-010',
				`YAML custom tag '${node.tag}' is a forbidden construct in the artifact envelope.`,
				{ path, field, location: locate(node) },
			))
		}

		if (isMap(node)) {
			const seen = new Map<string, SourceLocation | undefined>()
			for (const pair of node.items) {
				const keyText = scalarStringValue(pair.key)
				const childField = keyText !== undefined ? joinField(field, keyText) : field

				if (keyText === '<<') {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-010',
						'YAML merge key \'<<\' is a forbidden construct in the artifact envelope.',
						{ path, field: childField, location: locate(pair.key as YamlNode) },
					))
				}

				if (keyText !== undefined) {
					if (seen.has(keyText)) {
						diagnostics.push(makeDiagnostic(
							'EF-ENV-005',
							`Duplicate mapping key '${keyText}'.`,
							{
								path,
								field: childField,
								location: locate(pair.key as YamlNode),
								related: [{
									path,
									field: childField,
									location: seen.get(keyText),
									message: `First occurrence of key '${keyText}'.`,
								}],
							},
						))
					}
					else {
						seen.set(keyText, locate(pair.key as YamlNode))
					}
				}

				checkNode(pair.key, childField)
				checkNode(pair.value, childField)
			}
		}
		else if (isSeq(node)) {
			node.items.forEach((item, index) => checkNode(item, indexField(field, index)))
		}
	}

	checkNode(root, undefined)
	return diagnostics
}
