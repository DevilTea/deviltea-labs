import type { ValidationIssue } from './types'

export type SpecErrorCode = 'revision_conflict' | 'not_found' | 'validation_failed' | 'relation_invalid' | 'referenced_unit' | 'invalid_request'

export interface SpecErrorEnvelope {
	code: SpecErrorCode
	message: string
	details: Record<string, unknown>
}

export interface RequestIssue {
	path: string
	reason: 'missing' | 'unexpected' | 'conflict' | 'unsupported' | 'invalid_format'
	message: string
}

export class SpecError extends Error implements SpecErrorEnvelope {
	readonly code: SpecErrorCode
	readonly details: Record<string, unknown>

	constructor(code: SpecErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message)
		this.name = 'SpecError'
		this.code = code
		this.details = details
	}

	toJSON(): SpecErrorEnvelope {
		return { code: this.code, message: this.message, details: this.details }
	}
}

export function isSpecError(error: unknown): error is SpecError {
	return error instanceof SpecError
}

export function invalidRequest(issues: RequestIssue[]): SpecError {
	return new SpecError('invalid_request', 'The request is invalid.', { issues })
}

export function validationFailed(issues: ValidationIssue[]): SpecError {
	return new SpecError('validation_failed', 'The Spec workspace is invalid.', { issues })
}

export function notFound(id: string, expectedKind?: string): SpecError {
	return new SpecError('not_found', `Semantic unit '${id}' was not found.`, expectedKind === undefined ? { id } : { id, expectedKind })
}

export function revisionConflict(expectedRevision: string, currentRevision: string): SpecError {
	return new SpecError('revision_conflict', 'The workspace revision does not match expectedRevision.', { expectedRevision, currentRevision })
}

export function relationInvalid(
	reason: 'source_kind' | 'target_kind' | 'cardinality' | 'duplicate_target',
	sourceId: string,
	relationType: string,
	targetIds: string[],
): SpecError {
	return new SpecError('relation_invalid', `The '${relationType}' relation is invalid.`, { reason, sourceId, relationType, targetIds })
}

export function referencedUnit(targetId: string, inboundEdges: unknown[]): SpecError {
	return new SpecError('referenced_unit', `Semantic unit '${targetId}' is referenced by inbound relations.`, { targetId, inboundEdges })
}
