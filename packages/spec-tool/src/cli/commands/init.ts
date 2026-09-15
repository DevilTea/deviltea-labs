import type { InitValues } from '../../application/init'
import type { CommandOutcome } from '../command-outcome'
import { resolve } from 'node:path'
import { initWorkspace } from '../../application/init'
import { initResultJson } from '../envelopes'
import { renderInit } from '../human-render'

export interface InitCommandOptions {
	project?: string
	format: 'human' | 'json'
	noInput: boolean
	noColor: boolean
	values: InitValues
}

export interface InitCommandDeps {
	cwd: string
}

export async function runInitCommand(options: InitCommandOptions, deps: InitCommandDeps): Promise<CommandOutcome> {
	void options.noInput
	void options.noColor
	const root = resolve(deps.cwd, options.project ?? '.')
	const result = await initWorkspace(root, options.values)
	const project = result.plan?.artifact
	const json = initResultJson({
		ok: result.ok,
		applied: result.ok,
		root: result.ok ? root : undefined,
		project: project
			? {
					schema: project.schema,
					kind: project.kind,
					id: project.id,
					title: project.title,
					status: project.status,
				}
			: undefined,
		diagnostics: result.diagnostics,
	})
	const exitCode: CommandOutcome['exitCode'] = result.ok ? 0 : result.diagnostics.some(item => item.code === 'SPEC-IO-ERROR') ? 2 : 1
	return options.format === 'json'
		? { exitCode, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
		: { exitCode, stdout: renderInit(json), stderr: '' }
}
