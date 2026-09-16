import type { MutationResult, RelationView } from '../../application/mutations'
import type { Artifact } from '../../domain/model'
import type { RelationType } from '../../domain/relations'
import type { CommandOutcome } from '../command-outcome'
import type { MutationCommandDeps, MutationCommandOptions } from './mutation'
import { addRelation, listRelations, removeRelation } from '../../application/mutations'
import { isRelationType } from '../../domain/relations'
import { relationListResultJson, relationResultJson } from '../envelopes'
import { renderRelationList, renderRelationResult } from '../human-render'
import { formatMutation, noColor, resolveMutationRoot } from './mutation'

type RelationOperationResult = MutationResult<RelationView | { replacement: Artifact, replaced: Artifact }>

function failed<T>(diagnostics: RelationOperationResult['diagnostics']): MutationResult<T> {
	return { ok: false, applied: false, diagnostics }
}

function optionsOf(options: Record<string, unknown>): MutationCommandOptions {
	return { project: options.project as string | undefined, format: options.format as 'human' | 'json', noColor: options.color !== true }
}

export async function runRelationAddCommand(sourceId: string, targetId: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const type = options.type as string | undefined
	const result: RelationOperationResult = !root.root
		? failed(root.diagnostics)
		: !isRelationType(type)
				? failed([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown relation type '${type ?? ''}'.`, field: 'type', related: [] }])
				: await addRelation(root.root, sourceId, targetId, type)
	const json = relationResultJson(result)
	return formatMutation(common.format, json, renderRelationResult(json), result.ok, result.diagnostics)
}

export async function runRelationRemoveCommand(sourceId: string, targetId: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const type = options.type as string | undefined
	const result: RelationOperationResult = !root.root
		? failed(root.diagnostics)
		: !isRelationType(type)
				? failed([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown relation type '${type ?? ''}'.`, field: 'type', related: [] }])
				: await removeRelation(root.root, sourceId, targetId, type)
	const json = relationResultJson(result)
	return formatMutation(common.format, json, renderRelationResult(json), result.ok, result.diagnostics)
}

export async function runRelationListCommand(options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const type = options.type as string | undefined
	const directionValue = options.direction as string | undefined
	const result = !root.root
		? failed<RelationView[]>(root.diagnostics)
		: directionValue !== undefined && !['incoming', 'outgoing', 'all'].includes(directionValue)
			? failed<RelationView[]>([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown relation direction '${directionValue}'.`, field: 'direction', related: [] }])
			: type !== undefined && !isRelationType(type)
				? failed<RelationView[]>([{ code: 'SPEC-CLI-INVALID', severity: 'error', message: `Unknown relation type '${type}'.`, field: 'type', related: [] }])
				: await listRelations(root.root, { artifactId: options.artifact as string | undefined, direction: directionValue as 'incoming' | 'outgoing' | 'all' | undefined, type: type as RelationType | undefined })
	const json = relationListResultJson(result)
	return formatMutation(common.format, json, renderRelationList(json), result.ok, result.diagnostics)
}
