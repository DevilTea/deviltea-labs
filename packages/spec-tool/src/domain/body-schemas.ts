/**
 * Body schema validation (08-artifact-schemas; CHG rules from
 * 07-change-transactions "Required completed-CHG body sections", "Verification
 * result marker", "Completed-CHG structural requirements", and "Retired-CHG
 * structural requirements").
 *
 * Consumes the already-parsed `ExtractedSections` produced by the parsing
 * module (../parsing/markdown). This module does not parse Markdown itself
 * and does not emit EF-BODY-015 (that is `parseBody`'s responsibility).
 */

import type {
	BodySection,
	ExtractedSections,
	Heading,
	MarkdownPosition,
	RootContent,
	Table,
} from '../parsing/markdown'
import type { DiagnosticCode } from './diagnostic-codes'
import type { Diagnostic } from './diagnostics'
import type { ArtifactType, Status } from './model'
import {
	firstMeaningfulNode,
	firstNonEmptyParagraphText,
	isMeaningful,
	isPlaceholderOnly,
	listItems,
	readGfmTable,
} from '../parsing/markdown'
import { severityOf } from './diagnostic-codes'
import { compareBytewise } from './model'

export interface BodyValidationInput {
	type: ArtifactType
	status: Status
	path: string
	/** The result of `extractSections(root)` from the parsing module. */
	body: ExtractedSections
	/**
	 * Whether a `retired` PRD/REQ/ADR/POL was previously `active` (per the
	 * lifecycle-sensitive completeness table's "retired from active" vs.
	 * "retired from draft" rows). `undefined` is treated as "previously draft
	 * or unknown", the conservative (less strict) branch. Ignored for other
	 * statuses and for `project`/`change`.
	 */
	previouslyActive?: boolean
}

type SectionKind = 'meaningful' | 'list' | 'terminology' | 'verification' | 'chg-changes'

interface CoreHeadingSpec {
	name: string
	kind: SectionKind
}

const CORE_SCHEMA: Record<ArtifactType, readonly CoreHeadingSpec[]> = {
	project: [
		{ name: 'Vision', kind: 'meaningful' },
		{ name: 'Scope', kind: 'meaningful' },
		{ name: 'Non-goals', kind: 'meaningful' },
		{ name: 'Context', kind: 'meaningful' },
		{ name: 'Terminology', kind: 'terminology' },
	],
	prd: [
		{ name: 'Problem', kind: 'meaningful' },
		{ name: 'User Need', kind: 'meaningful' },
		{ name: 'Desired Outcome', kind: 'meaningful' },
		{ name: 'Success Criteria', kind: 'list' },
		{ name: 'Non-goals', kind: 'meaningful' },
	],
	requirement: [
		{ name: 'Requirement', kind: 'meaningful' },
		{ name: 'Rationale', kind: 'meaningful' },
		{ name: 'Acceptance Criteria', kind: 'list' },
	],
	decision: [
		{ name: 'Context', kind: 'meaningful' },
		{ name: 'Decision', kind: 'meaningful' },
		{ name: 'Alternatives', kind: 'meaningful' },
		{ name: 'Consequences', kind: 'meaningful' },
	],
	policy: [
		{ name: 'Policy', kind: 'meaningful' },
		{ name: 'Scope', kind: 'meaningful' },
		{ name: 'Rationale', kind: 'meaningful' },
		{ name: 'Compliance', kind: 'list' },
	],
	change: [
		{ name: 'Rationale', kind: 'meaningful' },
		{ name: 'Sources', kind: 'list' },
		{ name: 'Changes', kind: 'chg-changes' },
		{ name: 'Verification', kind: 'verification' },
	],
}

const KNOWLEDGE_TYPES: readonly ArtifactType[] = ['prd', 'requirement', 'decision', 'policy']

const LIFECYCLE_HEADING = 'Lifecycle'

/** Whether the required core/Lifecycle headings must structurally be present, deduplicated, and ordered. CHG only enforces this once completed or retired (07-change-transactions "A draft CHG MAY omit or leave final sections incomplete"). */
function requiresHeadingPresence(type: ArtifactType, status: Status): boolean {
	if (type === 'change')
		return status === 'completed' || status === 'retired'
	return true
}

/** Whether required core sections must be present AND meaningful/list-satisfying (the lifecycle-sensitive completeness table). */
function requiresCompleteness(type: ArtifactType, status: Status, previouslyActive: boolean | undefined): boolean {
	if (type === 'project')
		return true
	if (type === 'change')
		return status === 'completed' || status === 'retired'
	if (status === 'draft')
		return false
	if (status === 'active' || status === 'superseded')
		return true
	if (status === 'retired')
		return previouslyActive === true
	return false
}

