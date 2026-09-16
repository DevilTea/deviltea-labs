import type { QueryResult, SearchMatch, TraceValue } from '../../application/queries'
import type { CommandOutcome } from '../command-outcome'
import type { MutationCommandDeps, MutationCommandOptions } from './mutation'
import { searchArtifacts, traceRefines } from '../../application/queries'
import { searchResultJson, traceResultJson } from '../envelopes'
import { renderSearchResult, renderTraceResult } from '../human-render'
import { formatMutation, noColor, resolveMutationRoot } from './mutation'

function failed<T>(diagnostics: QueryResult<T>['diagnostics']): QueryResult<T> {
	return { ok: false, diagnostics }
}

function optionsOf(options: Record<string, unknown>): MutationCommandOptions {
	return { project: options.project as string | undefined, format: options.format as 'human' | 'json', noColor: options.color !== true }
}

export async function runSearchCommand(text: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const result: QueryResult<SearchMatch[]> = root.root
		? await searchArtifacts(root.root, text, { kind: options.kind as string | undefined, status: options.status as string | undefined })
		: failed(root.diagnostics)
	const json = searchResultJson(text, { kind: options.kind as string | undefined, status: options.status as string | undefined }, result)
	return formatMutation(common.format, json, renderSearchResult(json), result.ok, result.diagnostics)
}

export async function runTraceCommand(artifactId: string, options: Record<string, unknown>, deps: MutationCommandDeps): Promise<CommandOutcome> {
	const common = optionsOf(options)
	noColor(common)
	const root = await resolveMutationRoot(common, deps)
	const direction = (options.direction as string | undefined) ?? 'both'
	const result: QueryResult<TraceValue> = root.root ? await traceRefines(root.root, artifactId, direction) : failed(root.diagnostics)
	const json = traceResultJson(artifactId, direction, result)
	return formatMutation(common.format, json, renderTraceResult(json), result.ok, result.diagnostics)
}
