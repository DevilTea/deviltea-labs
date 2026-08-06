import { describe, expect, it } from 'vitest'
import { parseFrontmatterDocument } from '../parsing/frontmatter'
import { decodeEnvelope } from './envelope'

const PATH = 'REQ-031.md'

/**
 * Decodes without wiring `locate`, so every diagnostic's `location` is
 * `undefined` and full-object `toEqual` assertions do not need to hand-compute
 * source positions. Location wiring itself is covered separately below.
 */
function decode(yamlText: string) {
	const { mapping } = parseFrontmatterDocument(yamlText, PATH)
	return decodeEnvelope({ mapping }, PATH)
}

function decodeWithLocate(yamlText: string) {
	const { mapping, locate } = parseFrontmatterDocument(yamlText, PATH)
	return decodeEnvelope({ mapping, locate }, PATH)
}

const MINIMAL_REQ = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
`

const DISCOVERY_EXAMPLE = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: active
summary: Search results must support content-type and modification-date filters without changing the underlying relevance order.
tags:
  - search
  - user-experience
relations:
  - type: derived-from
    target: PRD-012
resources:
  - type: json-schema
    location: .engineering/resources/REQ-031/search-filter.schema.json
    role: contract
    media_type: application/json
    normative: true
    description: Canonical persisted representation of a search-filter expression.
x-acme-owner-team: search-platform
`