interface SectionEntry {
	index: number
	text: string
	location: MarkdownPosition
	section: BodySection
}

interface TextishNode {
	type: string
	value?: string
	children?: TextishNode[]
}

function plainTextOf(node: TextishNode): string {
	if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code'))
		return node.value
	if (Array.isArray(node.children)) {
		return node.children.map(plainTextOf)
			.join('')
	}
	return ''
}

function headingText(heading: Heading): string {
	return plainTextOf(heading as unknown as TextishNode)
}

function headingLocation(section: BodySection): MarkdownPosition {
	return {
		line: section.heading.position?.start.line ?? section.headingLine,
		column: section.heading.position?.start.column ?? 1,
	}
}

function nodeLocation(node: RootContent): MarkdownPosition {
	return {
		line: node.position?.start.line ?? 0,
		column: node.position?.start.column ?? 0,
	}
}

/** Location of the first meaningful node in a section, falling back to the section's heading location. */
function contentLocation(section: BodySection, fallback: MarkdownPosition): MarkdownPosition {
	const node = firstMeaningfulNode(section.nodes)
	return node ? nodeLocation(node) : fallback
}

function makeDiagnostic(
	code: DiagnosticCode,
	path: string,
	location: MarkdownPosition | undefined,
	message: string,
	section?: string,
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path,
		location,
		section,
		related: [],
	}
}

const RESULT_MARKER_PATTERN = /^Result: (passed|not-applicable|not-completed|pending)$/

/** CHG Verification result marker (07-change-transactions "Verification result marker", "Completed-CHG structural requirements", "Retired-CHG structural requirements"). Only called once Rationale/Sources/Changes/Verification are each structurally present exactly once. */
function validateChgVerification(section: BodySection, status: Status, path: string, headingLoc: MarkdownPosition): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const marker = firstNonEmptyParagraphText(section.nodes)

	if (!marker) {
		diagnostics.push(makeDiagnostic('EF-BODY-014', path, headingLoc, 'CHG Verification result marker is missing.', 'Verification'))
		return diagnostics
	}

	const markerLoc = { line: marker.line, column: marker.column }
	const match = RESULT_MARKER_PATTERN.exec(marker.text.trim())

	if (!match) {
		diagnostics.push(makeDiagnostic('EF-BODY-014', path, markerLoc, 'CHG Verification result marker is not a recognized "Result: ..." form.', 'Verification'))
		return diagnostics
	}

	const value = match[1]!
	const expected = status === 'completed' ? ['passed', 'not-applicable'] : ['not-completed']

	if (!expected.includes(value)) {
		diagnostics.push(makeDiagnostic('EF-CHG-010', path, markerLoc, `Verification result "${value}" is structurally valid but incompatible with a ${status} CHG.`, 'Verification'))
		return diagnostics
	}

	const markerIndex = section.nodes.indexOf(marker.node)
	const afterMarker = section.nodes.slice(markerIndex + 1)

	if (value === 'passed') {
		if (listItems(section.nodes).length === 0)
			diagnostics.push(makeDiagnostic('EF-BODY-014', path, markerLoc, 'A "Result: passed" Verification requires at least one non-empty list item describing a performed check.', 'Verification'))
	}
	else if (value === 'not-applicable') {
		if (!isMeaningful(afterMarker))
			diagnostics.push(makeDiagnostic('EF-BODY-014', path, markerLoc, 'A "Result: not-applicable" Verification requires a non-empty rationale paragraph after the marker.', 'Verification'))
	}
	else if (value === 'not-completed') {
		if (!isMeaningful(afterMarker))
			diagnostics.push(makeDiagnostic('EF-BODY-014', path, markerLoc, 'A "Result: not-completed" Verification requires an explanation after the marker.', 'Verification'))
	}

	return diagnostics
}

const TERMINOLOGY_HEADER = ['Term', 'Definition', 'Avoid or aliases']

