import type { ArtifactSummaryProjection } from '../application/query-projection'
import type { QueryResult } from '../application/query-types'
import type { ValidationSummary } from '../application/snapshot-validation'
import type { Diagnostic } from '../domain/diagnostics'
import { describe, expect, it } from 'vitest'
import { buildMutationResultJson, buildValidationResultJson, buildVersionResultJson, queryResultToJson } from './envelopes'

describe('buildValidationResultJson', () => {
	it('produces every required key with the exact documented example shape for a valid transition', () => {
		const summary: ValidationSummary = {
			scope: 'transition',
			baselineOid: '0123456789abcdef0123456789abcdef01234567',
			proposedOid: 'fedcba9876543210fedcba9876543210fedcba98',
			integrationRef: 'refs/heads/main',
			expectedRefOid: '0123456789abcdef0123456789abcdef01234567',
			strict: true,
			warningsAsErrors: true,
			complete: true,
			valid: true,
			counts: { error: 0, warning: 0, info: 0 },
			exitCode: 0,
		}

		const json = buildValidationResultJson(summary, [], true)

		expect(json)
			.toEqual({
				schema: 'ef/validation-result@1',
				kind: 'validation',
				scope: 'transition',
				baseline_oid: '0123456789abcdef0123456789abcdef01234567',
				proposed_oid: 'fedcba9876543210fedcba9876543210fedcba98',
				integration_ref: 'refs/heads/main',
				expected_ref_oid: '0123456789abcdef0123456789abcdef01234567',
				strict: true,
				warnings_as_errors: true,
				workspace: true,
				complete: true,
				valid: true,
				counts: { error: 0, warning: 0, info: 0 },
				exit_code: 0,
				diagnostics: [],
			})
	})

	it('keeps every nullable field as explicit null for snapshot scope, never an omitted key', () => {
		const summary: ValidationSummary = {
			scope: 'snapshot',
			baselineOid: null,
			proposedOid: null,
			integrationRef: 'refs/heads/main',
			expectedRefOid: null,
			strict: false,
			warningsAsErrors: false,
			complete: true,
			valid: true,
			counts: { error: 0, warning: 0, info: 0 },
			exitCode: 0,
		}

		const json = buildValidationResultJson(summary, [], false)
		const roundTripped = JSON.parse(JSON.stringify(json))

		expect(roundTripped.baseline_oid)
			.toBeNull()
		expect(roundTripped.proposed_oid)
			.toBeNull()
		expect(roundTripped.expected_ref_oid)
			.toBeNull()
		expect(Object.keys(roundTripped)
			.sort())
			.toEqual([
				'baseline_oid',
				'complete',
				'counts',
				'exit_code',
				'expected_ref_oid',
				'integration_ref',
				'kind',
				'proposed_oid',
				'schema',
				'scope',
				'strict',
				'valid',
				'warnings_as_errors',
				'workspace',
				'diagnostics',
			].sort())
	})

	it('converts embedded diagnostics through the same wire mapping', () => {
		const summary: ValidationSummary = {
			scope: 'snapshot',
			baselineOid: null,
			proposedOid: null,
			integrationRef: null,
			expectedRefOid: null,
			strict: false,
			warningsAsErrors: false,
			complete: true,
			valid: false,
			counts: { error: 1, warning: 0, info: 0 },
			exitCode: 1,
		}
		const diagnostics: Diagnostic[] = [
			{ code: 'EF-ID-004', severity: 'error', message: 'dup', artifactId: 'REQ-031', related: [] },
		]

		const json = buildValidationResultJson(summary, diagnostics, false)
		expect(json.diagnostics)
			.toEqual([{ code: 'EF-ID-004', severity: 'error', message: 'dup', artifact_id: 'REQ-031', related: [] }])
	})

	it('produces scope "range" with the exact documented top-level key set (no new keys) and diagnostics carrying commit_oid', () => {
		const summary: ValidationSummary = {
			scope: 'range',
			baselineOid: '0123456789abcdef0123456789abcdef01234567',
			proposedOid: 'fedcba9876543210fedcba9876543210fedcba98',
			integrationRef: 'refs/heads/main',
			expectedRefOid: '0123456789abcdef0123456789abcdef01234567',
			strict: false,
			warningsAsErrors: false,
			complete: true,
			valid: false,
			counts: { error: 1, warning: 0, info: 0 },
			exitCode: 1,
		}
		const diagnostics: Diagnostic[] = [
			{ code: 'EF-VAL-013', severity: 'error', message: 'removed EF state', commitOid: 'abc123', related: [] },
		]

		const json = buildValidationResultJson(summary, diagnostics, false)
		expect(json.scope)
			.toBe('range')
		expect(json.diagnostics)
			.toEqual([{ code: 'EF-VAL-013', severity: 'error', message: 'removed EF state', commit_oid: 'abc123', related: [] }])
		expect(Object.keys(JSON.parse(JSON.stringify(json)))
			.sort())
			.toEqual([
				'baseline_oid',
				'complete',
				'counts',
				'diagnostics',
				'exit_code',
				'expected_ref_oid',
				'integration_ref',
				'kind',
				'proposed_oid',
				'schema',
				'scope',
				'strict',
				'valid',
				'warnings_as_errors',
				'workspace',
			])
	})
})

