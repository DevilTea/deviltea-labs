/**
 * `ef query <kind>` execution (13-cli-contract.md "Query Commands";
 * 10-query-and-trace.md "Stable Query Result Envelope").
 *
 * The query kind is already known by the time this handler runs (it is
 * commander's own subcommand routing, per 13-cli-contract.md's discriminator
 * examples: "such as validation scope or query kind"); every failure from
 * here on -- including project resolution -- uses the `ef/query-result@1`
 * envelope with `complete: false`. `complete` is the sole exit-code
 * discriminator for query commands (`0` when `true`, `2` when `false`):
 * unlike validation, query has no separate strict/warnings-as-errors policy
 * axis and every documented query failure example (`EF-QRY-010`,
 * `EF-QRY-014`, the incomplete-initialization case) pairs `complete: false`
 * with exit `2`.
 */

import type { QueryContext } from '../../application/query'
import type { QueryKind, QueryRequest, QueryResult } from '../../application/query-types'
import type { GitExecutor } from '../../git/executor'
import type { CommandOutcome } from '../command-outcome'
import { executeQuery, incompleteInitializationQueryResult } from '../../application/query'
import { loadSnapshotFromWorkingTree } from '../../application/snapshot'
import { validateSnapshot } from '../../application/snapshot-validation'
import { queryResultToJson } from '../envelopes'
import { renderQueryHuman } from '../human-render'
import { resolveProject } from '../project-context'

export interface QueryCommandOptions {
	project?: string
	format: 'human' | 'json'
	noColor: boolean
}

export interface QueryCommandDeps {
	cwd: string
	executor: GitExecutor
}

function projectResolutionFailureResult(kind: QueryKind): QueryResult {
	// `EF-QRY-013` covers every project-resolution failure uniformly, not only
	// the dedicated incomplete-initialization case (10-query-and-trace.md
	// "Query cannot produce a complete trustworthy result" is this code's
	// general condition text; the incomplete-initialization wording is one
	// named example of it, per "Invalid Graph and Partial Results").
	return incompleteInitializationQueryResult(kind)
}

function outcomeFor(result: QueryResult, format: 'human' | 'json', noColor: boolean): CommandOutcome {
	const exitCode = result.complete ? 0 : 2
	const json = queryResultToJson(result)
	if (format === 'json')
		return { exitCode, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
	void noColor // query human rendering has no color to gate today; kept for a uniform command signature.
	return { exitCode, stdout: renderQueryHuman(json), stderr: '' }
}

export async function runQueryCommand(request: QueryRequest, options: QueryCommandOptions, deps: QueryCommandDeps): Promise<CommandOutcome> {
	const resolved = await resolveProject({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
	if (!resolved.ok)
		return outcomeFor(projectResolutionFailureResult(request.kind), options.format, options.noColor)

	const { root, config, git } = resolved.context

	const loaded = await loadSnapshotFromWorkingTree(root)
	if (!loaded.ok)
		return outcomeFor(projectResolutionFailureResult(request.kind), options.format, options.noColor)

	const validation = validateSnapshot(loaded.snapshot)

	let history: QueryContext['history']
	if (request.kind === 'history' && config) {
		const refResult = await git.resolveRef(config.repository.integrationRef)
		if (refResult.kind === 'resolved')
			history = { git, integrationRefOid: refResult.oid }
	}

	const result = await executeQuery({ snapshot: loaded.snapshot, validation, history }, request)
	return outcomeFor(result, options.format, options.noColor)
}
