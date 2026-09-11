import type { Diagnostic } from '../domain/diagnostics'
import { describe, expect, it } from 'vitest'
import { diagnosticsToJson, diagnosticToJson } from './diagnostics-json'

describe('diagnosticToJson', () => {
	it('converts artifactId to artifact_id and drops undefined optional keys entirely', () => {
		const diagnostic: Diagnostic = {
			code: 'EF-REL-003',
			severity: 'error',
			message: 'Relation target \'REQ-999\' does not exist.',
			path: '.engineering/req/REQ-031.md',
			artifactId: 'REQ-031',
			location: { line: 12, column: 13 },
			field: 'relations[0].target',
			related: [],
		}

		const json = diagnosticToJson(diagnostic)

		expect(json)
			.toEqual({
				code: 'EF-REL-003',
				severity: 'error',
				message: 'Relation target \'REQ-999\' does not exist.',
				path: '.engineering/req/REQ-031.md',
				artifact_id: 'REQ-031',
				location: { line: 12, column: 13 },
				field: 'relations[0].target',
				related: [],
			})

		// `JSON.stringify` must drop the omitted optional keys, not serialize them as `null`.
		expect(JSON.parse(JSON.stringify(json)))
			.toEqual({
				code: 'EF-REL-003',
				severity: 'error',
				message: 'Relation target \'REQ-999\' does not exist.',
				path: '.engineering/req/REQ-031.md',
				artifact_id: 'REQ-031',
				location: { line: 12, column: 13 },
				field: 'relations[0].target',
				related: [],
			})
	})

	it('omits path/artifact_id/location/field/section when the diagnostic has none of them', () => {
		const diagnostic: Diagnostic = {
			code: 'EF-QRY-007',
			severity: 'error',
			message: 'The requested relation graph is invalid.',
			related: [],
		}

		const json = diagnosticToJson(diagnostic)
		expect(Object.keys(JSON.parse(JSON.stringify(json)))
			.sort())
			.toEqual(['code', 'message', 'related', 'severity'])
	})

	it('converts related-location entries with the same field mapping, keeping their required message', () => {
		const diagnostic: Diagnostic = {
			code: 'EF-ID-004',
			severity: 'error',
			message: 'Artifact ID \'REQ-031\' is duplicated.',
			path: '.engineering/req/REQ-031.md',
			artifactId: 'REQ-031',
			related: [
				{ path: '.engineering/req/REQ-044.md', message: 'Duplicate identity is also declared here.' },
			],
		}

		const json = diagnosticToJson(diagnostic)
		expect(json.related)
			.toEqual([{ path: '.engineering/req/REQ-044.md', message: 'Duplicate identity is also declared here.' }])
	})

	it('includes commit_oid when the diagnostic carries commitOid, and omits it (not null) otherwise', () => {
		const withCommitOid: Diagnostic = {
			code: 'EF-VAL-013',
			severity: 'error',
			message: 'range removal',
			commitOid: 'abc123',
			related: [],
		}
		const json = diagnosticToJson(withCommitOid)
		expect(json.commit_oid)
			.toBe('abc123')

		const withoutCommitOid: Diagnostic = { code: 'EF-VAL-013', severity: 'error', message: 'range removal', related: [] }
		expect(Object.keys(JSON.parse(JSON.stringify(diagnosticToJson(withoutCommitOid)))))
			.not.toContain('commit_oid')
	})

	it('never emits commit_oid on a related location', () => {
		const diagnostic: Diagnostic = {
			code: 'EF-ID-004',
			severity: 'error',
			message: 'm',
			commitOid: 'abc123',
			related: [{ path: 'x.md', message: 'also here' }],
		}
		const json = diagnosticToJson(diagnostic)
		expect(Object.keys(json.related[0]!))
			.not.toContain('commit_oid')
	})

	it('preserves array order and length across zero, one, and many diagnostics', () => {
		expect(diagnosticsToJson([]))
			.toEqual([])

		const one: Diagnostic = { code: 'EF-VAL-004', severity: 'info', message: 'x', related: [] }
		expect(diagnosticsToJson([one]))
			.toHaveLength(1)

		const two: Diagnostic = { code: 'EF-VAL-005', severity: 'info', message: 'y', related: [] }
		const converted = diagnosticsToJson([one, two])
		expect(converted.map(d => d.code))
			.toEqual(['EF-VAL-004', 'EF-VAL-005'])
	})
})
