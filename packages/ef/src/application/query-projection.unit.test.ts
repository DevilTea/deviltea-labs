import type { Envelope } from '../domain/model'
import { describe, expect, it } from 'vitest'
import { buildArtifactFull, buildArtifactSummary, canonicalArtifactPath } from './query-projection'

function baseEnvelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		schema: 'ef/requirement@1',
		type: 'requirement',
		id: 'REQ-031',
		title: 'Search Result Filtering',
		status: 'active',
		summary: 'Search results must support filtering by supported criteria.',
		tags: [],
		relations: [],
		resources: [],
		extensions: {},
		...overrides,
	}
}

describe('canonicalArtifactPath', () => {
	it('builds the canonical PROJECT path', () => {
		expect(canonicalArtifactPath('project', 'PROJECT'))
			.toBe('.engineering/PROJECT.md')
	})

	it('builds the canonical path for a numbered Artifact type', () => {
		expect(canonicalArtifactPath('requirement', 'REQ-031'))
			.toBe('.engineering/req/REQ-031.md')
		expect(canonicalArtifactPath('change', 'CHG-002'))
			.toBe('.engineering/chg/CHG-002.md')
	})
})

describe('buildArtifactSummary', () => {
	it('produces every fixed core key, including empty arrays as arrays', () => {
		const summary = buildArtifactSummary(baseEnvelope(), '.engineering/req/REQ-031.md')
		expect(summary)
			.toEqual({
				schema: 'ef/requirement@1',
				type: 'requirement',
				id: 'REQ-031',
				title: 'Search Result Filtering',
				status: 'active',
				summary: 'Search results must support filtering by supported criteria.',
				tags: [],
				relations: [],
				resources: [],
				path: '.engineering/req/REQ-031.md',
			})
	})

	it('flattens relation x-* extensions alongside type/target, sorted bytewise', () => {
		const envelope = baseEnvelope({
			relations: [
				{ type: 'derived-from', target: 'PRD-012', extensions: { 'x-basis': 'discovery', 'x-acme-note': 'n' } },
			],
		})
		const summary = buildArtifactSummary(envelope, 'path.md')
		expect(summary.relations)
			.toEqual([
				{ 'type': 'derived-from', 'target': 'PRD-012', 'x-acme-note': 'n', 'x-basis': 'discovery' },
			])
	})

	it('projects a Resource descriptor using wire field names (media_type, not mediaType)', () => {
		const envelope = baseEnvelope({
			resources: [
				{
					type: 'json-schema',
					location: '.engineering/resources/REQ-031/search-filter.schema.json',
					role: 'contract',
					mediaType: 'application/json',
					normative: true,
					description: 'Canonical persisted representation.',
					extensions: { 'x-acme-owner-team': 'search-platform' },
				},
			],
		})
		const summary = buildArtifactSummary(envelope, 'path.md')
		expect(summary.resources)
			.toEqual([
				{
					'type': 'json-schema',
					'location': '.engineering/resources/REQ-031/search-filter.schema.json',
					'role': 'contract',
					'media_type': 'application/json',
					'normative': true,
					'description': 'Canonical persisted representation.',
					'x-acme-owner-team': 'search-platform',
				},
			])
	})

	it('flattens top-level x-* extensions into the summary object itself', () => {
		const envelope = baseEnvelope({ extensions: { 'x-acme-owner-team': 'search-platform' } })
		const summary = buildArtifactSummary(envelope, 'path.md')
		expect(summary['x-acme-owner-team'])
			.toBe('search-platform')
	})

	it('preserves tags as a plain array copy (not the same array reference)', () => {
		const tags = ['search', 'user-experience']
		const envelope = baseEnvelope({ tags })
		const summary = buildArtifactSummary(envelope, 'path.md')
		expect(summary.tags)
			.toEqual(tags)
		expect(summary.tags)
			.not.toBe(tags)
	})
})

describe('buildArtifactFull', () => {
	it('adds exactly one required "body" field on top of the summary projection', () => {
		const full = buildArtifactFull(baseEnvelope(), 'path.md', '## Requirement\n\nThe system must ...\n')
		expect(full.body)
			.toBe('## Requirement\n\nThe system must ...\n')
		const { body, ...summaryPart } = full
		expect(summaryPart)
			.toEqual(buildArtifactSummary(baseEnvelope(), 'path.md'))
	})
})
