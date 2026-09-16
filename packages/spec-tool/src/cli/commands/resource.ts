import type { MutationResult, ResourceReadValue } from '../../application/mutations'
import type { ResourceDescriptor } from '../../domain/model'
import type { CommandOutcome } from '../command-outcome'
import type { MutationCommandDeps, MutationCommandOptions } from './mutation'
import { addResource, listResources, readResource, removeResource } from '../../application/mutations'
import { resourceListResultJson, resourceReadResultJson, resourceResultJson } from '../envelopes'
import { renderResourceList, renderResourceRead, renderResourceResult } from '../human-render'
import { formatMutation, noColor, resolveMutationRoot } from './mutation'

function failed<T>(diagnostics: MutationResult<T>['diagnostics']): MutationResult<T> {
	return { ok: false, applied: false, diagnostics }
}

function optionsOf(options: Record<string, unknown>): MutationCommandOptions {
	return { project: options.project as string | undefined, format: options.format as 'human' | 'json', noColor: options.color !== true }
}

export async function runResourceAddCommand(artifactId: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result = root.root
		? await addResource(root.root, {
				artifactId,
				location: options.location as string,
				role: options.role as string,
				mediaType: options.mediaType as string,
				description: (options.description as string | undefined) ?? '',
			})
		: failed<ResourceDescriptor>(root.diagnostics)
	const json = resourceResultJson(result)
	return formatMutation(common.format, json, renderResourceResult(json), result.ok, result.diagnostics)
}

export async function runResourceRemoveCommand(artifactId: string, location: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result = root.root ? await removeResource(root.root, artifactId, location) : failed<ResourceDescriptor>(root.diagnostics)
	const json = resourceResultJson(result)
	return formatMutation(common.format, json, renderResourceResult(json), result.ok, result.diagnostics)
}

export async function runResourceListCommand(options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result = root.root ? await listResources(root.root, { artifactId: options.artifact as string | undefined }) : failed<Array<{ artifactId: string, resource: ResourceDescriptor }>>(root.diagnostics)
	const json = resourceListResultJson(result)
	return formatMutation(common.format, json, renderResourceList(json), result.ok, result.diagnostics)
}

export async function runResourceReadCommand(artifactId: string, location: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result = root.root ? await readResource(root.root, artifactId, location) : failed<ResourceReadValue>(root.diagnostics)
	const json = resourceReadResultJson(result)
	return formatMutation(common.format, json, renderResourceRead(json), result.ok, result.diagnostics)
}
