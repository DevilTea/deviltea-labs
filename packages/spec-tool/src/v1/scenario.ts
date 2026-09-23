import type { ScenarioStep, ValidationIssue } from './types'
import { isUuidV7 } from './identity'
import { addIssue, compareText } from './storage'

/** One first-class Scenario, independently identified from its storage container. */
export interface ScenarioData {
	id: string
	title: string
	steps: ScenarioStep[]
	demonstrates: string[]
}

export interface ScenarioEntry {
	value: ScenarioData
	startLine: number
	titleLine: number
	stepLines: number[]
	lastStepLine: number
}

export interface ScenarioContainer {
	path: string
	label: string
	lines: string[]
	trailingNewline: boolean
	entries: ScenarioEntry[]
}

export interface ScenarioStored {
	path: string
	value: ScenarioData
	container: ScenarioContainer
	entry: ScenarioEntry
}

const CORE_STEPS = ['Given', 'When', 'Then'] as const
const TAG_ID = /^ {2}@spec:id:(.+)$/
const TAG_DEMONSTRATES = /^ {2}@spec:demonstrates:(.+)$/
const SCENARIO_HEADER = /^ {2}Scenario: (.*)$/
const STEP_LINE = /^ {4}(Given|When|Then|And|But) (.*)$/

function invalid(issues: ValidationIssue[], path: string, field: string, message: string): void {
	addIssue(issues, path, field, 'invalid_format', message)
}

function isComment(line: string): boolean {
	return line.trimStart()
		.startsWith('#')
}

function isIgnorable(line: string): boolean {
	return line === '' || isComment(line)
}

/**
 * Parse the frozen, English-keyword-only Gherkin subset; retain original lines
 * so mutations of one Scenario leave unrelated comments and siblings intact.
 */
export function parseScenarioFile(path: string, raw: string, issues: ValidationIssue[]): ScenarioContainer | null {
	if (raw.includes('\r') || !raw) {
		invalid(issues, path, path, 'Scenario persistence must be non-empty UTF-8 LF text.')
		return null
	}
	const trailingNewline = raw.endsWith('\n')
	const lines = (trailingNewline ? raw.slice(0, -1) : raw).split('\n')
	let cursor = 0
	while (cursor < lines.length && isIgnorable(lines[cursor]!))
		cursor++
	const header = /^Feature: (.*)$/.exec(lines[cursor] ?? '')
	if (!header || !header[1]?.trim()) {
		invalid(issues, path, 'Feature', 'Exactly one non-empty Feature: header is required at column zero.')
		return null
	}
	const label = header[1]
	cursor++
	const entries: ScenarioEntry[] = []
	let previous: ScenarioEntry | undefined

	while (cursor < lines.length) {
		while (cursor < lines.length && isIgnorable(lines[cursor]!))
			cursor++
		if (cursor >= lines.length)
			break
		const startLine = cursor
		const idTag = TAG_ID.exec(lines[cursor]!)
		if (!idTag || !isUuidV7(idTag[1])) {
			invalid(issues, path, 'metadata', 'Every Scenario requires canonical @spec:id first, followed by demonstrates tags.')
			return null
		}
		if (previous) {
			const between = lines.slice(previous.lastStepLine + 1, startLine)
			if (between.filter(line => line === '').length !== 1) {
				invalid(issues, path, 'Scenario', 'Exactly one blank line is required between Scenario blocks.')
				return null
			}
		}
		const id = idTag[1]
		cursor++
		const demonstrates: string[] = []
		while (cursor < lines.length) {
			const targetTag = TAG_DEMONSTRATES.exec(lines[cursor]!)
			if (!targetTag)
				break
			const targetId = targetTag[1]!
			if (!isUuidV7(targetId)) {
				invalid(issues, path, 'demonstrates', 'Demonstrates tags must contain lowercase UUIDv7 identifiers.')
				return null
			}
			demonstrates.push(targetId)
			cursor++
		}
		if (!demonstrates.length || new Set(demonstrates).size !== demonstrates.length
			|| demonstrates.some((id, index) => index > 0 && compareText(demonstrates[index - 1]!, id) >= 0)) {
			invalid(issues, path, 'demonstrates', 'Demonstrates tags must be non-empty, unique and sorted by UUID.')
			return null
		}
		const titleLine = cursor
		const titleMatch = SCENARIO_HEADER.exec(lines[cursor] ?? '')
		if (!titleMatch || !titleMatch[1]?.trim()) {
			invalid(issues, path, 'Scenario', 'Metadata must be contiguous and immediately precede a non-empty Scenario: title.')
			return null
		}
		const title = titleMatch[1]
		cursor++
		const steps: ScenarioStep[] = []
		const stepLines: number[] = []
		let lastStepLine = -1
		let effective: ScenarioStep['type'] | null = null
		let whenCount = 0
		let thenCount = 0
		while (cursor < lines.length && !TAG_ID.test(lines[cursor]!)) {
			const line = lines[cursor]!
			if (isComment(line)) {
				cursor++
				continue
			}
			if (line === '') {
				if (lastStepLine < 0) {
					invalid(issues, path, 'steps', 'No blank line is allowed between Scenario: and the first step.')
					return null
				}
				cursor++
				continue
			}
			const match = STEP_LINE.exec(line)
			if (!match || !match[2]?.trim()) {
				invalid(issues, path, 'steps', 'Only indented Given/When/Then/And/But steps and comments are supported.')
				return null
			}
			const keyword = match[1]!
			let type: ScenarioStep['type']
			if (keyword === 'And' || keyword === 'But') {
				if (!effective) {
					invalid(issues, path, 'steps', 'And/But cannot be the first step.')
					return null
				}
				type = effective
			}
			else {
				const phase = CORE_STEPS.indexOf(keyword as typeof CORE_STEPS[number])
				type = ['given', 'when', 'then'][phase]! as ScenarioStep['type']
			}
			if ((type === 'given' && effective !== null && effective !== 'given')
				|| (type === 'when' && effective === 'then')
				|| (type === 'then' && !whenCount)) {
				invalid(issues, path, 'steps', 'Effective step order must be Given* -> When+ -> Then+.')
				return null
			}
			effective = type
			if (type === 'when')
				whenCount++
			if (type === 'then')
				thenCount++
			steps.push({ type, text: match[2] })
			stepLines.push(cursor)
			lastStepLine = cursor
			cursor++
		}
		if (!whenCount || !thenCount) {
			invalid(issues, path, 'steps', 'A Scenario needs at least one When-family and one Then-family step.')
			return null
		}
		const value: ScenarioData = { id, title, steps, demonstrates }
		previous = { value, startLine, titleLine, stepLines, lastStepLine }
		entries.push(previous)
	}
	if (!entries.length) {
		invalid(issues, path, 'Scenario', 'A Scenario storage container requires at least one Scenario.')
		return null
	}
	return { path, label, lines, trailingNewline, entries }
}