/** PROJECT Terminology table (08-artifact-schemas "`Terminology`"). Only called once the Terminology heading is structurally present exactly once. */
function validateTerminology(section: BodySection, path: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const fallbackLoc = headingLocation(section)
	const tables = section.nodes.filter((node): node is Table => node.type === 'table')

	if (tables.length === 0) {
		diagnostics.push(makeDiagnostic('EF-BODY-018', path, fallbackLoc, 'PROJECT Terminology requires exactly one GFM table.', 'Terminology'))
		return diagnostics
	}

	const first = firstMeaningfulNode(section.nodes)
	if (first !== tables[0]) {
		diagnostics.push(makeDiagnostic('EF-BODY-018', path, nodeLocation(tables[0]!), 'The Terminology table must be the first meaningful node in the section.', 'Terminology'))
	}

	for (const extra of tables.slice(1))
		diagnostics.push(makeDiagnostic('EF-BODY-018', path, nodeLocation(extra), 'The Terminology section must contain exactly one table.', 'Terminology'))

	const table = readGfmTable(tables[0]!)
	const tableLoc = { line: table.line, column: table.column }
	const headerTexts = table.header.map(cell => cell.text)
	const headerOk = headerTexts.length === TERMINOLOGY_HEADER.length
		&& headerTexts.every((text, i) => text === TERMINOLOGY_HEADER[i])

	if (!headerOk) {
		diagnostics.push(makeDiagnostic('EF-BODY-018', path, tableLoc, 'The Terminology table must use the exact columns "Term | Definition | Avoid or aliases".', 'Terminology'))
		return diagnostics
	}

	const seenTerms = new Set<string>()
	let previousTerm: string | undefined

	for (const row of table.rows) {
		if (row.length !== TERMINOLOGY_HEADER.length) {
			diagnostics.push(makeDiagnostic('EF-BODY-018', path, row[0] ? { line: row[0].line, column: row[0].column } : tableLoc, 'Terminology row does not have exactly three cells.', 'Terminology'))
			continue
		}

		const [termCell, definitionCell] = row as [typeof row[0], typeof row[0], typeof row[0]]
		const term = termCell.text
		const definition = definitionCell.text
		const cellLoc = { line: termCell.line, column: termCell.column }

		if (term === '' || definition === '') {
			diagnostics.push(makeDiagnostic('EF-BODY-018', path, cellLoc, 'Terminology Term and Definition cells must be non-empty.', 'Terminology'))
			continue
		}

		if (term.normalize('NFC') !== term)
			diagnostics.push(makeDiagnostic('EF-BODY-018', path, cellLoc, 'Terminology Term must use Unicode NFC.', 'Terminology'))

		if (seenTerms.has(term))
			diagnostics.push(makeDiagnostic('EF-BODY-018', path, cellLoc, `Terminology Term "${term}" is duplicated after trimming.`, 'Terminology'))
		else
			seenTerms.add(term)

		if (previousTerm !== undefined && compareBytewise(term, previousTerm) < 0)
			diagnostics.push(makeDiagnostic('EF-BODY-019', path, cellLoc, 'Terminology rows are not sorted by the trimmed term\'s UTF-8 byte sequence.', 'Terminology'))

		previousTerm = term
	}

	return diagnostics
}

