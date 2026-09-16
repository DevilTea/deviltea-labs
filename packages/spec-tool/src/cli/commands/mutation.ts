import type { Diagnostic } from '../../domain/diagnostics'
import type { CommandOutcome } from '../command-outcome'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { diagnostic } from '../../domain/diagnostics'
import { resolveWorkspaceRoot } from '../../repository/discovery'

export interface MutationCommandOptions {
	project?: string
	format: 'human' | 'json'
	noColor: boolean
}

export interface MutationCommandDeps {
	cwd: string
}

export async function resolveMutationRoot(options: MutationCommandOptions, deps: MutationCommandDeps): Promise<{ root?: string, diagnostics: Diagnostic[] }> {
	const resolved = await resolveWorkspaceRoot(deps.cwd, options.project)
	return { root: resolved.root, diagnostics: resolved.diagnostics }
}

export function mutationExitCode(ok: boolean, diagnostics: readonly Diagnostic[] = []): CommandOutcome['exitCode'] {
	if (ok)
		return 0
	return diagnostics.some(item => item.code === 'SPEC-IO-ERROR' || item.code === 'SPEC-LAYOUT-INVALID' || item.code === 'SPEC-CLI-INVALID') ? 2 : 1
}

export function formatMutation<T>(format: 'human' | 'json', json: T, human: string, ok: boolean, diagnostics: readonly Diagnostic[] = []): CommandOutcome {
	return format === 'json'
		? { exitCode: mutationExitCode(ok, diagnostics), stdout: `${JSON.stringify(json)}\n`, stderr: '' }
		: { exitCode: mutationExitCode(ok, diagnostics), stdout: human, stderr: '' }
}

export async function readBodyOption(body: string | undefined, bodyFile: string | undefined, cwd: string): Promise<{ body?: string, diagnostics: Diagnostic[] }> {
	if (body !== undefined && bodyFile !== undefined)
		return { diagnostics: [diagnostic('SPEC-CLI-INVALID', 'Use either --body or --body-file, not both.', { field: 'body' })] }
	if (bodyFile === undefined)
		return { body, diagnostics: [] }
	try {
		return { body: await readFile(resolve(cwd, bodyFile), 'utf8'), diagnostics: [] }
	}
	catch (error) {
		return { diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not read body file '${bodyFile}': ${(error as Error).message}.`, { path: bodyFile })] }
	}
}

export function noColor(options: MutationCommandOptions): void {
	void options.noColor
}
