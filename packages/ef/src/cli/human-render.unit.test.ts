import type { MutationResultJson, ValidationResultJson } from './envelopes'
import { describe, expect, it } from 'vitest'
import { renderMutationHuman, renderQueryHuman, renderValidationHuman, renderVersionHuman } from './human-render'

const ANSI_CSI = String.fromCharCode(27, 91) // ESC '[' built at runtime, never a literal control character in source.

describe('renderValidationHuman', () => {
	const base: ValidationResultJson = {
		schema: 'ef/validation-result@1',
		kind: 'validation',
		scope: 'snapshot',
		baseline_oid: null,
		proposed_oid: null,
		integration_ref: 'refs/heads/main',
		expected_ref_oid: null,
		strict: false,
		warnings_as_errors: false,
		workspace: false,
		complete: true,
		valid: true,
		counts: { error: 0, warning: 0, info: 0 },
		exit_code: 0,
		diagnostics: [],
	}

	it('mentions the scope and reflects a valid, complete result without ANSI codes when color is disabled', () => {
		const text = renderValidationHuman(base, false)
		expect(text)
			.toContain('snapshot')
		expect(text.includes(ANSI_CSI))
			.toBe(false)
		expect(text.endsWith('\n'))
			.toBe(true)
	})

	it('includes ANSI escapes when color is enabled', () => {
		const text = renderValidationHuman(base, true)
		expect(text.includes(ANSI_CSI))
			.toBe(true)
	})

	it('lists every diagnostic code and message', () => {
		const withDiagnostics: ValidationResultJson = {
			...base,
			valid: false,
			counts: { error: 1, warning: 0, info: 0 },
			exit_code: 1,
			diagnostics: [{ code: 'EF-ID-004', severity: 'error', message: 'Artifact ID duplicated.', related: [] }],
		}
		const text = renderValidationHuman(withDiagnostics, false)
		expect(text)
			.toContain('EF-ID-004')
		expect(text)
			.toContain('Artifact ID duplicated.')
	})

	it('renders a warning-severity diagnostic without a source location as just path, no line:column suffix', () => {
		const withWarning: ValidationResultJson = {
			...base,
			diagnostics: [{ code: 'EF-VAL-005', severity: 'warning', message: 'Deprecated field.', path: '.engineering/req/REQ-001.md', related: [] }],
		}
		const text = renderValidationHuman(withWarning, false)
		expect(text)
			.toContain('(.engineering/req/REQ-001.md)')
		expect(text)
			.not.toMatch(/REQ-001\.md:\d/)
	})

	it('renders an info-severity diagnostic with a source location as path:line:column', () => {
		const withInfo: ValidationResultJson = {
			...base,
			diagnostics: [{ code: 'EF-VAL-010', severity: 'info', message: 'Informational.', path: '.engineering/req/REQ-002.md', location: { line: 3, column: 7 }, related: [] }],
		}
		const text = renderValidationHuman(withInfo, false)
		expect(text)
			.toContain('(.engineering/req/REQ-002.md:3:7)')
	})

	it('renders a diagnostic with no path and omits the parenthesized location suffix entirely', () => {
		const withoutPath: ValidationResultJson = {
			...base,
			diagnostics: [{ code: 'EF-VAL-001', severity: 'error', message: 'No path here.', related: [] }],
		}
		const text = renderValidationHuman(withoutPath, false)
		const diagnosticLine = text.split('\n')
			.find(line => line.includes('EF-VAL-001'))
		expect(diagnosticLine)
			.toBe('[error] EF-VAL-001 No path here.')
	})
})

describe('renderMutationHuman', () => {
	it('reflects dry-run vs applied status and lists every change path', () => {
		const dryRun: MutationResultJson = {
			schema: 'ef/mutation-result@1',
			kind: 'artifact-create',
			complete: true,
			applied: false,
			dry_run: true,
			changes: [{ action: 'create', path: '.engineering/req/REQ-031.md' }],
			artifact: null,
			diagnostics: [],
		}
		const text = renderMutationHuman(dryRun, false)
		expect(text)
			.toContain('.engineering/req/REQ-031.md')
		expect(text)
			.toMatch(/dry run/i)
	})

	it('reflects an applied mutation as "applied"', () => {
		const applied: MutationResultJson = {
			schema: 'ef/mutation-result@1',
			kind: 'artifact-create',
			complete: true,
			applied: true,
			dry_run: false,
			changes: [{ action: 'create', path: '.engineering/req/REQ-032.md' }],
			artifact: null,
			diagnostics: [],
		}
		const text = renderMutationHuman(applied, false)
		expect(text)
			.toContain('applied')
		expect(text)
			.not.toMatch(/dry run/i)
	})

	it('reflects a declined (not dry-run, not applied) mutation as "not applied"', () => {
		const declined: MutationResultJson = {
			schema: 'ef/mutation-result@1',
			kind: 'artifact-create',
			complete: true,
			applied: false,
			dry_run: false,
			changes: [],
			artifact: null,
			diagnostics: [],
		}
		const text = renderMutationHuman(declined, false)
		expect(text)
			.toContain('not applied')
	})
})

describe('renderQueryHuman', () => {
	it('renders valid, parseable JSON containing the original data', () => {
		const text = renderQueryHuman({ schema: 'ef/query-result@1', kind: 'lookup', complete: true, data: { found: false, artifact: null }, diagnostics: [] })
		const parsed = JSON.parse(text)
		expect(parsed.kind)
			.toBe('lookup')
		expect(parsed.data.found)
			.toBe(false)
	})
})

describe('renderVersionHuman', () => {
	it('includes the exact version string', () => {
		expect(renderVersionHuman('1.2.3'))
			.toContain('1.2.3')
	})
})
