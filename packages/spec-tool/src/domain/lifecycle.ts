import type { Diagnostic } from './diagnostics'
import type { ArtifactKind, Status } from './model'
import { diagnostic } from './diagnostics'
import { ALLOWED_STATUSES, isStatus } from './model'

export function validateStatus(kind: ArtifactKind, status: unknown, path?: string, id?: string): Diagnostic[] {
	if (!isStatus(status))
		return [diagnostic('SPEC-STATUS-INVALID', `Unknown status ${JSON.stringify(status)}.`, { path, artifactId: id, field: 'status' })]
	if (!ALLOWED_STATUSES[kind].includes(status))
		return [diagnostic('SPEC-STATUS-INVALID', `Status '${status}' is not allowed for kind '${kind}'.`, { path, artifactId: id, field: 'status' })]
	return []
}

export function isStatusAllowed(kind: ArtifactKind, status: Status): boolean {
	return ALLOWED_STATUSES[kind].includes(status)
}

export function requiresCompleteBody(kind: ArtifactKind, status: Status): boolean {
	return status === 'active' || (kind === 'change' && status === 'completed')
}
