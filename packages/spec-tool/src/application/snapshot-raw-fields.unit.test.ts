import type { YAMLMap } from 'yaml'
import { describe, expect, it } from 'vitest'
import { isMap, parseDocument } from 'yaml'
import { rawArrayField } from './snapshot-raw-fields'

function mappingOf(yamlText: string): YAMLMap<unknown, unknown> {
	const contents = parseDocument(yamlText).contents
	if (!isMap(contents))
		throw new TypeError('expected a top-level mapping')
	return contents
}

describe('rawArrayField', () => {
	it('returns [] when the field is absent', () => {
		const mapping = mappingOf('id: REQ-001\n')
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([])
	})

	it('returns [] when the field is not a sequence', () => {
		const mapping = mappingOf('relations: not-an-array\n')
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([])
	})

	it('returns [] for an empty sequence', () => {
		const mapping = mappingOf('relations: []\n')
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([])
	})

	it('converts mapping entries to plain objects with original field spelling', () => {
		const mapping = mappingOf(`relations:
  - type: derived-from
    target: PRD-001
    x-ef-example-note: hello
`)
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([
				{ 'type': 'derived-from', 'target': 'PRD-001', 'x-ef-example-note': 'hello' },
			])
	})

	it('preserves a non-mapping entry (e.g. a scalar) verbatim, for EF-REL-002/EF-RES-001 to classify', () => {
		const mapping = mappingOf(`relations:
  - just-a-string
  - 42
`)
		expect(rawArrayField(mapping, 'relations'))
			.toEqual(['just-a-string', 42])
	})

	it('preserves resources entries with original snake_case field names', () => {
		const mapping = mappingOf(`resources:
  - type: json-schema
    location: .engineering/resources/REQ-001/schema.json
    role: contract
    media_type: application/json
    normative: true
    description: A schema.
`)
		expect(rawArrayField(mapping, 'resources'))
			.toEqual([
				{
					type: 'json-schema',
					location: '.engineering/resources/REQ-001/schema.json',
					role: 'contract',
					media_type: 'application/json',
					normative: true,
					description: 'A schema.',
				},
			])
	})

	it('converts nested arrays and mappings recursively inside an extension field', () => {
		const mapping = mappingOf(`relations:
  - type: references
    target: REQ-002
    x-ef-example-list:
      - 1
      - two
      - nested:
          value: true
`)
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([
				{
					'type': 'references',
					'target': 'REQ-002',
					'x-ef-example-list': [1, 'two', { nested: { value: true } }],
				},
			])
	})

	it('drops a non-string mapping key rather than throwing', () => {
		const mapping = mappingOf(`relations:
  - type: references
    target: REQ-002
    ? [a, b]
    : weird
`)
		expect(rawArrayField(mapping, 'relations'))
			.toEqual([{ type: 'references', target: 'REQ-002' }])
	})
})
