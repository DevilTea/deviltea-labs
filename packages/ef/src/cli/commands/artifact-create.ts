/**
 * `ef artifact create <type>` (13-cli-contract.md "Draft Artifact Creation",
 * "Mutation Planning and Authorization", "Draft Artifact hard-link
 * publication").
 *
 * Unlike `ef init`, this is an ordinary project command: project resolution
 * uses `../project-context.ts`'s standard upward discovery
 * (13-cli-contract.md "Common Options"), not `ef init`'s worktree-root-only
 * rule.
 *
 * Exit-code/diagnostic-code choices mirror `./init.ts`'s documented
 * reasoning: `EF-VAL-001` for CLI-only structural conditions with no exact
 * registered match, `EF-ID-004` for a path/ID already claimed (both at
 * plan-compute time and as an apply-time race -- 13-cli-contract.md's own
 * Exit `1` class explicitly names both "identity collision" and "a race that
 * invalidates a mutation plan"), and an unsupported hard-link filesystem
 * mapped to exit `2` per "the mutation is incomplete and exits `2`; Core does
 * not silently degrade to a partially visible write protocol."
 */

import type { GitExecutor } from '../../git/executor'
import type { CommandOutcome } from '../command-outcome'
import type { MutationPlanPreview, Prompts } from '../prompts'
import { applyCreatePlan, computeCreatePlan } from '../../application/artifact-create'
import { buildArtifactSummary } from '../../application/query-projection'
import { loadSnapshotFromWorkingTree } from '../../application/snapshot'
import { severityOf } from '../../domain/diagnostic-codes'
import { buildMutationResultJson } from '../envelopes'
import { renderMutationHuman } from '../human-render'
import { classifyMutationAuthorization } from '../mutation-authorization'
import { resolveProject } from '../project-context'

export interface ArtifactCreateCommandOptions {
	/** Raw CLI type token, e.g. `prd`, `req`, `adr`, `pol`, `chg`. */
	type: string
	title?: string
	summary?: string
	project?: string
	format: 'human' | 'json'
	noColor: boolean
	/** Already resolved by the caller as `--no-input || format === 'json'`. */
	noInput: boolean
	dryRun: boolean
	yes: boolean
}

export interface ArtifactCreateCommandDeps {
	cwd: string
	executor: GitExecutor
	prompts: Prompts
}

