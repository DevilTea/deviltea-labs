import type { MutationResult } from '../../application/mutations'
import type { Artifact } from '../../domain/model'
import type { CommandOutcome } from '../command-outcome'
import type { MutationCommandDeps, MutationCommandOptions } from './mutation'
import { activateArtifact, completeArtifact, retireArtifact, supersedeArtifacts } from '../../application/mutations'
import { lifecycleResultJson } from '../envelopes'
import { renderLifecycleResult } from '../human-render'
import { formatMutation, noColor, resolveMutationRoot } from './mutation'

type LifecycleOperationResult = MutationResult<Artifact | { replacement: Artifact, replaced: Artifact }>

function failed<T>(diagnostics: LifecycleOperationResult['diagnostics']): MutationResult<T> {
	return { ok: false, applied: false, diagnostics }
}

function optionsOf(options: Record<string, unknown>): MutationCommandOptions {
	return { project: options.project as string | undefined, format: options.format as 'human' | 'json', noColor: options.color !== true }
}

function output(result: LifecycleOperationResult, options: MutationCommandOptions): CommandOutcome {
	const json = lifecycleResultJson(result)
	return formatMutation(options.format, json, renderLifecycleResult(json), result.ok, result.diagnostics)
}

export async function runLifecycleActivateCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	return output(root.root ? await activateArtifact(root.root, id) : failed(root.diagnostics), common)
}

export async function runLifecycleCompleteCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	return output(root.root ? await completeArtifact(root.root, id) : failed(root.diagnostics), common)
}

export async function runLifecycleRetireCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	return output(root.root ? await retireArtifact(root.root, id) : failed(root.diagnostics), common)
}

export async function runLifecycleSupersedeCommand(argumentReplacement: string | undefined, argumentReplaced: string | undefined, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const replacementId = options.replacement as string | undefined ?? argumentReplacement
	const replacedId = options.replaced as string | undefined ?? argumentReplaced
	if (!replacementId || !replacedId)
		return output(failed([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: 'Lifecycle supersede requires replacement and replaced Artifact IDs.', related: [] }]), common)
	const root = await resolveMutationRoot(common, deps)
	return output(root.root ? await supersedeArtifacts(root.root, replacementId, replacedId) : failed(root.diagnostics), common)
}
