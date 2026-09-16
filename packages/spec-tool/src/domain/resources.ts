import type { Diagnostic } from './diagnostics'
import type { ResourceDescriptor } from './model'
import { diagnostic } from './diagnostics'

const RESOURCE_FIELDS = ['location', 'role', 'mediaType', 'description'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeResources(value: unknown, path = 'resources'): { resources: ResourceDescriptor[], diagnostics: Diagnostic[] } {
	if (!Array.isArray(value))
		return { resources: [], diagnostics: [diagnostic('SPEC-RESOURCE-INVALID', 'Field resources must be an array.', { path, field: 'resources' })] }

	const resources: ResourceDescriptor[] = []
	const diagnostics: Diagnostic[] = []
	value.forEach((raw, index) => {
		const entryPath = `${path}[${index}]`
		if (!isRecord(raw)) {
			diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Each resource must be a mapping.', { path: entryPath }))
			return
		}
		for (const field of Object.keys(raw)) {
			if (!(RESOURCE_FIELDS as readonly string[]).includes(field))
				diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', `Unknown resource field '${field}'.`, { path: entryPath, field }))
		}
		const location = raw.location
		const role = raw.role
		const mediaType = raw.mediaType
		const description = raw.description
		const values = { location, role, mediaType, description }
		for (const field of RESOURCE_FIELDS) {
			const value = values[field]
			if (typeof value !== 'string')
				diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', `Resource field '${field}' must be a string.`, { path: entryPath, field }))
		}
		if (typeof location === 'string' && location.trim() === '')
			diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource location must not be empty.', { path: entryPath, field: 'location' }))
		if (typeof role === 'string' && role.trim() === '')
			diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource role must not be empty.', { path: entryPath, field: 'role' }))
		if (typeof mediaType === 'string' && mediaType.trim() === '')
			diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource mediaType must not be empty.', { path: entryPath, field: 'mediaType' }))
		if (typeof location === 'string' && typeof role === 'string' && typeof mediaType === 'string' && typeof description === 'string' && location.trim() !== '' && role.trim() !== '' && mediaType.trim() !== '')
			resources.push({ location, role, mediaType, description })
	})
	return { resources, diagnostics }
}
