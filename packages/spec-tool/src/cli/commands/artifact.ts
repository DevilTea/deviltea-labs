import type { MutationResult } from '../../application/mutations'
import type { Artifact, ArtifactKind, Status } from '../../domain/model'
import type { CommandOutcome } from '../command-outcome'
import type { MutationCommandDeps, MutationCommandOptions } from './mutation'
import { createArtifact, deleteArtifact, getArtifact, listArtifacts, updateArtifact } from '../../application/mutations'
import { isArtifactKind, isStatus } from '../../domain/model'
import { artifactDeleteResultJson, artifactListResultJson, artifactResultJson } from '../envelopes'
import { renderArtifactDelete, renderArtifactList, renderArtifactResult } from '../human-render'
import { formatMutation, noColor, readBodyOption, resolveMutationRoot } from './mutation'

function failed<T>(diagnostics: MutationResult<T>['diagnostics']): MutationResult<T> {
	return { ok: false, applied: false, diagnostics }
}

function optionsOf(options: Record<string, unknown>): MutationCommandOptions {
	return { project: options.project as string | undefined, format: options.format as 'human' | 'json', noColor: options.color !== true }
}

function outputArtifact(action: 'create' | 'get' | 'update', result: MutationResult<Artifact>, options: MutationCommandOptions): CommandOutcome {
	const json = artifactResultJson(action, result)
	return formatMutation(options.format, json, renderArtifactResult(json), result.ok, result.diagnostics)
}

export async function runArtifactCreateCommand(options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const kindValue = options.kind as string | undefined
	const statusValue = options.status as string | undefined
	if (!root.root)
		return outputArtifact('create', failed(root.diagnostics), common)
	if (!isArtifactKind(kindValue))
		return outputArtifact('create', failed([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown artifact kind '${kindValue ?? ''}'.`, field: 'kind', related: [] }]), common)
	if (statusValue !== undefined && !isStatus(statusValue))
		return outputArtifact('create', failed([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown artifact status '${statusValue}'.`, field: 'status', related: [] }]), common)
	const body = await readBodyOption(options.body as string | undefined, options.bodyFile as string | undefined, deps.cwd)
	if (body.diagnostics.length > 0)
		return outputArtifact('create', failed(body.diagnostics), common)
	return outputArtifact('create', await createArtifact(root.root, { kind: kindValue, title: options.title as string, body: body.body, status: statusValue as Status | undefined }), common)
}

export async function runArtifactGetCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	return outputArtifact('get', root.root ? await getArtifact(root.root, id) : failed(root.diagnostics), common)
}

export async function runArtifactUpdateCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	if (!root.root)
		return outputArtifact('update', failed(root.diagnostics), common)
	const body = await readBodyOption(options.body as string | undefined, options.bodyFile as string | undefined, deps.cwd)
	if (body.diagnostics.length > 0)
		return outputArtifact('update', failed(body.diagnostics), common)
	return outputArtifact('update', await updateArtifact(root.root, { id, title: options.title as string | undefined, body: body.body }), common)
}

export async function runArtifactDeleteCommand(id: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result = root.root ? await deleteArtifact(root.root, id) : failed<{ id: string, path: string }>(root.diagnostics)
	const json = artifactDeleteResultJson(result)
	return formatMutation(common.format, json, renderArtifactDelete(json), result.ok, result.diagnostics)
}

export async function runArtifactListCommand(options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const kind = options.kind as string | undefined
	const status = options.status as string | undefined
	const result = !root.root
		? failed<Artifact[]>(root.diagnostics)
		: await listArtifacts(root.root, {
				kind: kind as ArtifactKind | undefined,
				status: status as Status | undefined,
			})
	const json = artifactListResultJson(result)
	return formatMutation(common.format, json, renderArtifactList(json), result.ok, result.diagnostics)
}
