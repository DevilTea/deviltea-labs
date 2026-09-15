import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact } from '../domain/model'

export interface InitResultJson {
	schema: 'spec/init-result@1'
	ok: boolean
	applied: boolean
	root?: string
	project?: Pick<Artifact, 'schema' | 'kind' | 'id' | 'title' | 'status'>
	diagnostics: Diagnostic[]
}

export interface ValidationResultJson {
	schema: 'spec/validation-result@1'
	valid: boolean
	complete: boolean
	artifactCount: number
	projectCount: number
	diagnostics: Diagnostic[]
}

export function initResultJson(result: Omit<InitResultJson, 'schema'>): InitResultJson {
	return { schema: 'spec/init-result@1', ...result }
}

export function validationResultJson(result: Omit<ValidationResultJson, 'schema'>): ValidationResultJson {
	return { schema: 'spec/validation-result@1', ...result }
}