describe('buildMutationResultJson', () => {
	const artifact: ArtifactSummaryProjection = {
		schema: 'ef/requirement@1',
		type: 'requirement',
		id: 'REQ-031',
		title: 'Search Result Filtering',
		status: 'draft',
		summary: 'Search results must support filtering by supported criteria.',
		tags: [],
		relations: [],
		resources: [],
		path: '.engineering/req/REQ-031.md',
	}

	it('matches the documented artifact-create example shape exactly', () => {
		const json = buildMutationResultJson({
			kind: 'artifact-create',
			complete: true,
			applied: false,
			dryRun: true,
			changes: [{ action: 'create', path: '.engineering/req/REQ-031.md' }],
			artifact,
			diagnostics: [],
		})

		expect(json)
			.toEqual({
				schema: 'ef/mutation-result@1',
				kind: 'artifact-create',
				complete: true,
				applied: false,
				dry_run: true,
				changes: [{ action: 'create', path: '.engineering/req/REQ-031.md' }],
				artifact,
				diagnostics: [],
			})
	})

	it('sorts changes by canonical path in bytewise order regardless of input order', () => {
		const json = buildMutationResultJson({
			kind: 'init',
			complete: true,
			applied: true,
			dryRun: false,
			changes: [
				{ action: 'create', path: '.engineering/req' },
				{ action: 'create', path: '.engineering/PROJECT.md' },
				{ action: 'create', path: '.engineering/.gitignore' },
			],
			artifact: null,
			diagnostics: [],
		})

		expect(json.changes.map(c => c.path))
			.toEqual(['.engineering/.gitignore', '.engineering/PROJECT.md', '.engineering/req'])
	})

	it('keeps artifact explicit null rather than an omitted key when unavailable', () => {
		const json = buildMutationResultJson({
			kind: 'init',
			complete: false,
			applied: false,
			dryRun: false,
			changes: [],
			artifact: null,
			diagnostics: [],
		})
		const roundTripped = JSON.parse(JSON.stringify(json))
		expect(roundTripped.artifact)
			.toBeNull()
		expect('artifact' in roundTripped)
			.toBe(true)
	})
})

describe('queryResultToJson', () => {
	it('passes through kind-specific data untouched and converts only the diagnostics array', () => {
		const result: QueryResult = {
			schema: 'ef/query-result@1',
			kind: 'lookup',
			complete: true,
			data: { found: false, artifact: null },
			diagnostics: [{ code: 'EF-QRY-003', severity: 'info', message: 'not found', related: [] }],
		}

		const json = queryResultToJson(result)
		expect(json.schema)
			.toBe('ef/query-result@1')
		expect(json.kind)
			.toBe('lookup')
		expect(json.data)
			.toEqual({ found: false, artifact: null })
		expect(json.diagnostics)
			.toEqual([{ code: 'EF-QRY-003', severity: 'info', message: 'not found', related: [] }])
	})
})

describe('buildVersionResultJson', () => {
	it('produces the exact documented shape with ef_core_major fixed to 1', () => {
		expect(buildVersionResultJson('1.2.3'))
			.toEqual({ schema: 'ef/version-result@1', version: '1.2.3', ef_core_major: 1 })
	})
})
