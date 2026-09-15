import type { Diagnostic } from './diagnostics'
import type { RelationEntry } from './model'
import { diagnostic } from './diagnostics'
import { isUuidV7 } from './identity'

const RELATION_FIELDS = ['type', 'target'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldValue(entry: Record<string, unknown>, field: string): unknown {
	return Object.hasOwn(entry, field) ? entry[field] : undefined
}

export function decodeRelations(value: unknown, path = 'relations'): { relations: RelationEntry[], diagnostics: Diagnostic[] } {
	if (!Array.isArray(value))
		return { relations: [], diagnostics: [diagnostic('SPEC-RELATION-INVALID', 'Field relations must be an array.', { path, field: 'relations' })] }

	const relations: RelationEntry[] = []
	const diagnostics: Diagnostic[] = []
	value.forEach((raw, index) => {
		const entryPath = `${path}[${index}]`
		if (!isRecord(raw)) {
			diagnostics.push(diagnostic('SPEC-RELATION-INVALID', 'Each relation must be a mapping.', { path: entryPath }))
			return
		}
		for (const field of Object.keys(raw)) {
			if (!(RELATION_FIELDS as readonly string[]).includes(field))
				diagnostics.push(diagnostic('SPEC-RELATION-INVALID', `Unknown relation field '${field}'.`, { path: entryPath, field }))
		}
		const type = fieldValue(raw, 'type')
		const target = fieldValue(raw, 'target')
		if (typeof type !== 'string' || type.trim() === '')
			diagnostics.push(diagnostic('SPEC-RELATION-INVALID', 'Relation type must be a non-empty string.', { path: entryPath, field: 'type' }))
		if (typeof target !== 'string' || !isUuidV7(target))
			diagnostics.push(diagnostic('SPEC-RELATION-INVALID', 'Relation target must be a UUIDv7 string.', { path: entryPath, field: 'target' }))
		if (typeof type === 'string' && type.trim() !== '' && typeof target === 'string' && isUuidV7(target))
			relations.push({ type, target })
	})
	return { relations, diagnostics }
}
