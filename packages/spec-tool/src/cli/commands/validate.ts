import type { CommandOutcome } from '../command-outcome'
import { validateCurrentWorkspace } from '../../application/validation'
import { resolveWorkspaceRoot } from '../../repository/discovery'
import { validationResultJson } from '../envelopes'
import { renderValidation } from '../human-render'

export interface ValidateCommandOptions {
	project?: string
	format: 'human' | 'json'
	noColor: boolean
}

export interface ValidateCommandDeps {
	cwd: string
}

function output(options: ValidateCommandOptions, result: ReturnType<typeof validationResultJson>, exitCode: CommandOutcome['exitCode']): CommandOutcome {
	void options.noColor
	return options.format === 'json'
		? { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: '' }
		: { exitCode, stdout: renderValidation(result), stderr: '' }
}

export async function runValidateCommand(options: ValidateCommandOptions, deps: ValidateCommandDeps): Promise<CommandOutcome> {
	const resolved = await resolveWorkspaceRoot(deps.cwd, options.project)
	if (!resolved.root) {
		return output(options, validationResultJson({ valid: false, complete: false, artifactCount: 0, projectCount: 0, diagnostics: resolved.diagnostics }), 2)
	}
	const validation = await validateCurrentWorkspace(resolved.root)
	return output(options, validationResultJson(validation), validation.complete ? validation.valid ? 0 : 1 : 2)
}
