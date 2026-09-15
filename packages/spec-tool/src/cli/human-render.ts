import type { InitResultJson, ValidationResultJson } from './envelopes'

export function renderInit(result: InitResultJson): string {
	if (!result.ok) {
		return `${result.diagnostics.map(item => `${item.code}: ${item.message}`)
			.join('\n')}\n`
	}
	return `Initialized .spec/ workspace at ${result.root}.\nProject ${result.project?.id}: ${result.project?.title}\n`
}

export function renderValidation(result: ValidationResultJson): string {
	const lines = [`Spec validation: ${result.valid ? 'valid' : 'invalid'}`, `Artifacts: ${result.artifactCount}`, `Projects: ${result.projectCount}`]
	for (const item of result.diagnostics)
		lines.push(`${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`)
	return `${lines.join('\n')}\n`
}
