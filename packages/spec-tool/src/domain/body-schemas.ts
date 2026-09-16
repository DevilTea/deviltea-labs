import type { Diagnostic } from './diagnostics'
import type { ArtifactKind, Status } from './model'
import { extractSections, isMeaningful, isPlaceholderOnly } from '../parsing/markdown'
import { diagnostic, sortDiagnostics } from './diagnostics'
import { requiresCompleteBody } from './lifecycle'
import { REQUIRED_SECTIONS } from './model'

export interface BodyValidationOptions {
	path?: string
}

/** Deterministic structural body validation; this intentionally does not assess prose semantics. */
export function validateBody(kind: ArtifactKind, status: Status, body: string, options: BodyValidationOptions = {}): Diagnostic[] {
	if (!requiresCompleteBody(kind, status))
		return []

	const sections = extractSections(body)
	const byHeading = new Map<string, number>()
	for (const section of sections) {
		if (!byHeading.has(section.heading))
			byHeading.set(section.heading, section.line)
	}

	const diagnostics: Diagnostic[] = []
	for (const heading of REQUIRED_SECTIONS[kind]) {
		const line = byHeading.get(heading)
		const section = sections.find(candidate => candidate.heading === heading)
		if (line === undefined || !section) {
			diagnostics.push(diagnostic('SPEC-BODY-INCOMPLETE', `Required section '${heading}' is missing.`, { path: options.path, section: heading }))
			continue
		}
		if (!isMeaningful(section.content))
			diagnostics.push(diagnostic('SPEC-BODY-INCOMPLETE', `Required section '${heading}' must contain meaningful content.`, { path: options.path, section: heading, location: { line, column: 1 } }))
		else if (isPlaceholderOnly(section.content))
			diagnostics.push(diagnostic('SPEC-BODY-INCOMPLETE', `Required section '${heading}' contains placeholder-only content.`, { path: options.path, section: heading, location: { line, column: 1 } }))
	}
	return sortDiagnostics(diagnostics)
}