function mutationOutcome(options: ArtifactCreateCommandOptions, exitCode: CommandOutcome['exitCode'], input: Omit<Parameters<typeof buildMutationResultJson>[0], 'kind'>): CommandOutcome {
	const json = buildMutationResultJson({ kind: 'artifact-create', ...input })
	if (options.format === 'json')
		return { exitCode, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
	return { exitCode, stdout: renderMutationHuman(json, !options.noColor), stderr: '' }
}

function earlyFailure(options: ArtifactCreateCommandOptions, exitCode: 1 | 2, code: Parameters<typeof severityOf>[0], message: string): CommandOutcome {
	return mutationOutcome(options, exitCode, {
		complete: exitCode !== 2,
		applied: false,
		dryRun: options.dryRun,
		changes: [],
		artifact: null,
		diagnostics: [{ code, severity: severityOf(code), message, related: [] }],
	})
}

export async function runArtifactCreateCommand(options: ArtifactCreateCommandOptions, deps: ArtifactCreateCommandDeps): Promise<CommandOutcome> {
	const resolved = await resolveProject({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
	if (!resolved.ok) {
		const code = resolved.reason === 'incomplete-initialization' ? 'EF-VAL-012' : resolved.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
		return earlyFailure(options, 2, code, resolved.message)
	}
	const { root } = resolved.context

	const loaded = await loadSnapshotFromWorkingTree(root)
	if (!loaded.ok) {
		const code = loaded.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
		return earlyFailure(options, 2, code, loaded.message)
	}

	// ---- Title/summary collection ----------------------------------------------

	let title = options.title
	let summary = options.summary

	if (options.noInput) {
		const missing = [title === undefined || title.trim().length === 0 ? 'title' : undefined, summary === undefined || summary.trim().length === 0 ? 'summary' : undefined].filter((x): x is string => x !== undefined)
		if (missing.length > 0)
			return earlyFailure(options, 2, 'EF-VAL-001', `Missing required non-interactive value(s): ${missing.join(', ')}.`)
	}
	else {
		deps.prompts.intro(`ef artifact create ${options.type}`)
		if (title === undefined || title.trim().length === 0) {
			const value = await deps.prompts.text({ message: 'Title' })
			if (value === undefined) {
				deps.prompts.outro('Cancelled.')
				return earlyFailure(options, 2, 'EF-VAL-001', 'Interactive Artifact creation was cancelled.')
			}
			title = value
		}
		if (summary === undefined || summary.trim().length === 0) {
			const value = await deps.prompts.text({ message: 'Summary' })
			if (value === undefined) {
				deps.prompts.outro('Cancelled.')
				return earlyFailure(options, 2, 'EF-VAL-001', 'Interactive Artifact creation was cancelled.')
			}
			summary = value
		}
	}

	// ---- Plan computation ---------------------------------------------------

	const planResult = computeCreatePlan({ snapshot: loaded.snapshot, type: options.type, title: title ?? '', summary: summary ?? '' })

	if (!planResult.ok) {
		switch (planResult.reason) {
			case 'invalid-type':
			case 'missing-value':
				return earlyFailure(options, 2, 'EF-VAL-001', planResult.message)
			case 'target-exists':
				return earlyFailure(options, 1, 'EF-ID-004', planResult.message)
			case 'invalid-plan':
				return mutationOutcome(options, 1, { complete: true, applied: false, dryRun: options.dryRun, changes: [], artifact: null, diagnostics: planResult.diagnostics ?? [] })
		}
	}

	const plan = planResult.plan
	const artifact = buildArtifactSummary(plan.envelope, plan.path)

	// ---- Authorization --------------------------------------------------------

	const classification = classifyMutationAuthorization({ dryRun: options.dryRun, yes: options.yes, noInput: options.noInput })

	if (classification === 'dry-run')
		return mutationOutcome(options, 0, { complete: true, applied: false, dryRun: true, changes: plan.changes, artifact, diagnostics: [] })

	if (classification === 'missing-authorization')
		return earlyFailure(options, 2, 'EF-VAL-001', 'Mutation authorization is required: supply --dry-run or --yes in non-interactive mode.')

	if (classification === 'needs-confirmation') {
		const preview: MutationPlanPreview = { title: `ef artifact create ${options.type}`, lines: plan.changes.map(c => `${c.action} ${c.path}`) }
		const confirmed = await deps.prompts.confirmMutation(preview)
		if (!confirmed)
			return mutationOutcome(options, 2, { complete: false, applied: false, dryRun: false, changes: plan.changes, artifact, diagnostics: [] })
	}

	// ---- Application ----------------------------------------------------------

	try {
		const applyResult = await applyCreatePlan(plan, root)
		if (applyResult.applied)
			return mutationOutcome(options, 0, { complete: true, applied: true, dryRun: false, changes: plan.changes, artifact, diagnostics: [] })

		if (applyResult.outcome === 'raced') {
			return mutationOutcome(options, 1, {
				complete: true,
				applied: false,
				dryRun: false,
				changes: plan.changes,
				artifact,
				diagnostics: [{ code: 'EF-ID-004', severity: 'error', message: applyResult.message, related: [] }],
			})
		}

		return mutationOutcome(options, 2, {
			complete: false,
			applied: false,
			dryRun: false,
			changes: plan.changes,
			artifact,
			diagnostics: [{ code: 'EF-VAL-001', severity: 'error', message: applyResult.message, related: [] }],
		})
	}
	catch (error) {
		return mutationOutcome(options, 3, {
			complete: false,
			applied: false,
			dryRun: false,
			changes: plan.changes,
			artifact,
			diagnostics: [{ code: 'EF-VAL-008', severity: 'error', message: `Internal failure while applying the create plan: ${(error as Error).message}`, related: [] }],
		})
	}
}