describe('decodeEnvelope', () => {
	describe('minimal valid envelope', () => {
		it('decodes every core field with no diagnostics', () => {
			const { envelope, diagnostics } = decode(MINIMAL_REQ)

			expect(diagnostics)
				.toEqual([])
			expect(envelope)
				.toEqual({
					schema: 'ef/requirement@1',
					type: 'requirement',
					id: 'REQ-031',
					title: 'Search Result Filtering',
					status: 'draft',
					summary: 'Search results must support filtering by supported criteria.',
					tags: [],
					relations: [],
					resources: [],
					extensions: {},
				})
		})
	})

	describe('envelope with discovery metadata and an extension (spec example)', () => {
		it('decodes tags, relations, resources, and the extension with no diagnostics', () => {
			const { envelope, diagnostics } = decode(DISCOVERY_EXAMPLE)

			expect(diagnostics)
				.toEqual([])
			expect(envelope)
				.toEqual({
					schema: 'ef/requirement@1',
					type: 'requirement',
					id: 'REQ-031',
					title: 'Search Result Filtering',
					status: 'active',
					summary: 'Search results must support content-type and modification-date filters without changing the underlying relevance order.',
					tags: ['search', 'user-experience'],
					relations: [
						{ type: 'derived-from', target: 'PRD-012', extensions: {} },
					],
					resources: [
						{
							type: 'json-schema',
							location: '.engineering/resources/REQ-031/search-filter.schema.json',
							role: 'contract',
							mediaType: 'application/json',
							normative: true,
							description: 'Canonical persisted representation of a search-filter expression.',
							extensions: {},
						},
					],
					extensions: { 'x-acme-owner-team': 'search-platform' },
				})
		})
	})

	describe('upstream structural failure', () => {
		it('returns a null envelope and no diagnostics when the mapping is undefined', () => {
			const result = decodeEnvelope({ mapping: undefined }, PATH)

			expect(result)
				.toEqual({ envelope: null, diagnostics: [] })
		})
	})

	describe('required presence (EF-ENV-003)', () => {
		it('reports a missing core field and nulls the envelope (spec example: missing resources)', () => {
			const source = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
`
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics)
				.toHaveLength(1)
			expect(diagnostics[0])
				.toMatchObject({
					code: 'EF-ENV-003',
					severity: 'error',
					field: 'resources',
					path: PATH,
				})
		})

		it('reports every missing core field in one run', () => {
			const { envelope, diagnostics } = decode('schema: ef/requirement@1\n')

			expect(envelope)
				.toBeNull()
			const fields = diagnostics.filter(d => d.code === 'EF-ENV-003')
				.map(d => d.field)
			expect(fields)
				.toEqual(['type', 'id', 'title', 'status', 'summary', 'tags', 'relations', 'resources'])
		})

		it('reports EF-ENV-003 for a completely empty mapping (all nine fields)', () => {
			const { envelope, diagnostics } = decode('{}\n')

			expect(envelope)
				.toBeNull()
			expect(diagnostics.filter(d => d.code === 'EF-ENV-003'))
				.toHaveLength(9)
		})
	})

	describe('unknown non-extension fields (EF-ENV-006)', () => {
		it('reports an unknown top-level field that is neither core nor a valid extension (spec example: titel)', () => {
			const source = `${MINIMAL_REQ}titel: Search Result Filtering\n`
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-006',
					severity: 'error',
					message: 'Unknown top-level field \'titel\'; extension fields must begin with a valid namespace.',
					path: PATH,
					field: 'titel',
					location: undefined,
					related: [],
				}])
		})

		it('treats a wrong-case core field name as unknown, not as satisfying presence', () => {
			const source = `Schema: ef/requirement@1\n${MINIMAL_REQ}`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-006' && d.field === 'Schema'))
				.toBe(true)
		})
	})

	describe('invalid field type or forbidden empty scalar (EF-ENV-004)', () => {
		it('reports incorrect collection types for tags and relations (spec example) and nulls the envelope', () => {
			const source = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: search
relations:
  type: derived-from
  target: PRD-012
resources: []
`
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics)
				.toEqual([
					{
						code: 'EF-ENV-004',
						severity: 'error',
						message: 'Field \'tags\' must be an array of strings.',
						path: PATH,
						field: 'tags',
						location: undefined,
						related: [],
					},
					{
						code: 'EF-ENV-004',
						severity: 'error',
						message: 'Field \'relations\' must be an array of mappings.',
						path: PATH,
						field: 'relations',
						location: undefined,
						related: [],
					},
				])
		})

		it('rejects a non-string schema value', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: 42')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-004',
					severity: 'error',
					message: 'Field \'schema\' must be a non-empty single-line string.',
					path: PATH,
					field: 'schema',
					location: undefined,
					related: [],
				}])
		})

		it('rejects an empty string id', () => {
			const source = MINIMAL_REQ.replace('id: REQ-031', 'id: \'\'')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'id'))
				.toBe(true)
		})

		it('rejects an id containing an embedded newline (block literal scalar)', () => {
			const source = MINIMAL_REQ.replace('id: REQ-031', 'id: |\n  REQ-031\n  extra-line')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'id'))
				.toBe(true)
		})

		it('rejects a whitespace-only title after trimming', () => {
			const source = MINIMAL_REQ.replace('title: Search Result Filtering', 'title: \'   \'')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'title'))
				.toBe(true)
		})

		it('accepts a title with leading/trailing whitespace that is non-empty after trimming', () => {
			const source = MINIMAL_REQ.replace('title: Search Result Filtering', 'title: \'  Search Result Filtering  \'')
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.title)
				.toBe('  Search Result Filtering  ')
		})

		it('rejects a title containing an embedded newline even though it is non-empty after trimming', () => {
			const source = MINIMAL_REQ.replace('title: Search Result Filtering', 'title: "line one\\nline two"')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'title'))
				.toBe(true)
		})

		it('rejects a status containing an embedded newline', () => {
			const source = MINIMAL_REQ.replace('status: draft', 'status: "line one\\nline two"')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'status'))
				.toBe(true)
		})

		it('does not validate status against the allowed lifecycle vocabulary (deferred to EF-LIFE-*)', () => {
			const source = MINIMAL_REQ.replace('status: draft', 'status: not-a-real-status')
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.status)
				.toBe('not-a-real-status')
		})

		it('accepts a multi-line summary (folded scalar) with no single-line restriction', () => {
			const source = MINIMAL_REQ.replace(
				'summary: Search results must support filtering by supported criteria.',
				'summary: >\n  Search results must support filtering.\n\n  It spans two paragraphs.\n',
			)
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.summary)
				.toContain('two paragraphs')
		})

		it('rejects a whitespace-only summary after trimming', () => {
			const source = MINIMAL_REQ.replace(
				'summary: Search results must support filtering by supported criteria.',
				'summary: \'   \'',
			)
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics.some(d => d.code === 'EF-ENV-004' && d.field === 'summary'))
				.toBe(true)
		})

		it('rejects an unknown type value and nulls the envelope', () => {
			const source = MINIMAL_REQ.replace('type: requirement', 'type: requirements')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.toBeNull()
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-004',
					severity: 'error',
					message: 'Field \'type\' must be one of: project, prd, requirement, decision, policy, change.',
					path: PATH,
					field: 'type',
					location: undefined,
					related: [],
				}])
		})

		it('reports a resources array entry that is not a mapping and drops it from the decoded array', () => {
			const source = MINIMAL_REQ.replace('resources: []', 'resources:\n  - not-a-mapping\n')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(envelope?.resources)
				.toEqual([])
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-004',
					severity: 'error',
					message: 'Field \'resources[0]\' must be a mapping.',
					path: PATH,
					field: 'resources[0]',
					location: undefined,
					related: [],
				}])
		})

		it('reports a relations array entry that is a scalar (null placeholder) and drops it', () => {
			const source = MINIMAL_REQ.replace('relations: []', 'relations:\n  -\n')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(envelope?.relations)
				.toEqual([])
			expect(diagnostics[0])
				.toMatchObject({ code: 'EF-ENV-004', field: 'relations[0]' })
		})
	})

	describe('schema identifier support (EF-ENV-008)', () => {
		it('reports an unsupported schema identifier (wrong artifact name)', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: ef/bogus@1')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(envelope?.schema)
				.toBe('ef/bogus@1')
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-008',
					severity: 'error',
					message: 'Unsupported schema identifier \'ef/bogus@1\'.',
					path: PATH,
					field: 'schema',
					location: undefined,
					related: [],
				}])
		})

		it('reports an unsupported major version', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: ef/requirement@2')
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-008',
					severity: 'error',
					message: 'Unsupported schema identifier \'ef/requirement@2\'.',
					path: PATH,
					field: 'schema',
					location: undefined,
					related: [],
				}])
		})

		it('does not double-report EF-ENV-008 when schema already failed EF-ENV-004', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: \'\'')
			const { diagnostics } = decode(source)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-008'))
				.toHaveLength(0)
		})
	})

	describe('schema and type correspondence (EF-ENV-009)', () => {
		it('reports a schema/type mismatch (spec example) without nulling the envelope', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: ef/decision@1')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-009',
					severity: 'error',
					message: 'Schema \'ef/decision@1\' does not correspond to type \'requirement\'; expected \'ef/requirement@1\'.',
					path: PATH,
					field: 'schema',
					location: undefined,
					related: [],
				}])
		})

		it('does not report a mismatch when schema and type correspond', () => {
			const { diagnostics } = decode(MINIMAL_REQ)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-009'))
				.toHaveLength(0)
		})

		it('suppresses EF-ENV-009 when schema is unsupported (EF-ENV-008 already fired)', () => {
			const source = MINIMAL_REQ.replace('schema: ef/requirement@1', 'schema: ef/bogus@1')
			const { diagnostics } = decode(source)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-009'))
				.toHaveLength(0)
			expect(diagnostics.filter(d => d.code === 'EF-ENV-008'))
				.toHaveLength(1)
		})
	})

	describe('extension field name and value shape (EF-ENV-007)', () => {
		it('reports an unnamespaced extension (spec example: x-owner)', () => {
			const source = `${MINIMAL_REQ}x-owner: search-platform\n`
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(envelope?.extensions)
				.toEqual({})
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-007',
					severity: 'error',
					message: 'Extension field \'x-owner\' does not contain both a namespace and a field name.',
					path: PATH,
					field: 'x-owner',
					location: undefined,
					related: [],
				}])
		})

		it('accepts the documented valid alternative (x-acme-owner)', () => {
			const source = `${MINIMAL_REQ}x-acme-owner: search-platform\n`
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.extensions)
				.toEqual({ 'x-acme-owner': 'search-platform' })
		})

		it('rejects an extension name with an uppercase letter', () => {
			const source = `${MINIMAL_REQ}x-Acme-owner: search-platform\n`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-007' && d.field === 'x-Acme-owner'))
				.toBe(true)
		})

		it('rejects an extension name starting with a digit after x-', () => {
			const source = `${MINIMAL_REQ}x-1acme-owner: search-platform\n`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-007' && d.field === 'x-1acme-owner'))
				.toBe(true)
		})

		it('reports a non-finite extension number (NaN)', () => {
			const source = `${MINIMAL_REQ}x-acme-score: .nan\n`
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-007',
					severity: 'error',
					message: 'Extension field \'x-acme-score\' has a non-finite numeric value; numbers must be finite.',
					path: PATH,
					field: 'x-acme-score',
					location: undefined,
					related: [],
				}])
		})

		it('reports a non-finite extension number that overflows to infinity', () => {
			const source = `${MINIMAL_REQ}x-acme-score: 1e400\n`
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-007',
					severity: 'error',
					message: 'Extension field \'x-acme-score\' has a non-finite numeric value; numbers must be finite.',
					path: PATH,
					field: 'x-acme-score',
					location: undefined,
					related: [],
				}])
		})

		it('reports negative infinity as non-finite', () => {
			const source = `${MINIMAL_REQ}x-acme-score: -.inf\n`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-007' && d.field === 'x-acme-score'))
				.toBe(true)
		})

		it('accepts an ordinary finite number, including negative zero', () => {
			const source = `${MINIMAL_REQ}x-acme-score: 3.5\nx-acme-zero: -0\n`
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.extensions['x-acme-score'])
				.toBe(3.5)
			expect(Object.is(envelope?.extensions['x-acme-zero'], -0))
				.toBe(true)
		})

		it('accepts string, boolean, null, array, and mapping extension values', () => {
			const source = `${MINIMAL_REQ}x-acme-data:\n  str: hello\n  bool: true\n  nil: null\n  list:\n    - 1\n    - 2\n  nested:\n    inner: value\n`
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.extensions['x-acme-data'])
				.toEqual({ str: 'hello', bool: true, nil: null, list: [1, 2], nested: { inner: 'value' } })
		})

		it('reports a non-finite number nested inside an extension mapping, with a structured field path', () => {
			const source = `${MINIMAL_REQ}x-acme-data:\n  score: .nan\n`
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-007',
					severity: 'error',
					message: 'Extension field \'x-acme-data.score\' has a non-finite numeric value; numbers must be finite.',
					path: PATH,
					field: 'x-acme-data.score',
					location: undefined,
					related: [],
				}])
		})

		it('reports a non-string mapping key inside an extension value', () => {
			const source = `${MINIMAL_REQ}x-acme-data:\n  1: foo\n`
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-007',
					severity: 'error',
					message: 'Extension field \'x-acme-data\' has a mapping key that is not a string.',
					path: PATH,
					field: 'x-acme-data',
					location: undefined,
					related: [],
				}])
		})

		it('preserves an unknown valid extension field verbatim', () => {
			const source = `${MINIMAL_REQ}x-acme-owner-team: search-platform\n`
			const { envelope } = decode(source)

			expect(envelope?.extensions)
				.toEqual({ 'x-acme-owner-team': 'search-platform' })
		})
	})

	describe('tags (EF-ENV-012, EF-ENV-013)', () => {
		it('rejects a tag entry that is not a string', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - 42\n')
			const { envelope, diagnostics } = decode(source)

			expect(envelope)
				.not.toBeNull()
			expect(envelope?.tags)
				.toEqual([])
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-012',
					severity: 'error',
					message: 'Tag entry \'tags[0]\' must be a string.',
					path: PATH,
					field: 'tags[0]',
					location: undefined,
					related: [],
				}])
		})

		it('rejects a tag that does not match the tag syntax (uppercase letters)', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - UserExperience\n')
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-012',
					severity: 'error',
					message: 'Invalid tag \'UserExperience\'; tags must match ^[a-z0-9]+(?:[._-][a-z0-9]+)*$.',
					path: PATH,
					field: 'tags[0]',
					location: undefined,
					related: [],
				}])
		})

		it('rejects a tag with a leading separator', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - -leading\n')
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-012'))
				.toBe(true)
		})

		it('rejects a tag with a trailing separator', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - trailing-\n')
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-012'))
				.toBe(true)
		})

		it('accepts tags using every allowed separator', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - a.b\n  - c_d\n  - e-f\n')
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
		})

		it('reports a duplicate tag with a related first-occurrence location', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - search\n  - search\n')
			const { envelope, diagnostics } = decode(source)

			expect(envelope?.tags)
				.toEqual(['search', 'search'])
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-012',
					severity: 'error',
					message: 'Duplicate tag \'search\'.',
					path: PATH,
					field: 'tags[1]',
					location: undefined,
					related: [{
						path: PATH,
						field: 'tags[0]',
						location: undefined,
						message: 'First occurrence of tag \'search\'.',
					}],
				}])
		})

		it('treats tags case-sensitively (no duplicate between differing case)', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - search\n  - search2\n')
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
		})

		it('reports non-canonical tag ordering as a warning (EF-ENV-013)', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - user-experience\n  - search\n')
			const { envelope, diagnostics } = decode(source)

			expect(envelope?.tags)
				.toEqual(['user-experience', 'search'])
			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-013',
					severity: 'warning',
					message: 'Tags are not in bytewise lexicographic order.',
					path: PATH,
					field: 'tags',
					location: undefined,
					related: [],
				}])
		})

		it('does not report EF-ENV-013 for tags already in bytewise order', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - search\n  - user-experience\n')
			const { diagnostics } = decode(source)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-013'))
				.toHaveLength(0)
		})

		it('does not report EF-ENV-013 for an empty tags array', () => {
			const { diagnostics } = decode(MINIMAL_REQ)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-013'))
				.toHaveLength(0)
		})

		it('skips the ordering check when a tag entry is not a string', () => {
			const source = MINIMAL_REQ.replace('tags: []', 'tags:\n  - 42\n  - search\n')
			const { diagnostics } = decode(source)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-013'))
				.toHaveLength(0)
		})
	})

	describe('canonical field and extension ordering (EF-ENV-011)', () => {
		it('reports non-canonical core field order', () => {
			const source = `type: requirement
schema: ef/requirement@1
id: REQ-031
title: Search Result Filtering
status: draft
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
`
			const { diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([{
					code: 'EF-ENV-011',
					severity: 'warning',
					message: 'Envelope fields are not in canonical order: schema, type, id, title, status, summary, tags, relations, resources, then extensions sorted by name.',
					path: PATH,
					field: undefined,
					location: undefined,
					related: [],
				}])
		})

		it('does not report EF-ENV-011 for the canonical minimal envelope', () => {
			const { diagnostics } = decode(MINIMAL_REQ)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-011'))
				.toHaveLength(0)
		})

		it('reports non-canonical order when an extension precedes a core field', () => {
			const source = `x-acme-owner: search-platform\n${MINIMAL_REQ}`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-011'))
				.toBe(true)
		})

		it('reports non-canonical order when two extensions are not bytewise-sorted', () => {
			const source = `${MINIMAL_REQ}x-acme-zzz: 1\nx-acme-aaa: 2\n`
			const { diagnostics } = decode(source)

			expect(diagnostics.some(d => d.code === 'EF-ENV-011'))
				.toBe(true)
		})

		it('does not report EF-ENV-011 when extensions already follow bytewise order', () => {
			const source = `${MINIMAL_REQ}x-acme-aaa: 1\nx-acme-zzz: 2\n`
			const { diagnostics } = decode(source)

			expect(diagnostics.filter(d => d.code === 'EF-ENV-011'))
				.toHaveLength(0)
		})
	})

	describe('relation and resource entry decoding (raw shapes, no semantic validation)', () => {
		it('decodes an unknown relation type/target without flagging it (deferred to EF-REL-*)', () => {
			const source = MINIMAL_REQ.replace('relations: []', 'relations:\n  - type: not-a-real-type\n    target: 123\n')
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.relations)
				.toEqual([{ type: 'not-a-real-type', target: '', extensions: {} }])
		})

		it('defaults relation type/target to empty strings when absent', () => {
			const source = MINIMAL_REQ.replace('relations: []', 'relations:\n  - foo: bar\n')
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.relations)
				.toEqual([{ type: '', target: '', extensions: { foo: 'bar' } }])
		})

		it('collects unknown relation sub-fields into extensions', () => {
			const source = MINIMAL_REQ.replace(
				'relations: []',
				'relations:\n  - type: derived-from\n    target: PRD-012\n    x-acme-note: internal\n',
			)
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.relations)
				.toEqual([{ type: 'derived-from', target: 'PRD-012', extensions: { 'x-acme-note': 'internal' } }])
		})

		it('defaults resource sub-fields when absent, without flagging shape (deferred to EF-RES-*)', () => {
			const source = MINIMAL_REQ.replace('resources: []', 'resources:\n  - type: json-schema\n')
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.resources)
				.toEqual([{
					type: 'json-schema',
					location: '',
					role: '',
					mediaType: '',
					normative: false,
					description: '',
					extensions: {},
				}])
		})

		it('collects unknown resource sub-fields into extensions', () => {
			const source = MINIMAL_REQ.replace(
				'resources: []',
				'resources:\n  - type: json-schema\n    location: a.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: d\n    x-acme-note: internal\n',
			)
			const { envelope, diagnostics } = decode(source)

			expect(diagnostics)
				.toEqual([])
			expect(envelope?.resources)
				.toEqual([{
					type: 'json-schema',
					location: 'a.json',
					role: 'contract',
					mediaType: 'application/json',
					normative: true,
					description: 'd',
					extensions: { 'x-acme-note': 'internal' },
				}])
		})
	})

	describe('duplicate mapping keys (owned upstream by EF-ENV-005, not this module)', () => {
		it('uses the first value for a duplicated core field without emitting its own diagnostic', () => {
			// First-occurrence-wins so this module's own field selection agrees
			// with `snapshot-raw-fields.ts#rawArrayField`'s duplicate-key
			// selection (also first-match), rather than the two silently
			// disagreeing about which declared value/array is authoritative
			// (fifth-round Finding 5).
			const source = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: draft
status: active
summary: Search results must support filtering by supported criteria.
tags: []
relations: []
resources: []
`
			const { envelope, diagnostics } = decode(source)

			expect(envelope?.status)
				.toBe('draft')
			expect(diagnostics)
				.toEqual([])
		})

		it('agrees with rawArrayField\'s first-match selection for a duplicated relations array', () => {
			// Regression for Finding 5: before the fix, `collectFields` kept the
			// LAST 'relations' key while `rawArrayField` (snapshot-raw-fields.ts)
			// reads the FIRST matching pair -- so the decoded envelope
			// (projected verbatim by lookup/list/search) and the raw array fed to
			// `validateRelationEntries`/graph-index construction disagreed about
			// which declared array was authoritative.
			const source = `schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: active
summary: Search results must support filtering by supported criteria.
tags: []
relations:
  - type: references
    target: FIRST-TARGET
relations:
  - type: references
    target: SECOND-TARGET
resources: []
`
			const { envelope } = decode(source)

			expect(envelope?.relations)
				.toEqual([{ type: 'references', target: 'FIRST-TARGET', extensions: {} }])
		})
	})

	describe('locate wiring', () => {
		it('attaches a location to a diagnostic when locate is provided', () => {
			const { diagnostics } = decodeWithLocate(`${MINIMAL_REQ}titel: X\n`)

			expect(diagnostics[0]!.location)
				.toEqual({ line: 10, column: 1 })
		})

		it('omits location entirely when locate is not provided', () => {
			const { mapping } = parseFrontmatterDocument(`${MINIMAL_REQ}titel: X\n`, PATH)
			const { diagnostics } = decodeEnvelope({ mapping }, PATH)

			expect(diagnostics[0]!.location)
				.toBeUndefined()
		})
	})
})
