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
import { severityOf } from '../../domain/diagnostic-codes'
import { findWorktreeRoot } from '../../git/repository'
import { checkWorkingDirectoryAssociation } from '../../repository/discovery'
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

	// `resolved.context.config` (project resolution's own, separate read of
	// `.engineering/ef.yaml`) is deliberately never consulted below (Finding
	// 3): an in-place rewrite landing between that read and
	// `loadSnapshotFromWorkingTree`'s later, separate read of the same file
	// would otherwise let history's integration ref derive from a DIFFERENT
	// observation than the one the graph below was actually validated
	// against -- e.g. history resolved against ref A while validation/query
	// proceeds over a working-tree snapshot that itself declares ref B. Every
	// config-dependent command semantic here derives exclusively from
	// `loaded.snapshot.config.config`, the single, freshest observation the
	// queried snapshot was itself built from.
	const { root, git, engineeringIdentity } = resolved.context

	// `expectedEngineeringIdentity` (Finding 4, "single observation"): binds
	// this snapshot's own directory walk to the exact `.engineering` project
	// resolution already approved, rather than trusting a bare path string a
	// race could have re-pointed at a different directory (e.g. one omitting
	// an Artifact file) between that approval and this walk. This is
	// orthogonal to the `config` note above: it verifies WHICH directory is
	// enumerated, never which config bytes are used.
	const loaded = await loadSnapshotFromWorkingTree(root, undefined, { expectedEngineeringIdentity: engineeringIdentity })
	if (!loaded.ok)
		return outcomeFor(projectResolutionFailureResult(request.kind), options.format, options.noColor)

	const validation = validateSnapshot(loaded.snapshot)
	const config = loaded.snapshot.config.config

	// Re-run the working-directory association decision (Finding 5, "single
	// observation") against `config`, the freshest configuration `loaded`
	// itself was built from -- not `resolveProject`'s own, earlier read. An
	// in-place rewrite of `ef.yaml` landing between that earlier read and this
	// snapshot load could otherwise leave a now-undeclared nested worktree
	// authorized only by a stale association decision (11-filesystem-and-config.md
	// "Project Discovery": "validate working-directory association with the
	// project"). Any non-`associated` outcome (including a probe failure) is
	// folded into the same project-resolution-class failure as `!resolved.ok`/
	// `!loaded.ok` above.
	const association = await checkWorkingDirectoryAssociation(
		{ cwd: deps.cwd, candidateRoot: root, config },
		{ findWorktreeRoot: absolutePath => findWorktreeRoot(deps.executor, absolutePath) },
	)
	if (association.kind !== 'associated')
		return outcomeFor(projectResolutionFailureResult(request.kind), options.format, options.noColor)

	let history: QueryContext['history']
	if (request.kind === 'history' && config) {
		const refResult = await git.resolveRef(config.repository.integrationRef)
		if (refResult.kind === 'resolved') {
			history = { git, integrationRefOid: refResult.oid, integrationRef: config.repository.integrationRef }
		}
		else if (refResult.kind === 'error' || refResult.kind === 'git-unavailable') {
			// A failed probe is neither a proven resolution nor a proven absence
			// (`'proven-absent'`, which legitimately falls through and lets
			// `executeQuery`'s own generic "no history context" `EF-QRY-010`
			// apply below): it MUST make history incomplete, with the actual Git
			// failure surfaced, rather than silently collapsing into the same
			// undifferentiated "history context unavailable" outcome as an
			// ordinary unresolved ref (10-query-and-trace.md "the query fails
			// with EF-QRY-010" for history that is "inaccessible ... or
			// otherwise cannot be materialized completely"; parity with
			// `validate.ts`'s `EF-VAL-006` messages for the same class of
			// failure).
			return outcomeFor({
				schema: 'ef/query-result@1',
				kind: 'history',
				complete: false,
				data: null,
				diagnostics: [{
					code: 'EF-QRY-010',
					severity: severityOf('EF-QRY-010'),
					message: `Git failed while resolving the integration ref '${config.repository.integrationRef}' required for history: ${refResult.message}`,
					related: [],
				}],
			}, options.format, options.noColor)
		}
	}

	const result = await executeQuery({ snapshot: loaded.snapshot, validation, history }, request)
	return outcomeFor(result, options.format, options.noColor)
}
