/**
 * Structural Markdown parser for EF Core diagnostic documentation.
 *
 * TEST-ONLY helper. It is deliberately NOT re-exported from `./index` and
 * exists solely so `diagnostic-codes.unit.test.ts` can prove structural
 * parity across the three places a diagnostic code is declared:
 *   1. `docs/ef-core/diagnostic-registry.md`             (the central registry)
 *   2. each owning specification's own embedded diagnostic table
 *      (per the registry's maintenance rule: a code is added to its owning
 *      spec's table FIRST, then mirrored into the registry)
 *   3. the `DIAGNOSTIC_CODES` constant in `./diagnostic-codes.ts`
 *
 * This module does not understand Markdown in general. It only understands
 * the one pipe-table shape used throughout `docs/ef-core/*.md`: a header
 * row, a `|---|---|` separator row, and one data row per diagnostic code.
 * Column order and extra columns (e.g. the registry's "Scope"/"Owner", or
 * `09-validation.md`'s "Exit class") are irrelevant -- rows are read by
 * header name, not position.
 */

export interface DiagnosticTableRow {
	/** Stable diagnostic code, e.g. "EF-VAL-013". Always present (required column: "Code"). */
	code: string
	/** Declared severity cell, verbatim, e.g. "error" | "warning" | "info". */
	severity: string
	/**
	 * Declared condition cell with internal whitespace collapsed to single
	 * spaces and outer whitespace trimmed, otherwise verbatim (case and
	 * punctuation, including inline backticks, are preserved). Line-wrapped
	 * Markdown table source can introduce incidental extra spaces without
	 * changing meaning; collapsing whitespace absorbs that without hiding a
	 * real wording drift.
	 */
	condition: string
	/** Every column in the row, keyed by its header text, cell value trimmed but NOT whitespace-collapsed. */
	cells: Readonly<Record<string, string>>
}

interface RawTable {
	header: string[]
	rows: string[][]
}

const TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/
const SEPARATOR_CELL_PATTERN = /^:?-+:?$/
const CODE_CELL_PATTERN = /^`([A-Z]+-[A-Z]+-\d+)`$/

function splitRow(line: string): string[] {
	const trimmed = line.trim()
	return trimmed.slice(1, -1)
		.split('|')
		.map(cell => cell.trim())
}

function toRawTable(lines: string[][]): RawTable {
	const [header, ...rest] = lines
	if (!header) {
		throw new Error('diagnostic-docs-parser: encountered an empty table block')
	}
	const rows = rest.filter(row => !row.every(cell => SEPARATOR_CELL_PATTERN.test(cell)))
	return { header, rows }
}

/** Groups consecutive `| ... |` lines into raw tables (header + data rows; the `|---|` separator row is dropped). */
function parseRawTables(markdown: string): RawTable[] {
	const tables: RawTable[] = []
	let current: string[][] = []
	for (const line of markdown.split('\n')) {
		if (TABLE_ROW_PATTERN.test(line)) {
			current.push(splitRow(line))
			continue
		}
		if (current.length > 0) {
			tables.push(toRawTable(current))
			current = []
		}
	}
	if (current.length > 0) {
		tables.push(toRawTable(current))
	}
	return tables
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Extracts every diagnostic-code table in a document: any table whose
 * header row contains "Code", "Severity", and "Condition" columns. A data
 * row is only emitted when its "Code" cell is a single backtick-wrapped
 * `EF-<NAMESPACE>-<NUMBER>` token; anything else (a malformed or unrelated
 * table row) is silently skipped rather than mis-parsed.
 */
export function extractDiagnosticRows(markdown: string): DiagnosticTableRow[] {
	const rows: DiagnosticTableRow[] = []
	for (const table of parseRawTables(markdown)) {
		const codeIdx = table.header.indexOf('Code')
		const severityIdx = table.header.indexOf('Severity')
		const conditionIdx = table.header.indexOf('Condition')
		if (codeIdx === -1 || severityIdx === -1 || conditionIdx === -1) {
			continue
		}
		for (const row of table.rows) {
			const codeCell = row[codeIdx]
			const match = codeCell ? CODE_CELL_PATTERN.exec(codeCell) : null
			if (!match) {
				continue
			}
			const cells: Record<string, string> = {}
			table.header.forEach((name, idx) => {
				cells[name] = row[idx] ?? ''
			})
			rows.push({
				code: match[1]!,
				severity: row[severityIdx] ?? '',
				condition: collapseWhitespace(row[conditionIdx] ?? ''),
				cells,
			})
		}
	}
	return rows
}

/**
 * Parses the registry's "## Reserved numeric slots" bullet-list section
 * into the set of codes it marks reserved (namespace slots with no
 * assigned diagnostic). Each bullet has the shape
 * `- **EF-NAMESPACE:** `CODE-A`, `CODE-B`` or `- **EF-NAMESPACE:** None`.
 */
export function parseReservedSlots(markdown: string): Set<string> {
	const headingMatch = /^## Reserved numeric slots\s*$/m.exec(markdown)
	if (!headingMatch) {
		throw new Error('diagnostic-docs-parser: "## Reserved numeric slots" heading not found')
	}
	const sectionStart = headingMatch.index + headingMatch[0].length
	const rest = markdown.slice(sectionStart)
	const nextHeadingMatch = /^## /m.exec(rest)
	const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest

	const reserved = new Set<string>()
	const codePattern = /`([A-Z]+-[A-Z]+-\d+)`/g
	for (const line of section.split('\n')) {
		if (!/^-\s+\*\*[A-Z-]+:\*\*/.test(line)) {
			continue
		}
		for (const match of line.matchAll(codePattern)) {
			reserved.add(match[1]!)
		}
	}
	return reserved
}

/** Extracts the `owner-file.md` link target from a registry row's "Owner" cell, e.g. `[09-validation.md](09-validation.md)` -> `09-validation.md`. */
export function ownerFileOf(row: DiagnosticTableRow): string {
	const ownerCell = row.cells.Owner
	const match = ownerCell ? /\(([^)]+\.md)\)/.exec(ownerCell) : null
	if (!match) {
		throw new Error(`diagnostic-docs-parser: row for ${row.code} has no parseable Owner link (got "${ownerCell ?? ''}")`)
	}
	return match[1]!
}
