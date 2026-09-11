import type { Diagnostic } from './diagnostics'
import type {
	LocalResourceFileEntry,
	OwnerResourceSnapshot,
	ResourceContentState,
	ResourceEnvelopeInput,
	ResourceOwnershipEntry,
} from './resources'
import { describe, expect, it } from 'vitest'
import {
	findOrphanResourceFiles,
	validateFrozenResourceMutation,
	validateLocalResourceFiles,
	validateResourceDescriptors,
	validateResourceOwnership,
} from './resources'

const PATH = '.engineering/req/REQ-031.md'

function codes(diagnostics: Diagnostic[]): string[] {
	return diagnostics.map(d => d.code)
}

function baseEnvelope(resources: readonly unknown[], id = 'REQ-031'): ResourceEnvelopeInput {
	return { id, resources }
}

function validDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'json-schema',
		location: '.engineering/resources/REQ-031/search-filter.schema.json',
		role: 'contract',
		media_type: 'application/json',
		normative: true,
		description: 'Canonical persisted representation of a search-filter expression.',
		...overrides,
	}
}

describe('validateResourceDescriptors', () => {
	describe('valid spec examples', () => {
		it('accepts the normative local contract example', () => {
			const envelope = baseEnvelope([validDescriptor()])
			expect(validateResourceDescriptors(envelope, PATH))
				.toEqual([])
		})

		it('accepts the supporting diagram example', () => {
			const envelope = baseEnvelope([{
				type: 'diagram',
				location: '.engineering/resources/ADR-022/relation-index.svg',
				role: 'explanation',
				media_type: 'image/svg+xml',
				normative: false,
				description: 'Data-flow diagram for updates to the derived relation index.',
			}], 'ADR-022')
			expect(validateResourceDescriptors(envelope, PATH))
				.toEqual([])
		})

		it('accepts the external reference example', () => {
			const envelope = baseEnvelope([{
				type: 'reference',
				location: 'https://www.rfc-editor.org/rfc/rfc9110',
				role: 'reference',
				media_type: 'text/html',
				normative: false,
				description: 'HTTP semantics referenced by this requirement.',
			}])
			expect(validateResourceDescriptors(envelope, PATH))
				.toEqual([])
		})

		it('accepts the canonically ordered two-resource example with no ordering warning', () => {
			const envelope = baseEnvelope([
				{
					type: 'benchmark',
					location: '.engineering/resources/REQ-031/filter-benchmark.csv',
					role: 'evidence',
					media_type: 'text/csv',
					normative: false,
					description: 'Baseline filtering latency measurements for the reference dataset.',
				},
				validDescriptor(),
			])
			expect(validateResourceDescriptors(envelope, PATH))
				.toEqual([])
		})

		it('accepts resources: []', () => {
			expect(validateResourceDescriptors(baseEnvelope([]), PATH))
				.toEqual([])
		})

		it.each(['application/json', 'application/yaml', 'text/markdown', 'image/png', 'image/svg+xml', 'application/pdf'])(
			'accepts media type %s',
			(mediaType) => {
				// Uses an unlisted suffix so the EF-RES-018 suffix/media-type table
				// (which only maps 8 specific suffixes) never interferes here.
				const envelope = baseEnvelope([validDescriptor({
					location: '.engineering/resources/REQ-031/asset.bin',
					media_type: mediaType,
					description: 'A description.',
				})])
				expect(codes(validateResourceDescriptors(envelope, PATH)))
					.toEqual([])
			},
		)
	})

	describe('eF-RES-001 shape and required fields', () => {
		it('rejects a non-mapping entry', () => {
			const envelope = baseEnvelope(['not-a-mapping'])
			const diagnostics = validateResourceDescriptors(envelope, PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-001'])
			expect(diagnostics[0])
				.toMatchObject({ severity: 'error', path: PATH, artifactId: 'REQ-031', field: 'resources[0]' })
		})

		it('rejects an array entry', () => {
			const envelope = baseEnvelope([['type', 'openapi']])
			expect(codes(validateResourceDescriptors(envelope, PATH)))
				.toEqual(['EF-RES-001'])
		})

		it('rejects a null entry', () => {
			const envelope = baseEnvelope([null])
			expect(codes(validateResourceDescriptors(envelope, PATH)))
				.toEqual(['EF-RES-001'])
		})

		it('reports missing resources array (invalid: missing resources field, applied at envelope level) via empty array as valid input', () => {
			// This module validates the `resources` array contents only; the
			// envelope-level "resources field must be present" rule (EF-ENV-003)
			// belongs to the envelope module. An empty array here is valid.
			expect(validateResourceDescriptors(baseEnvelope([]), PATH))
				.toEqual([])
		})

		it.each(['type', 'location', 'role', 'media_type', 'normative', 'description'])(
			'reports a missing required field %s',
			(field) => {
				const descriptor = validDescriptor()
				delete descriptor[field]
				const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
				expect(codes(diagnostics))
					.toEqual(['EF-RES-001'])
				expect(diagnostics[0]!.field)
					.toBe(`resources[0].${field}`)
			},
		)

		it('reports normative as a string rather than boolean', () => {
			const descriptor = validDescriptor({ normative: 'true' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-001'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].normative')
		})

		it('reports normative as a number rather than boolean', () => {
			const descriptor = validDescriptor({ normative: 1 })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-001'])
		})

		it('reports type as a non-string value', () => {
			const descriptor = validDescriptor({ type: 42 })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-001'])
		})

		it('reports an empty description as a shape violation', () => {
			const descriptor = validDescriptor({ description: '   ' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-001'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].description')
		})

		it('reports independently detectable errors together for one malformed entry', () => {
			const descriptor = validDescriptor({ type: 'not-a-known-type', role: 'owner' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics)
				.sort())
				.toEqual(['EF-RES-002', 'EF-RES-003'])
		})
	})

	describe('eF-RES-002 resource type vocabulary', () => {
		it.each(['openapi', 'json-schema', 'diagram', 'example', 'benchmark', 'prototype', 'screenshot', 'reference', 'data', 'asset', 'other'])(
			'accepts built-in type %s',
			(type) => {
				const descriptor = validDescriptor({ type, role: 'reference', normative: false })
				expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
					.toEqual([])
			},
		)

		it('accepts a namespaced custom type', () => {
			const descriptor = validDescriptor({ type: 'x-acme-threat-model', role: 'reference', normative: false })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('rejects an unknown non-namespaced type', () => {
			const descriptor = validDescriptor({ type: 'threat-model' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-002'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].type')
		})

		it('rejects an insufficiently namespaced custom type', () => {
			const descriptor = validDescriptor({ type: 'x-owner' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-002'])
		})
	})

	describe('eF-RES-003 resource role vocabulary', () => {
		it.each(['contract', 'evidence', 'explanation', 'example', 'reference', 'prototype', 'asset'])(
			'accepts built-in role %s',
			(role) => {
				const normative = role === 'contract'
				const descriptor = validDescriptor({ role, normative })
				expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
					.toEqual([])
			},
		)

		it('rejects an unknown role', () => {
			const descriptor = validDescriptor({ role: 'owner' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-003'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].role')
		})

		it('does not accept a namespaced value as a custom role', () => {
			const descriptor = validDescriptor({ role: 'x-acme-custom' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-003'])
		})
	})

	describe('eF-RES-004 location classification and syntax', () => {
		it('rejects an empty location', () => {
			const descriptor = validDescriptor({ location: '' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-004'])
		})

		it('rejects a file:// scheme', () => {
			const descriptor = validDescriptor({ location: 'file:///etc/passwd' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects a Windows-style path with a colon', () => {
			const descriptor = validDescriptor({ location: 'C:\\evil.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an uppercase HTTP scheme (case-sensitive scheme match)', () => {
			const descriptor = validDescriptor({ location: 'HTTP://example.com/a.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects a mailto scheme', () => {
			const descriptor = validDescriptor({ location: 'mailto:someone@example.com' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an external URL containing userinfo', () => {
			const descriptor = validDescriptor({ location: 'https://user:pass@example.com/a.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an external URL containing whitespace', () => {
			const descriptor = validDescriptor({ location: 'https://example.com/a b.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an external URL with a malformed percent escape', () => {
			const descriptor = validDescriptor({ location: 'https://example.com/a%2json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an external URL with an empty host', () => {
			const descriptor = validDescriptor({ location: 'https:///a.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('rejects an external URL with non-ASCII characters', () => {
			const descriptor = validDescriptor({ location: 'https://exämple.com/a.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})

		it('accepts a well-formed https URL with a port and path', () => {
			const descriptor = validDescriptor({
				type: 'reference',
				location: 'https://example.com:8443/docs/a.json',
				role: 'reference',
				normative: false,
			})
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})
	})

	describe('eF-RES-005 media type', () => {
		it('rejects an uppercase media type', () => {
			const descriptor = validDescriptor({ media_type: 'Application/JSON' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-005'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].media_type')
		})

		it('rejects a media type without a slash', () => {
			const descriptor = validDescriptor({ media_type: 'json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-005'])
		})

		it('rejects a media type with parameters', () => {
			const descriptor = validDescriptor({ media_type: 'application/json; charset=utf-8' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-005'])
		})

		it('rejects a media type with an empty subtype', () => {
			const descriptor = validDescriptor({ media_type: 'application/' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-005'])
		})
	})

	describe('eF-RES-007 local path normalization and containment', () => {
		it('rejects the spec\'s escaping-path example', () => {
			const descriptor = validDescriptor({ location: '../shared/schema.json' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-007'])
		})

		it('rejects a location beginning with /', () => {
			const descriptor = validDescriptor({ location: '/etc/passwd' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-007'])
		})

		it('rejects a location beginning with ~', () => {
			const descriptor = validDescriptor({ location: '~/schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-007'])
		})

		it('rejects a location with a . segment', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-031/./schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-007'])
		})

		it('rejects a location with an empty segment', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-031//schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-007'])
		})

		it('rejects a location with a backslash and no colon', () => {
			const descriptor = validDescriptor({ location: '.engineering\\resources\\REQ-031\\schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-004'])
		})
	})

	describe('eF-RES-014 owner-directory rule', () => {
		it('rejects a local location under a different owner', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-044/schema.json' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor], 'REQ-031'), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-014'])
		})

		it('rejects a local location outside .engineering/resources entirely', () => {
			const descriptor = validDescriptor({ location: 'docs/schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-014'])
		})

		it('rejects a location equal to the owner directory itself (no filename)', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-031' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-014'])
		})

		it('accepts a location for a different owner id matching that owner', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/ADR-022/schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor], 'ADR-022'), PATH)))
				.toEqual([])
		})

		it('is case-sensitive on the owner id', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/req-031/schema.json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor], 'REQ-031'), PATH)))
				.toEqual(['EF-RES-014'])
		})
	})

	describe('eF-RES-008 duplicate location within one artifact', () => {
		it('flags the second occurrence of a duplicated location', () => {
			const descriptor = validDescriptor()
			const other = validDescriptor({ type: 'diagram', role: 'explanation', normative: false, description: 'Another description.' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor, other]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-008'])
			expect(diagnostics[0]!.field)
				.toBe('resources[1].location')
			expect(diagnostics[0]!.related)
				.toEqual([
					{ path: PATH, artifactId: 'REQ-031', field: 'resources[0].location', message: expect.stringContaining('First occurrence') },
				])
		})

		it('treats different extension values as not making duplicate locations distinct', () => {
			const descriptor = validDescriptor({ 'x-acme-tag': 'one' })
			const other = validDescriptor({ 'x-acme-tag': 'two', 'description': 'Another description.' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor, other]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-008'])
		})

		it('does not flag distinct locations', () => {
			const descriptor = validDescriptor()
			const other = validDescriptor({ location: '.engineering/resources/REQ-031/zzz-other.json', description: 'Another description.' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor, other]), PATH)))
				.toEqual([])
		})
	})

	describe('eF-RES-010 external and normative', () => {
		it('rejects the spec\'s invalid external normative example', () => {
			const descriptor = {
				type: 'reference',
				location: 'https://example.com/current-contract.yaml',
				role: 'contract',
				media_type: 'application/yaml',
				normative: true,
				description: 'Remote canonical contract.',
			}
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-010'])
		})

		it('accepts an external resource with normative: false', () => {
			const descriptor = validDescriptor({
				location: 'https://example.com/reference.yaml',
				role: 'reference',
				normative: false,
			})
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})
	})

	describe('eF-RES-011 role and normative compatibility', () => {
		it('rejects role: contract with normative: false', () => {
			const descriptor = validDescriptor({ role: 'contract', normative: false })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-011'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].normative')
		})

		it.each(['explanation', 'example', 'reference', 'prototype', 'asset'])(
			'rejects role: %s with normative: true',
			(role) => {
				const descriptor = validDescriptor({ role, normative: true })
				expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
					.toEqual(['EF-RES-011'])
			},
		)

		it.each([true, false])('accepts role: evidence with normative: %s', (normative) => {
			const descriptor = validDescriptor({ role: 'evidence', normative })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('does not double-report when the external+normative example also satisfies role/normative compatibility', () => {
			// role: contract + normative: true satisfies EF-RES-011 even though the
			// external location independently triggers EF-RES-010.
			const descriptor = {
				type: 'reference',
				location: 'https://example.com/current-contract.yaml',
				role: 'contract',
				media_type: 'application/yaml',
				normative: true,
				description: 'Remote canonical contract.',
			}
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-010'])
		})
	})

	describe('eF-RES-019 unknown and extension fields', () => {
		it('rejects an unknown non-extension field', () => {
			const descriptor = validDescriptor({ title: 'Should not be here' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-019'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].title')
		})

		it('rejects an insufficiently namespaced extension field', () => {
			const descriptor = validDescriptor({ 'x-owner': 'search-platform' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-019'])
		})

		it('accepts a valid namespaced extension field', () => {
			const descriptor = validDescriptor({ 'x-acme-owner-team': 'search-platform' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('accepts JSON-compatible extension values: string, number, boolean, null, array, mapping', () => {
			// Extension keys are listed in bytewise order so this case does not
			// also trip the EF-RES-016 field-order check.
			const descriptor = validDescriptor({
				'x-acme-active': true,
				'x-acme-count': 3,
				'x-acme-meta': { nested: 'value' },
				'x-acme-note': null,
				'x-acme-tags': ['a', 'b'],
			})
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('rejects a non-finite number extension value', () => {
			const descriptor = validDescriptor({ 'x-acme-count': Number.NaN })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-019'])
			expect(diagnostics[0]!.field)
				.toBe('resources[0].x-acme-count')
		})

		it('rejects an extension value that is not JSON-compatible (function)', () => {
			const descriptor = validDescriptor({ 'x-acme-handler': () => {} })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-019'])
		})
	})

	describe('eF-RES-016 canonical ordering (fields and array)', () => {
		it('warns when descriptor field order is non-canonical', () => {
			const descriptor: Record<string, unknown> = {}
			descriptor.role = 'contract'
			descriptor.type = 'json-schema'
			descriptor.location = '.engineering/resources/REQ-031/schema.json'
			descriptor.media_type = 'application/json'
			descriptor.normative = true
			descriptor.description = 'Canonical persisted representation.'
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-016'])
			expect(diagnostics[0]!.severity)
				.toBe('warning')
			expect(diagnostics[0]!.field)
				.toBe('resources[0]')
		})

		it('warns when an extension field precedes a core field', () => {
			const descriptor: Record<string, unknown> = {}
			descriptor['x-acme-owner'] = 'team'
			descriptor.type = 'json-schema'
			descriptor.location = '.engineering/resources/REQ-031/schema.json'
			descriptor.role = 'contract'
			descriptor.media_type = 'application/json'
			descriptor.normative = true
			descriptor.description = 'Canonical persisted representation.'
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual(['EF-RES-016'])
		})

		it('warns when multiple extension fields are not bytewise sorted', () => {
			const descriptor = validDescriptor()
			const reordered: Record<string, unknown> = {}
			for (const key of Object.keys(descriptor))
				reordered[key] = descriptor[key]
			reordered['x-b-second'] = 2
			reordered['x-a-first'] = 1
			expect(codes(validateResourceDescriptors(baseEnvelope([reordered]), PATH)))
				.toEqual(['EF-RES-016'])
		})

		it('does not warn when descriptor fields and extensions are already canonical', () => {
			const descriptor = validDescriptor({ 'x-a-first': 1, 'x-b-second': 2 })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('warns when the resources array is not sorted by location', () => {
			const first = validDescriptor({ location: '.engineering/resources/REQ-031/z.json' })
			const second = validDescriptor({ location: '.engineering/resources/REQ-031/a.json', description: 'Another description.' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([first, second]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-016'])
			expect(diagnostics[0]!.field)
				.toBe('resources')
		})

		it('does not warn when the resources array is sorted by location', () => {
			const first = validDescriptor({ location: '.engineering/resources/REQ-031/a.json' })
			const second = validDescriptor({ location: '.engineering/resources/REQ-031/z.json', description: 'Another description.' })
			expect(codes(validateResourceDescriptors(baseEnvelope([first, second]), PATH)))
				.toEqual([])
		})
	})

	describe('eF-RES-017 http not https', () => {
		it('warns for a well-formed http:// location', () => {
			const descriptor = validDescriptor({
				location: 'http://example.com/reference.yaml',
				role: 'reference',
				normative: false,
			})
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-017'])
			expect(diagnostics[0]!.severity)
				.toBe('warning')
		})

		it('does not warn for https://', () => {
			const descriptor = validDescriptor({
				location: 'https://example.com/reference.yaml',
				role: 'reference',
				normative: false,
			})
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})
	})

	describe('eF-RES-018 suffix/media-type mismatch', () => {
		it.each([
			['.csv', 'text/csv'],
			['.html', 'text/html'],
			['.htm', 'text/html'],
			['.json', 'application/json'],
			['.md', 'text/markdown'],
			['.pdf', 'application/pdf'],
			['.png', 'image/png'],
			['.svg', 'image/svg+xml'],
			['.yaml', 'application/yaml'],
			['.yml', 'application/yaml'],
		])('warns when suffix %s does not match declared media type', (suffix, expectedMediaType) => {
			const descriptor = validDescriptor({
				location: `.engineering/resources/REQ-031/file${suffix}`,
				media_type: expectedMediaType === 'application/pdf' ? 'application/json' : 'application/pdf',
			})
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor]), PATH)
			expect(codes(diagnostics))
				.toEqual(['EF-RES-018'])
			expect(diagnostics[0]!.severity)
				.toBe('warning')
		})

		it('does not warn when suffix and media type match', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-031/schema.json', media_type: 'application/json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('does not warn for an unlisted suffix regardless of mismatch', () => {
			const descriptor = validDescriptor({ location: '.engineering/resources/REQ-031/script.ts', media_type: 'application/json' })
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})

		it('does not warn for an external location even with a matching suffix and wrong media type', () => {
			const descriptor = validDescriptor({
				location: 'https://example.com/data.json',
				role: 'reference',
				normative: false,
				media_type: 'application/yaml',
			})
			expect(codes(validateResourceDescriptors(baseEnvelope([descriptor]), PATH)))
				.toEqual([])
		})
	})

	describe('diagnostic identity fields', () => {
		it('stamps path and artifactId on every diagnostic', () => {
			const descriptor = validDescriptor({ role: 'owner' })
			const diagnostics = validateResourceDescriptors(baseEnvelope([descriptor], 'REQ-031'), 'custom/path.md')
			expect(diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-RES-003', path: 'custom/path.md', artifactId: 'REQ-031' }),
				])
		})
	})
})

describe('validateResourceOwnership (EF-RES-009)', () => {
	it('flags a location claimed by two different artifacts', () => {
		const entries: ResourceOwnershipEntry[] = [
			{ artifactId: 'REQ-031', path: '.engineering/req/REQ-031.md', location: '.engineering/resources/REQ-031/api.yaml' },
			{ artifactId: 'REQ-044', path: '.engineering/req/REQ-044.md', location: '.engineering/resources/REQ-031/api.yaml' },
		]
		const diagnostics = validateResourceOwnership(entries)
		expect(diagnostics)
			.toHaveLength(2)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-009', 'EF-RES-009'])
		const artifactIds = diagnostics.map(d => d.artifactId)
			.sort()
		expect(artifactIds)
			.toEqual(['REQ-031', 'REQ-044'])
		for (const diagnostic of diagnostics) {
			expect(diagnostic.related)
				.toHaveLength(1)
		}
	})

	it('does not flag one owner claiming its own location once', () => {
		const entries: ResourceOwnershipEntry[] = [
			{ artifactId: 'REQ-031', path: '.engineering/req/REQ-031.md', location: '.engineering/resources/REQ-031/api.yaml' },
		]
		expect(validateResourceOwnership(entries))
			.toEqual([])
	})

	it('does not flag distinct locations owned by distinct artifacts', () => {
		const entries: ResourceOwnershipEntry[] = [
			{ artifactId: 'REQ-031', path: '.engineering/req/REQ-031.md', location: '.engineering/resources/REQ-031/api.yaml' },
			{ artifactId: 'REQ-044', path: '.engineering/req/REQ-044.md', location: '.engineering/resources/REQ-044/api.yaml' },
		]
		expect(validateResourceOwnership(entries))
			.toEqual([])
	})
})

describe('validateLocalResourceFiles (EF-RES-006)', () => {
	const entry = (location: string): LocalResourceFileEntry => ({ artifactId: 'REQ-031', path: PATH, location })

	it('accepts a location present as a regular file', () => {
		const facts = new Map([['.engineering/resources/REQ-031/api.yaml', 'file' as const]])
		expect(validateLocalResourceFiles([entry('.engineering/resources/REQ-031/api.yaml')], facts))
			.toEqual([])
	})

	it('flags a location absent from the file facts map as missing', () => {
		const diagnostics = validateLocalResourceFiles([entry('.engineering/resources/REQ-031/api.yaml')], new Map())
		expect(codes(diagnostics))
			.toEqual(['EF-RES-006'])
		expect(diagnostics[0]!.message)
			.toContain('does not exist')
	})

	it('flags a location that resolves to a directory', () => {
		const facts = new Map([['.engineering/resources/REQ-031/api.yaml', 'directory' as const]])
		const diagnostics = validateLocalResourceFiles([entry('.engineering/resources/REQ-031/api.yaml')], facts)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-006'])
		expect(diagnostics[0]!.message)
			.toContain('not a regular file')
	})

	it('flags a location that resolves to a symlink', () => {
		const facts = new Map([['.engineering/resources/REQ-031/api.yaml', 'symlink' as const]])
		expect(codes(validateLocalResourceFiles([entry('.engineering/resources/REQ-031/api.yaml')], facts)))
			.toEqual(['EF-RES-006'])
	})

	it('ignores external locations', () => {
		expect(validateLocalResourceFiles([entry('https://example.com/api.yaml')], new Map()))
			.toEqual([])
	})

	it('ignores syntactically invalid local locations', () => {
		expect(validateLocalResourceFiles([entry('../escape.yaml')], new Map()))
			.toEqual([])
	})
})

describe('findOrphanResourceFiles (EF-RES-015)', () => {
	it('flags a managed-root file with no declared owner', () => {
		const diagnostics = findOrphanResourceFiles(
			['.engineering/resources/REQ-031/orphan.txt'],
			new Set(['.engineering/resources/REQ-031/api.yaml']),
		)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-015'])
		expect(diagnostics[0]!.path)
			.toBe('.engineering/resources/REQ-031/orphan.txt')
		expect(diagnostics[0]!.artifactId)
			.toBeUndefined()
	})

	it('does not flag a declared file', () => {
		const diagnostics = findOrphanResourceFiles(
			['.engineering/resources/REQ-031/api.yaml'],
			new Set(['.engineering/resources/REQ-031/api.yaml']),
		)
		expect(diagnostics)
			.toEqual([])
	})

	it('does not flag a declared location that is missing from the managed-root scan (that is EF-RES-006, not an orphan)', () => {
		const diagnostics = findOrphanResourceFiles(
			[],
			new Set(['.engineering/resources/REQ-031/api.yaml']),
		)
		expect(diagnostics)
			.toEqual([])
	})
})

describe('validateFrozenResourceMutation (EF-RES-013)', () => {
	const resource = (overrides: Partial<ResourceContentState> = {}): ResourceContentState => ({
		location: '.engineering/resources/REQ-031/api.yaml',
		type: 'openapi',
		role: 'contract',
		mediaType: 'application/yaml',
		normative: true,
		description: 'Canonical HTTP contract.',
		extensions: {},
		contentHash: 'sha256:aaa',
		...overrides,
	})

	function snapshot(overrides: Partial<OwnerResourceSnapshot> = {}): OwnerResourceSnapshot {
		return {
			artifactId: 'REQ-031',
			path: PATH,
			frozen: true,
			resources: [resource()],
			...overrides,
		}
	}

	it('reports nothing when the owner was not yet frozen', () => {
		const before = snapshot({ frozen: false })
		const after = snapshot({ resources: [] })
		expect(validateFrozenResourceMutation(before, after))
			.toEqual([])
	})

	it('reports nothing when a frozen owner\'s resources are unchanged', () => {
		const before = snapshot()
		const after = snapshot()
		expect(validateFrozenResourceMutation(before, after))
			.toEqual([])
	})

	it('flags removal of a frozen owner\'s resource', () => {
		const before = snapshot()
		const after = snapshot({ resources: [] })
		const diagnostics = validateFrozenResourceMutation(before, after)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-013'])
		expect(diagnostics[0]!.message)
			.toContain('removed')
	})

	it('flags addition of a resource to a frozen owner', () => {
		const before = snapshot({ resources: [] })
		const after = snapshot()
		const diagnostics = validateFrozenResourceMutation(before, after)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-013'])
		expect(diagnostics[0]!.message)
			.toContain('added')
	})

	it('flags a metadata change (description) on a frozen owner\'s resource', () => {
		const before = snapshot()
		const after = snapshot({ resources: [resource({ description: 'Changed description.' })] })
		const diagnostics = validateFrozenResourceMutation(before, after)
		expect(codes(diagnostics))
			.toEqual(['EF-RES-013'])
		expect(diagnostics[0]!.message)
			.toContain('modified')
	})

	it('flags a content-hash change on a frozen owner\'s local resource', () => {
		const before = snapshot()
		const after = snapshot({ resources: [resource({ contentHash: 'sha256:bbb' })] })
		expect(codes(validateFrozenResourceMutation(before, after)))
			.toEqual(['EF-RES-013'])
	})

	it('flags an extensions change on a frozen owner\'s resource', () => {
		const before = snapshot({ resources: [resource({ extensions: { 'x-acme-tag': 'a' } })] })
		const after = snapshot({ resources: [resource({ extensions: { 'x-acme-tag': 'b' } })] })
		expect(codes(validateFrozenResourceMutation(before, after)))
			.toEqual(['EF-RES-013'])
	})

	it('does not flag an unchanged external resource without a content hash', () => {
		const externalResource = resource({ contentHash: undefined, normative: false, role: 'reference' })
		const before = snapshot({ resources: [externalResource] })
		const after = snapshot({ resources: [externalResource] })
		expect(validateFrozenResourceMutation(before, after))
			.toEqual([])
	})
})