export function renderScenarioSteps(steps: readonly ScenarioStep[]): string[] {
	return steps.map(step => `    ${step.type[0]!.toUpperCase()}${step.type.slice(1)} ${step.text}`)
}

function renderMetadata(scenario: ScenarioData): string[] {
	return [`  @spec:id:${scenario.id}`, ...scenario.demonstrates.slice()
		.sort(compareText)
		.map(id => `  @spec:demonstrates:${id}`)]
}

export function renderNewScenarioFile(scenario: ScenarioData): string {
	return [`Feature: ${scenario.title}`, ...renderMetadata(scenario), `  Scenario: ${scenario.title}`, ...renderScenarioSteps(scenario.steps), ''].join('\n')
}

/** Modify only semantic lines belonging to one Scenario; retain all comments. */
export function updateScenarioInContainer(
	container: ScenarioContainer,
	entry: ScenarioEntry,
	scenario: ScenarioData,
	fields: { title?: boolean, steps?: boolean, demonstrates?: boolean },
): string {
	const lines: string[] = []
	const firstStep = entry.stepLines[0]!
	for (let index = 0; index < container.lines.length; index++) {
		if (fields.demonstrates && index === entry.startLine) {
			lines.push(...renderMetadata(scenario))
			index = entry.titleLine - 1
		}
		else if (fields.title && index === entry.titleLine) {
			lines.push(`  Scenario: ${scenario.title}`)
		}
		else if (fields.steps && index === firstStep) {
			lines.push(...renderScenarioSteps(scenario.steps))
			// Preserve comment lines from the replaced step region, but discard
			// presentation-only blank lines and the old step lines themselves.
			lines.push(...container.lines.slice(firstStep + 1, entry.lastStepLine + 1)
				.filter(isComment))
			index = entry.lastStepLine
		}
		else {
			lines.push(container.lines[index]!)
		}
	}
	return lines.join('\n') + (container.trailingNewline ? '\n' : '')
}

export function deleteScenarioFromContainer(container: ScenarioContainer, entry: ScenarioEntry): string {
	const index = container.entries.indexOf(entry)
	if (index < 0 || container.entries.length <= 1)
		throw new Error('Cannot delete a missing or last Scenario from a retained container.')
	let start = entry.startLine
	const end = container.entries[index + 1]?.startLine ?? container.lines.length
	if (index === container.entries.length - 1) {
		// Remove the mandatory separator preceding the deleted last block.
		while (start > 0 && container.lines[start - 1] === '')
			start--
	}
	// Comments between this block's final step and the next Scenario metadata
	// may describe that next Scenario. Preserve them rather than deleting them
	// with the removed sibling's metadata and steps.
	const siblingPreamble = index < container.entries.length - 1
		? container.lines.slice(entry.lastStepLine + 1, end)
				.filter(isComment)
		: []
	const next = [
		...container.lines.slice(0, start),
		...siblingPreamble,
		...container.lines.slice(end),
	]
	return next.join('\n') + (container.trailingNewline ? '\n' : '')
}