export function validateBody(input: BodyValidationInput): Diagnostic[] {
	const { type, status, path, body, previouslyActive } = input
	const diagnostics: Diagnostic[] = []

	const schema = CORE_SCHEMA[type]
	if (!schema) {
		diagnostics.push(makeDiagnostic('EF-BODY-016', path, undefined, `Body schema does not match Artifact type "${String(type)}".`))
		return diagnostics
	}

	for (const h1 of body.h1Headings)
		diagnostics.push(makeDiagnostic('EF-BODY-006', path, h1, 'Artifact body contains an H1 heading.'))

	const preH2First = firstMeaningfulNode(body.preH2Nodes)
	if (preH2First)
		diagnostics.push(makeDiagnostic('EF-BODY-007', path, nodeLocation(preH2First), 'Meaningful content appears before the first H2 section.'))

	const sectionEntries: SectionEntry[] = body.sections.map((section, index) => ({
		index,
		text: headingText(section.heading),
		location: headingLocation(section),
		section,
	}))

	const nameToOccurrences = new Map<string, SectionEntry[]>()
	for (const entry of sectionEntries) {
		const list = nameToOccurrences.get(entry.text) ?? []
		list.push(entry)
		nameToOccurrences.set(entry.text, list)
	}

	const headingPresenceRequired = requiresHeadingPresence(type, status)

	if (headingPresenceRequired) {
		for (const spec of schema) {
			const occurrences = nameToOccurrences.get(spec.name) ?? []
			if (occurrences.length === 0) {
				diagnostics.push(makeDiagnostic('EF-BODY-001', path, undefined, `Required heading "## ${spec.name}" is missing.`, spec.name))
			}
			else {
				for (const extra of occurrences.slice(1))
					diagnostics.push(makeDiagnostic('EF-BODY-002', path, extra.location, `Heading "## ${spec.name}" is duplicated.`, spec.name))
			}
		}

		const present = schema
			.map(spec => nameToOccurrences.get(spec.name)?.[0])
			.filter((entry): entry is SectionEntry => entry !== undefined)

		for (let i = 1; i < present.length; i++) {
			const previous = present[i - 1]!
			const current = present[i]!
			if (current.index <= previous.index)
				diagnostics.push(makeDiagnostic('EF-BODY-003', path, current.location, `Required heading "## ${current.text}" appears out of the required order.`, current.text))
		}
	}

	const isKnowledgeType = KNOWLEDGE_TYPES.includes(type)
	const isTerminalKnowledge = isKnowledgeType && (status === 'superseded' || status === 'retired')
	const lifecycleOccurrences = nameToOccurrences.get(LIFECYCLE_HEADING) ?? []

	if (!isTerminalKnowledge) {
		for (const occurrence of lifecycleOccurrences)
			diagnostics.push(makeDiagnostic('EF-BODY-010', path, occurrence.location, 'Non-terminal Artifact, PROJECT, or CHG must not contain a Lifecycle section.', LIFECYCLE_HEADING))
	}
	else {
		for (const extra of lifecycleOccurrences.slice(1))
			diagnostics.push(makeDiagnostic('EF-BODY-002', path, extra.location, 'Heading "## Lifecycle" is duplicated.', LIFECYCLE_HEADING))

		const first = lifecycleOccurrences[0]
		if (!first) {
			diagnostics.push(makeDiagnostic('EF-BODY-009', path, undefined, 'Terminal knowledge Artifact lacks a meaningful Lifecycle section.', LIFECYCLE_HEADING))
		}
		else {
			const meaningful = isMeaningful(first.section.nodes) && !isPlaceholderOnly(first.section.nodes)
			if (!meaningful)
				diagnostics.push(makeDiagnostic('EF-BODY-009', path, first.location, 'Terminal knowledge Artifact lacks a meaningful Lifecycle section.', LIFECYCLE_HEADING))
			if (first.index !== sectionEntries.length - 1)
				diagnostics.push(makeDiagnostic('EF-BODY-011', path, first.location, 'Lifecycle is not the final H2 section.', LIFECYCLE_HEADING))
		}
	}

	const coreNameSet = new Set(schema.map(spec => spec.name))
	let maxCoreIndex = -1
	for (const entry of sectionEntries) {
		if (coreNameSet.has(entry.text))
			maxCoreIndex = Math.max(maxCoreIndex, entry.index)
	}
	for (const entry of sectionEntries) {
		if (coreNameSet.has(entry.text) || entry.text === LIFECYCLE_HEADING)
			continue
		if (entry.index < maxCoreIndex)
			diagnostics.push(makeDiagnostic('EF-BODY-008', path, entry.location, `Custom heading "## ${entry.text}" appears before all required core sections.`, entry.text))
	}

	if (requiresCompleteness(type, status, previouslyActive)) {
		for (const spec of schema) {
			const occurrences = nameToOccurrences.get(spec.name) ?? []
			if (occurrences.length !== 1)
				continue

			const entry = occurrences[0]!
			const section = entry.section

			if (spec.kind === 'terminology') {
				diagnostics.push(...validateTerminology(section, path))
				continue
			}
			if (spec.kind === 'verification')
				continue

			if (isPlaceholderOnly(section.nodes)) {
				diagnostics.push(makeDiagnostic('EF-BODY-012', path, contentLocation(section, entry.location), `Section "## ${spec.name}" contains only placeholder content.`, spec.name))
				continue
			}

			const effectiveKind = spec.kind === 'chg-changes'
				? (status === 'completed' ? 'list' : 'meaningful')
				: spec.kind

			if (effectiveKind === 'list') {
				if (listItems(section.nodes).length === 0)
					diagnostics.push(makeDiagnostic('EF-BODY-005', path, entry.location, `Section "## ${spec.name}" requires at least one non-empty list item.`, spec.name))
			}
			else if (!isMeaningful(section.nodes)) {
				diagnostics.push(makeDiagnostic('EF-BODY-004', path, entry.location, `Section "## ${spec.name}" must be present and meaningful.`, spec.name))
			}
		}

		if (type === 'change' && (status === 'completed' || status === 'retired')) {
			const allSingular = schema.every(spec => (nameToOccurrences.get(spec.name) ?? []).length === 1)
			if (allSingular) {
				const verificationEntry = nameToOccurrences.get('Verification')![0]!
				diagnostics.push(...validateChgVerification(verificationEntry.section, status, path, verificationEntry.location))
			}
		}
	}

	return diagnostics
}
