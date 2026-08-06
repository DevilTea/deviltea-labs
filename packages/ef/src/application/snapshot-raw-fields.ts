/**
 * Raw YAML-node-to-plain-value extraction for `relations`/`resources` array
 * fields (01-artifact-envelope.md; consumed by `domain/relations.ts` and
 * `domain/resources.ts`).
 *
 * `domain/envelope.ts` decodes `relations`/`resources` entries into narrowed
 * shapes (`{ type, target, extensions }` / camelCase `ResourceDescriptor`)
 * that drop or restructure unknown fields, so they cannot be fed back into
 * `validateRelationEntries`/`validateResourceDescriptors`, which need the
 * raw* per-entry mapping (original field spelling, every key present,
 * including malformed ones) to detect their own shape and vocabulary
 * findings (EF-REL-002/015, EF-RES-001/019, ...). This module re-derives that
 * raw shape directly from the parsed YAML mapping instead, independently of
 * `envelope.ts`'s own decoding.
 */

import type { YAMLMap } from 'yaml'
import { isMap, isScalar, isSeq } from 'yaml'

/** Convert one parsed YAML node to a plain JS value, recursively. */
function yamlNodeToPlainValue(node: unknown): unknown {
	if (isScalar(node))
		return node.value

	if (isSeq(node))
		return node.items.map(yamlNodeToPlainValue)

	if (isMap(node)) {
		const result: Record<string, unknown> = {}
		for (const pair of node.items) {
			if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
				continue
			result[pair.key.value] = yamlNodeToPlainValue(pair.value)
		}
		return result
	}

	return null
}

/**
 * Extract the raw array items of a top-level array field (`relations` or
 * `resources`) from the artifact envelope's parsed YAML mapping, as plain
 * values with original YAML field spelling preserved. Returns `[]` when the
 * field is absent or is not a YAML sequence (that whole-field shape problem
 * is `EF-ENV-004`'s concern elsewhere and already suppresses envelope
 * construction, so callers only reach here once the envelope decoded
 * successfully and the field is confirmed to be an array).
 */
export function rawArrayField(mapping: YAMLMap<unknown, unknown>, field: string): unknown[] {
	const pair = mapping.items.find(item => isScalar(item.key) && item.key.value === field)
	const valueNode = pair?.value
	if (!isSeq(valueNode))
		return []
	return valueNode.items.map(yamlNodeToPlainValue)
}
