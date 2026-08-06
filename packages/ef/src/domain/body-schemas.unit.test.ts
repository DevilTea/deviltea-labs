import type { ExtractedSections } from '../parsing/markdown'
import type { BodyValidationInput } from './body-schemas'
import { describe, expect, it } from 'vitest'
import { extractSections, parseBody } from '../parsing/markdown'
import { validateBody } from './body-schemas'
import { severityOf } from './diagnostic-codes'

function parse(bodyText: string): ExtractedSections {
	const result = parseBody(bodyText, 0)
	if (!result.ok)
		throw new Error(`unexpected parse failure: ${result.diagnostic.code}`)
	return extractSections(result.root)
}

function run(input: Omit<BodyValidationInput, 'body' | 'path'> & { path?: string, bodyText: string }) {
	const { bodyText, path = 'FILE.md', ...rest } = input
	return validateBody({ ...rest, path, body: parse(bodyText) })
}

function codes(diagnostics: ReturnType<typeof run>): string[] {
	return diagnostics.map(d => d.code)
}

describe('validateBody - PROJECT', () => {
	const validBody = [
		'## Vision',
		'',
		'Provide a stable engineering knowledge graph.',
		'',
		'## Scope',
		'',
		'The workspace repository and its declared linked repositories.',
		'',
		'## Non-goals',
		'',
		'No additional non-goals are currently defined.',
		'',
		'## Context',
		'',
		'The project began as an internal tool.',
		'',
		'## Terminology',
		'',
		'| Term | Definition | Avoid or aliases |',
		'|---|---|---|',
		'| Artifact | A formal EF document with stable project-scoped identity. | record, entity |',
		'| Workspace | The project repository together with its declared linked-repository slots. | project group |',
	].join('\n')

	it('accepts a complete active PROJECT body', () => {
		const diagnostics = run({ type: 'project', status: 'active', bodyText: validBody })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts a header-only (zero-row) Terminology table', () => {
		const bodyText = [
			'## Vision',
			'',
			'Text.',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'No additional non-goals are currently defined.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-001 for each missing required heading', () => {
		const bodyText = ['## Vision', '', 'Text.'].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-001', 'EF-BODY-001', 'EF-BODY-001', 'EF-BODY-001'])
		expect(diagnostics.every(d => d.severity === severityOf('EF-BODY-001')))
			.toBe(true)
		expect(diagnostics.map(d => d.section))
			.toEqual(['Scope', 'Non-goals', 'Context', 'Terminology'])
		expect(diagnostics.every(d => d.location === undefined))
			.toBe(true)
	})

	it('reports EF-BODY-002 for a duplicated required heading', () => {
		const bodyText = [
			validBody,
			'',
			'## Vision',
			'',
			'Duplicate.',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-002'])
		expect(diagnostics[0]!.section)
			.toBe('Vision')
		expect(diagnostics[0]!.location)
			.toBeDefined()
	})

	it('reports EF-BODY-003 when required headings are out of order', () => {
		const bodyText = [
			'## Scope',
			'',
			'Text.',
			'',
			'## Vision',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'Text.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-003'])
		expect(diagnostics[0]!.section)
			.toBe('Scope')
	})

	it('reports EF-BODY-006 for an H1 heading', () => {
		const bodyText = ['# Title', '', validBody].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		// The H1 itself is also meaningful content before the first H2 (EF-BODY-007).
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-006', 'EF-BODY-007'])
	})

	it('reports only EF-BODY-006 for an H1 heading that appears after the first H2 (not before it)', () => {
		const bodyText = [validBody, '', '# Trailing Title'].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-006'])
	})

	it('reports EF-BODY-007 for meaningful content before the first H2', () => {
		const bodyText = ['Some intro text.', '', validBody].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-007'])
	})

	it('does not report EF-BODY-007 for whitespace or an HTML comment before the first H2', () => {
		const bodyText = ['<!-- draft note -->', '', validBody].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-004 for an empty required section', () => {
		const bodyText = [
			'## Vision',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'Text.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-004'])
		expect(diagnostics[0]!.section)
			.toBe('Vision')
	})

	it('reports EF-BODY-012, not EF-BODY-004, for placeholder-only required content', () => {
		const bodyText = [
			'## Vision',
			'',
			'TODO',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'Text.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-012'])
		expect(diagnostics[0]!.section)
			.toBe('Vision')
	})

	it('reports EF-BODY-008 for a custom heading placed before all required core sections', () => {
		const bodyText = [
			'## Vision',
			'',
			'Text.',
			'',
			'## Custom Note',
			'',
			'Text.',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'Text.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-008'])
		expect(diagnostics[0]!.section)
			.toBe('Custom Note')
	})

	it('accepts a custom heading placed after all required core sections', () => {
		const bodyText = [
			validBody,
			'',
			'## Custom Note',
			'',
			'Text.',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-010 when PROJECT contains a Lifecycle section', () => {
		const bodyText = [
			validBody,
			'',
			'## Lifecycle',
			'',
			'Retired through CHG-1.',
		].join('\n')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-010'])
	})
})

