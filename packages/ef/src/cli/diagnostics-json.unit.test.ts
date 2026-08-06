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