describe('validateBody - PROJECT Terminology (EF-BODY-018 / EF-BODY-019)', () => {
	function projectWith(terminology: string): string {
		return [
			'## Vision',
			'',
			'Text.',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Non-goals',
			'',
			'Text.',
			'',
			'## Context',
			'',
			'Text.',
			'',
			'## Terminology',
			'',
			terminology,
		].join('\n')
	}

	it('reports EF-BODY-018 when the table is missing', () => {
		const bodyText = projectWith('There is no table here yet.')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
		expect(diagnostics[0]!.section)
			.toBe('Terminology')
	})

	it('reports EF-BODY-018 when prose precedes the table', () => {
		const bodyText = projectWith([
			'Some explanation first.',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-018 for a duplicated table', () => {
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'| Artifact | Def. | |',
			'',
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-018 for wrong column names', () => {
		const bodyText = projectWith([
			'| Word | Meaning | Avoid or aliases |',
			'|---|---|---|',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-018 for an empty Term or Definition cell', () => {
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'|  | Def. | |',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-018 for a duplicate Term after trimming', () => {
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'| Artifact | Def one. | |',
			'| Artifact | Def two. | |',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-018 for a non-NFC Term', () => {
		// "é" as "e" + combining acute accent (NFD), not NFC.
		const nfdTerm = 'é'
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			`| ${nfdTerm} | Def. | |`,
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-018'])
	})

	it('reports EF-BODY-019 (warning) when rows are not in bytewise term order', () => {
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'| Workspace | Def. | |',
			'| Artifact | Def. | |',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-019'])
		expect(diagnostics[0]!.severity)
			.toBe('warning')
	})

	it('accepts rows already in bytewise term order', () => {
		const bodyText = projectWith([
			'| Term | Definition | Avoid or aliases |',
			'|---|---|---|',
			'| Artifact | Def. | |',
			'| Workspace | Def. | |',
		].join('\n'))
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('does not report generic EF-BODY-004 for a malformed Terminology section', () => {
		const bodyText = projectWith('No table at all.')
		const diagnostics = run({ type: 'project', status: 'active', bodyText })
		expect(diagnostics.some(d => d.code === 'EF-BODY-004'))
			.toBe(false)
	})
})

describe('validateBody - REQ', () => {
	const minimalActiveBody = [
		'## Requirement',
		'',
		'The system must return a stable error code when a search filter is invalid.',
		'',
		'## Rationale',
		'',
		'Stable error codes allow clients to handle invalid input without parsing',
		'human-readable error messages.',
		'',
		'## Acceptance Criteria',
		'',
		'- An unsupported filter returns `invalid_filter`.',
		'- The response status is `400`.',
		'- The response does not expose an internal stack trace.',
	].join('\n')

	it('accepts the minimal active REQ body from the specification example', () => {
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText: minimalActiveBody })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts the valid draft REQ skeleton (empty required sections) from the specification example', () => {
		const bodyText = ['## Requirement', '', '## Rationale', '', '## Acceptance Criteria'].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'draft', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('rejects the same skeleton once active (missing meaningful content and list item)', () => {
		const bodyText = ['## Requirement', '', '## Rationale', '', '## Acceptance Criteria'].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-004', 'EF-BODY-004', 'EF-BODY-005'])
		expect(diagnostics.map(d => d.section))
			.toEqual(['Requirement', 'Rationale', 'Acceptance Criteria'])
	})

	it('reports EF-BODY-012 three times (not EF-BODY-004/005) for the specification\'s "Invalid active placeholder" example', () => {
		const bodyText = [
			'## Requirement',
			'',
			'TODO',
			'',
			'## Rationale',
			'',
			'TBD',
			'',
			'## Acceptance Criteria',
			'',
			'- Lorem ipsum.',
		].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-012', 'EF-BODY-012', 'EF-BODY-012'])
		expect(diagnostics.map(d => d.section))
			.toEqual(['Requirement', 'Rationale', 'Acceptance Criteria'])
	})

	it('reports EF-BODY-005 for Acceptance Criteria with prose but no list item', () => {
		const bodyText = [
			'## Requirement',
			'',
			'The system must reject unsupported filters.',
			'',
			'## Rationale',
			'',
			'Clients require deterministic validation.',
			'',
			'## Acceptance Criteria',
			'',
			'An unsupported filter returns `invalid_filter`.',
		].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-005'])
		expect(diagnostics[0]!.section)
			.toBe('Acceptance Criteria')
	})

	it('accepts the specification\'s "Valid custom section placement" example', () => {
		const bodyText = [
			'## Requirement',
			'',
			'The system must reject unsupported filters.',
			'',
			'## Rationale',
			'',
			'Clients require deterministic input validation.',
			'',
			'## Acceptance Criteria',
			'',
			'- An unsupported filter returns `invalid_filter`.',
			'',
			'## API Examples',
			'',
			'```json',
			'{"error": "invalid_filter"}',
			'```',
		].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-008 for the specification\'s "Invalid custom section placement" example', () => {
		const bodyText = [
			'## Requirement',
			'',
			'The system must reject unsupported filters.',
			'',
			'## API Examples',
			'',
			'Example content appears before all required core sections.',
			'',
			'## Rationale',
			'',
			'Clients require deterministic validation.',
			'',
			'## Acceptance Criteria',
			'',
			'- An unsupported filter returns `invalid_filter`.',
		].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-008'])
		expect(diagnostics[0]!.section)
			.toBe('API Examples')
	})

	it('reports EF-BODY-010 for an active REQ containing a Lifecycle section', () => {
		const bodyText = [minimalActiveBody, '', '## Lifecycle', '', 'Not yet applicable.'].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-010'])
	})

	it('reports EF-BODY-010 for a draft REQ containing a Lifecycle section', () => {
		const bodyText = ['## Requirement', '', '## Rationale', '', '## Acceptance Criteria', '', '## Lifecycle', '', 'Retired before activation.'].join('\n')
		const diagnostics = run({ type: 'requirement', status: 'draft', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-010'])
	})

	describe('terminal Lifecycle (retired/superseded)', () => {
		function withLifecycle(lifecycleBody: string): string {
			return [minimalActiveBody, '', '## Lifecycle', '', lifecycleBody].join('\n')
		}

		it('accepts a superseded REQ with a meaningful final Lifecycle section', () => {
			const bodyText = withLifecycle('Superseded by REQ-070 through CHG-182 after the filtering contracts were consolidated.')
			const diagnostics = run({ type: 'requirement', status: 'superseded', bodyText })
			expect(diagnostics)
				.toEqual([])
		})

		it('accepts a retired-from-active REQ (previouslyActive: true) preserving the complete active body plus Lifecycle', () => {
			const bodyText = withLifecycle('Retired through CHG-190 because the upstream capability no longer exists.')
			const diagnostics = run({ type: 'requirement', status: 'retired', previouslyActive: true, bodyText })
			expect(diagnostics)
				.toEqual([])
		})

		it('accepts a retired-from-draft REQ (previouslyActive omitted) with incomplete core content but a meaningful Lifecycle section', () => {
			const bodyText = [
				'## Requirement',
				'',
				'## Rationale',
				'',
				'## Acceptance Criteria',
				'',
				'## Lifecycle',
				'',
				'Retired before activation because the product direction changed.',
			].join('\n')
			const diagnostics = run({ type: 'requirement', status: 'retired', bodyText })
			expect(diagnostics)
				.toEqual([])
		})

		it('reports EF-BODY-004/005 (not skipped) for a retired-from-active REQ whose core content is incomplete', () => {
			const bodyText = [
				'## Requirement',
				'',
				'## Rationale',
				'',
				'## Acceptance Criteria',
				'',
				'## Lifecycle',
				'',
				'Retired through CHG-190.',
			].join('\n')
			const diagnostics = run({ type: 'requirement', status: 'retired', previouslyActive: true, bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-004', 'EF-BODY-004', 'EF-BODY-005'])
		})

		it('reports EF-BODY-009 when a terminal REQ has no Lifecycle section at all', () => {
			const diagnostics = run({ type: 'requirement', status: 'retired', bodyText: minimalActiveBody })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-009'])
		})

		it('reports EF-BODY-009 when the Lifecycle section is placeholder-only', () => {
			const bodyText = withLifecycle('TBD')
			const diagnostics = run({ type: 'requirement', status: 'retired', previouslyActive: true, bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-009'])
		})

		it('reports EF-BODY-009 when the Lifecycle section is empty', () => {
			const bodyText = [minimalActiveBody, '', '## Lifecycle'].join('\n')
			const diagnostics = run({ type: 'requirement', status: 'retired', previouslyActive: true, bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-009'])
		})

		it('reports EF-BODY-011 when Lifecycle is not the final H2 section', () => {
			const bodyText = [
				'## Requirement',
				'',
				'Text.',
				'',
				'## Rationale',
				'',
				'Text.',
				'',
				'## Lifecycle',
				'',
				'Retired through CHG-190.',
				'',
				'## Acceptance Criteria',
				'',
				'- Item.',
			].join('\n')
			const diagnostics = run({ type: 'requirement', status: 'retired', previouslyActive: true, bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-011'])
		})
	})
})

describe('validateBody - PRD, ADR, POL required-list and meaningful sections', () => {
	it('reports EF-BODY-005 for PRD Success Criteria with no list item', () => {
		const bodyText = [
			'## Problem',
			'',
			'Text.',
			'',
			'## User Need',
			'',
			'Text.',
			'',
			'## Desired Outcome',
			'',
			'Text.',
			'',
			'## Success Criteria',
			'',
			'Text without a list.',
			'',
			'## Non-goals',
			'',
			'Text.',
		].join('\n')
		const diagnostics = run({ type: 'prd', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-005'])
		expect(diagnostics[0]!.section)
			.toBe('Success Criteria')
	})

	it('accepts a complete active PRD body', () => {
		const bodyText = [
			'## Problem',
			'',
			'Text.',
			'',
			'## User Need',
			'',
			'Text.',
			'',
			'## Desired Outcome',
			'',
			'Text.',
			'',
			'## Success Criteria',
			'',
			'- Observable outcome.',
			'',
			'## Non-goals',
			'',
			'No additional non-goals are currently defined.',
		].join('\n')
		const diagnostics = run({ type: 'prd', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts a complete active ADR body (no required list sections)', () => {
		const bodyText = [
			'## Context',
			'',
			'Text.',
			'',
			'## Decision',
			'',
			'Text.',
			'',
			'## Alternatives',
			'',
			'Text.',
			'',
			'## Consequences',
			'',
			'Text.',
		].join('\n')
		const diagnostics = run({ type: 'decision', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-005 for POL Compliance with no list item', () => {
		const bodyText = [
			'## Policy',
			'',
			'Text.',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Rationale',
			'',
			'Text.',
			'',
			'## Compliance',
			'',
			'Text without a list.',
		].join('\n')
		const diagnostics = run({ type: 'policy', status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-005'])
		expect(diagnostics[0]!.section)
			.toBe('Compliance')
	})

	it('accepts a complete active POL body', () => {
		const bodyText = [
			'## Policy',
			'',
			'Text.',
			'',
			'## Scope',
			'',
			'Text.',
			'',
			'## Rationale',
			'',
			'Text.',
			'',
			'## Compliance',
			'',
			'- Automated lint check.',
		].join('\n')
		const diagnostics = run({ type: 'policy', status: 'active', bodyText })
		expect(diagnostics)
			.toEqual([])
	})
})

describe('validateBody - EF-BODY-016 (unrecognized Artifact type)', () => {
	it('reports only EF-BODY-016 and suppresses every other check', () => {
		const bodyText = ['# Title', '', 'Content before any H2.'].join('\n')
		const diagnostics = run({ type: 'not-a-real-type' as never, status: 'active', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-016'])
	})
})

describe('validateBody - CHG', () => {
	const completedSemanticChange = [
		'## Rationale',
		'',
		'The filtering requirements were consolidated to remove overlapping definitions',
		'and establish one observable contract.',
		'',
		'## Sources',
		'',
		'- Product intent recorded in PRD-012.',
		'- Existing behavior described by REQ-031.',
		'- Direct maintainer decision to consolidate duplicate requirements.',
		'',
		'## Changes',
		'',
		'- Introduced REQ-070.',
		'- Superseded REQ-031 with REQ-070.',
		'- Added the canonical search-filter JSON Schema.',
		'',
		'## Verification',
		'',
		'Result: passed',
		'',
		'- EF schema, relation, lifecycle, and graph validation passed.',
		'- The JSON Schema validator passed.',
		'- Search integration tests passed.',
	].join('\n')

	const completedEditorialChange = [
		'## Rationale',
		'',
		'Correct a spelling error without changing the observable requirement.',
		'',
		'## Sources',
		'',
		'- Direct maintainer review of REQ-044.',
		'',
		'## Changes',
		'',
		'- Corrected spelling in REQ-044.',
		'',
		'## Verification',
		'',
		'Result: not-applicable',
		'',
		'No runtime implementation or observable behavior changed. EF structural and',
		'graph validation passed.',
	].join('\n')

	const retiredChange = [
		'## Rationale',
		'',
		'The migration was stopped after the upstream indexing service was discontinued.',
		'',
		'## Sources',
		'',
		'- Upstream service discontinuation notice reviewed by the maintainers.',
		'',
		'## Changes',
		'',
		'No authoritative changes were applied. A prototype was evaluated before the',
		'transaction was retired.',
		'',
		'## Verification',
		'',
		'Result: not-completed',
		'',
		'The prototype failed the compatibility check and the migration did not proceed.',
	].join('\n')

	it('accepts the specification\'s "Completed semantic change" example', () => {
		const diagnostics = run({ type: 'change', status: 'completed', bodyText: completedSemanticChange })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts the specification\'s "Completed editorial change" example', () => {
		const diagnostics = run({ type: 'change', status: 'completed', bodyText: completedEditorialChange })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts the specification\'s "Retired change" example', () => {
		const diagnostics = run({ type: 'change', status: 'retired', bodyText: retiredChange })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts an incomplete draft CHG with no final sections at all', () => {
		const diagnostics = run({ type: 'change', status: 'draft', bodyText: 'Draft notes without any headings yet? No—content before H2.\n\n## Rationale\n\nPlanned work.' })
		// Content before the first H2 is still forbidden even in draft.
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-007'])
	})

	it('accepts a draft CHG missing every final section', () => {
		const diagnostics = run({ type: 'change', status: 'draft', bodyText: '## Rationale\n\nPlanned work.' })
		expect(diagnostics)
			.toEqual([])
	})

	it('accepts a draft CHG with a pending Verification marker', () => {
		const bodyText = [
			'## Rationale',
			'',
			'Planned work.',
			'',
			'## Verification',
			'',
			'Result: pending',
		].join('\n')
		const diagnostics = run({ type: 'change', status: 'draft', bodyText })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-001 for each missing final section once completed', () => {
		const diagnostics = run({ type: 'change', status: 'completed', bodyText: '## Rationale\n\nDone.' })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-001', 'EF-BODY-001', 'EF-BODY-001'])
		expect(diagnostics.map(d => d.section))
			.toEqual(['Sources', 'Changes', 'Verification'])
	})

	it('reports EF-BODY-005 for completed Changes with no list item', () => {
		const bodyText = [
			'## Rationale',
			'',
			'Text.',
			'',
			'## Sources',
			'',
			'- Source.',
			'',
			'## Changes',
			'',
			'Changed something, no list.',
			'',
			'## Verification',
			'',
			'Result: passed',
			'',
			'- Check performed.',
		].join('\n')
		const diagnostics = run({ type: 'change', status: 'completed', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-005'])
		expect(diagnostics[0]!.section)
			.toBe('Changes')
	})

	it('accepts retired Changes with meaningful prose but no list item', () => {
		const diagnostics = run({ type: 'change', status: 'retired', bodyText: retiredChange })
		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-BODY-004 for retired Changes that is empty', () => {
		const bodyText = [
			'## Rationale',
			'',
			'Text.',
			'',
			'## Sources',
			'',
			'- Source.',
			'',
			'## Changes',
			'',
			'## Verification',
			'',
			'Result: not-completed',
			'',
			'Explanation.',
		].join('\n')
		const diagnostics = run({ type: 'change', status: 'retired', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-004'])
		expect(diagnostics[0]!.section)
			.toBe('Changes')
	})

	describe('verification result marker (EF-BODY-014 / EF-CHG-010)', () => {
		function completedWith(verification: string): string {
			return [
				'## Rationale',
				'',
				'Text.',
				'',
				'## Sources',
				'',
				'- Source.',
				'',
				'## Changes',
				'',
				'- Change.',
				'',
				'## Verification',
				'',
				verification,
			].join('\n')
		}

		function retiredWith(verification: string): string {
			return [
				'## Rationale',
				'',
				'Text.',
				'',
				'## Sources',
				'',
				'- Source.',
				'',
				'## Changes',
				'',
				'No authoritative changes were applied.',
				'',
				'## Verification',
				'',
				verification,
			].join('\n')
		}

		it('reports EF-BODY-014 when Verification has no marker paragraph at all', () => {
			const bodyText = completedWith('')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('reports EF-BODY-014 for an unrecognized marker form', () => {
			const bodyText = completedWith('Result: PASSED')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('reports EF-BODY-014 when "Result: passed" has no supporting list item', () => {
			const bodyText = completedWith('Result: passed\n\nNo checks listed.')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('accepts "Result: passed" with a supporting list item', () => {
			const bodyText = completedWith('Result: passed\n\n- Check performed.')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(diagnostics)
				.toEqual([])
		})

		it('reports EF-BODY-014 when "Result: not-applicable" has no rationale paragraph after the marker', () => {
			const bodyText = completedWith('Result: not-applicable')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('accepts "Result: not-applicable" with a rationale paragraph after the marker', () => {
			const bodyText = completedWith('Result: not-applicable\n\nNo behavior changed.')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(diagnostics)
				.toEqual([])
		})

		it('reports EF-CHG-010 for a completed CHG with a structurally valid "Result: not-completed" marker', () => {
			const bodyText = completedWith('Result: not-completed\n\nExplanation.')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-CHG-010'])
		})

		it('reports EF-CHG-010 for a completed CHG with a structurally valid "Result: pending" marker', () => {
			const bodyText = completedWith('Result: pending')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-CHG-010'])
		})

		it('reports EF-BODY-014 when a retired CHG has no marker at all', () => {
			const bodyText = retiredWith('')
			const diagnostics = run({ type: 'change', status: 'retired', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('reports EF-BODY-014 when "Result: not-completed" has no explanation after the marker', () => {
			const bodyText = retiredWith('Result: not-completed')
			const diagnostics = run({ type: 'change', status: 'retired', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-014'])
		})

		it('reports EF-CHG-010 for a retired CHG with a structurally valid "Result: passed" marker', () => {
			const bodyText = retiredWith('Result: passed\n\n- Check.')
			const diagnostics = run({ type: 'change', status: 'retired', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-CHG-010'])
		})

		it('reports EF-CHG-010 for a retired CHG with a structurally valid "Result: not-applicable" marker', () => {
			const bodyText = retiredWith('Result: not-applicable\n\nExplanation.')
			const diagnostics = run({ type: 'change', status: 'retired', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-CHG-010'])
		})

		it('suppresses Verification-marker findings when a required CHG heading is missing', () => {
			const bodyText = [
				'## Rationale',
				'',
				'Text.',
				'',
				'## Changes',
				'',
				'- Change.',
				'',
				'## Verification',
				'',
				'Result: not-a-real-value',
			].join('\n')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-001'])
			expect(diagnostics[0]!.section)
				.toBe('Sources')
		})

		it('suppresses Verification-marker findings when a required CHG heading is duplicated', () => {
			const bodyText = [
				completedWith('Result: not-a-real-value'),
				'',
				'## Rationale',
				'',
				'Duplicate.',
			].join('\n')
			const diagnostics = run({ type: 'change', status: 'completed', bodyText })
			expect(codes(diagnostics))
				.toEqual(['EF-BODY-002'])
			expect(diagnostics[0]!.section)
				.toBe('Rationale')
		})
	})

	it('reports EF-BODY-010 when a completed CHG contains a Lifecycle section', () => {
		const bodyText = [completedSemanticChange, '', '## Lifecycle', '', 'Not applicable to CHG.'].join('\n')
		const diagnostics = run({ type: 'change', status: 'completed', bodyText })
		expect(codes(diagnostics))
			.toEqual(['EF-BODY-010'])
	})
})
