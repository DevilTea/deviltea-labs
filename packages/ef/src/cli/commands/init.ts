/**
 * `ef init` (13-cli-contract.md "Project Initialization", "Mutation Planning
 * and Authorization", "Initialization claim-and-complete protocol").
 *
 * Target selection is `ef init`'s own rule, not ordinary project discovery
 * (13-cli-contract.md "Common Options": "except for `ef init`"): with
 * `--project` the supplied path must be exactly an existing Git worktree
 * root; without it, the worktree root containing `cwd` is used.
 *
 * No CLI-mutation-specific diagnostic code family exists in the registry for
 * purely CLI-level structural conditions (missing authoring values, target
 * not a worktree root, a raced `.engineering` claim); `EF-VAL-001`
 * ("Requested validation scope or invocation is invalid") is reused for
 * those, since 09-validation.md frames the whole `EF-VAL-*` namespace as
 * "Validation invocation, capability, completeness, and internal
 * orchestration" broadly, not only the `ef validate` command. Conditions with
 * an exact registered match (`history-contains-ef-state` -> `EF-VAL-009`,
 * `git-unavailable` -> `EF-VAL-006`, a computed-plan domain rejection ->
 * its own real `validateSnapshot` diagnostics) use that match instead.
 */

import type { ComputeInitPlanDeps, InitValues } from '../../application/init'
import type { ArtifactSummaryProjection } from '../../application/query-projection'
import type { GitExecutor } from '../../git/executor'
import type { CommandOutcome } from '../command-outcome'
import type { MutationPlanPreview, Prompts } from '../prompts'
import { applyInitPlan, computeInitPlan } from '../../application/init'
import { buildArtifactSummary } from '../../application/query-projection'
import { severityOf } from '../../domain/diagnostic-codes'
import { decodeEnvelope } from '../../domain/envelope'
import { createGitRepository } from '../../git/repository'
import { parseFrontmatterDocument, splitFrontmatter } from '../../parsing/frontmatter'
import { buildMutationResultJson } from '../envelopes'
import { renderMutationHuman } from '../human-render'
import { classifyMutationAuthorization } from '../mutation-authorization'

export interface InitCommandValues {
	title?: string
	summary?: string
	vision?: string
	projectScope?: string
	nonGoals?: string
	context?: string
	integrationRef?: string
	terminology?: string
}

export interface InitCommandOptions {
	project?: string
	format: 'human' | 'json'
	noColor: boolean
	/** Already resolved by the caller as `--no-input || format === 'json'` (13-cli-contract.md "JSON mode implies `--no-input`"). */
	noInput: boolean
	dryRun: boolean
	yes: boolean
	values: InitCommandValues
}

export interface InitCommandDeps {
	cwd: string
	executor: GitExecutor
	prompts: Prompts
}

const REQUIRED_FIELDS: Exclude<keyof InitValues, 'terminology'>[] = ['title', 'summary', 'vision', 'projectScope', 'nonGoals', 'context', 'integrationRef']

const FIELD_PROMPTS: Record<Exclude<keyof InitValues, 'terminology'>, string> = {
	title: 'Project title',
	summary: 'One-line project summary',
	vision: 'Vision (markdown)',
	projectScope: 'Scope (markdown)',
	nonGoals: 'Non-goals (markdown)',
	context: 'Context (markdown)',
	integrationRef: 'Integration ref (full local branch ref, e.g. refs/heads/main)',
}

function jsonOutcome(exitCode: CommandOutcome['exitCode'], json: ReturnType<typeof buildMutationResultJson>): CommandOutcome {
	return { exitCode, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
}

function mutationOutcome(options: InitCommandOptions, exitCode: CommandOutcome['exitCode'], input: Omit<Parameters<typeof buildMutationResultJson>[0], 'kind'>): CommandOutcome {
	const json = buildMutationResultJson({ kind: 'init', ...input })
	if (options.format === 'json')
		return jsonOutcome(exitCode, json)
	return { exitCode, stdout: renderMutationHuman(json, !options.noColor), stderr: '' }
}

function earlyFailure(options: InitCommandOptions, exitCode: 1 | 2 | 3, code: Parameters<typeof severityOf>[0], message: string): CommandOutcome {
	return mutationOutcome(options, exitCode, {
		complete: exitCode !== 2,
		applied: false,
		dryRun: options.dryRun,
		changes: [],
		artifact: null,
		diagnostics: [{ code, severity: severityOf(code), message, related: [] }],
	})
}

async function detectCurrentBranch(executor: GitExecutor, root: string): Promise<string | undefined> {
	const outcome = await executor.execIn(root, ['symbolic-ref', '--short', 'HEAD'])
	if (!outcome.ok || outcome.result.exitCode !== 0)
		return undefined
	const name = outcome.result.stdout.toString('utf8')
		.trim()
	return name.length > 0 ? name : undefined
}

async function collectValuesInteractively(options: InitCommandOptions, deps: InitCommandDeps): Promise<InitValues | undefined> {
	const collected: Partial<InitValues> = { ...options.values }

	for (const field of REQUIRED_FIELDS) {
		if (collected[field] !== undefined && collected[field]!.trim().length > 0)
			continue

		if (field === 'integrationRef') {
			const branch = await detectCurrentBranch(deps.executor, deps.cwd)
			if (branch !== undefined) {
				const fullRef = `refs/heads/${branch}`
				const confirmed = await deps.prompts.confirm({ message: `Use '${fullRef}' as the integration ref?`, initialValue: false })
				if (confirmed === undefined)
					return undefined
				if (confirmed) {
					collected.integrationRef = fullRef
					continue
				}
			}
		}

		const value = await deps.prompts.text({ message: FIELD_PROMPTS[field] })
		if (value === undefined)
			return undefined
		collected[field] = value
	}

	if (collected.terminology === undefined) {
		const provideTerms = await deps.prompts.confirm({ message: 'Add Terminology rows now?', initialValue: false })
		if (provideTerms === undefined)
			return undefined
		// Interactive term-row collection beyond a yes/no gate is left to a
		// future authoring flow; declining leaves the canonical header-only
		// table, and `computeInitPlan` MUST NOT invent project terms.
	}

	return collected as InitValues
}

function planPreview(changes: readonly { action: string, path: string }[]): MutationPlanPreview {
	return { title: 'ef init', lines: changes.map(c => `${c.action} ${c.path}`) }
}

function projectSummaryFromPlanFiles(files: readonly { path: string, bytes: Uint8Array }[]): ArtifactSummaryProjection | null {
	const projectFile = files.find(f => f.path === '.engineering/PROJECT.md')
	if (!projectFile)
		return null
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(projectFile.bytes)
	const frontmatter = splitFrontmatter(text)
	if (!frontmatter.ok)
		return null
	const document = parseFrontmatterDocument(frontmatter.frontmatterText, projectFile.path, { startLine: 2 })
	const decoded = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, projectFile.path)
	if (!decoded.envelope)
		return null
	return buildArtifactSummary(decoded.envelope, projectFile.path)
}

export async function runInitCommand(options: InitCommandOptions, deps: InitCommandDeps): Promise<CommandOutcome> {
	// ---- Target selection (13-cli-contract.md "Project Initialization") -----

	let targetRoot: string
	if (options.project !== undefined) {
		targetRoot = options.project
	}
	else {
		const worktree = await deps.executor.execIn(deps.cwd, ['rev-parse', '--show-toplevel'])
		if (!worktree.ok || worktree.result.exitCode !== 0)
			return earlyFailure(options, 2, 'EF-VAL-001', 'The current directory is not inside a Git worktree.')
		targetRoot = worktree.result.stdout.toString('utf8')
			.trim()
	}

	// ---- Value collection -----------------------------------------------------

	let values: InitValues
	if (options.noInput) {
		const missing = REQUIRED_FIELDS.filter(field => options.values[field] === undefined || options.values[field]!.trim().length === 0)
		if (missing.length > 0)
			return earlyFailure(options, 2, 'EF-VAL-001', `Missing required non-interactive value(s): ${missing.join(', ')}.`)
		values = options.values as InitValues
	}
	else {
		deps.prompts.intro('ef init')
		const collected = await collectValuesInteractively(options, deps)
		if (collected === undefined) {
			deps.prompts.outro('Cancelled.')
			return earlyFailure(options, 2, 'EF-VAL-001', 'Interactive initialization was cancelled.')
		}
		values = collected
	}

	// ---- Plan computation -------------------------------------------------------

	const git = createGitRepository(targetRoot, deps.executor)
	const planDeps: ComputeInitPlanDeps = git
	const planResult = await computeInitPlan({ targetRoot, values }, planDeps)

	if (!planResult.ok) {
		switch (planResult.reason) {
			case 'git-unavailable':
				return earlyFailure(options, 2, 'EF-VAL-006', planResult.message)
			case 'history-contains-ef-state':
				return earlyFailure(options, 1, 'EF-VAL-009', planResult.message)
			case 'invalid-plan':
				return mutationOutcome(options, 1, {
					complete: true,
					applied: false,
					dryRun: options.dryRun,
					changes: [],
					artifact: null,
					diagnostics: planResult.diagnostics ?? [],
				})
			case 'missing-value':
			case 'invalid-integration-ref':
			case 'not-a-worktree-root':
				return earlyFailure(options, 2, 'EF-VAL-001', planResult.message)
		}
	}

	const plan = planResult.plan
	const artifact = projectSummaryFromPlanFiles(plan.files)

	// ---- Authorization ----------------------------------------------------------

	const classification = classifyMutationAuthorization({ dryRun: options.dryRun, yes: options.yes, noInput: options.noInput })

	if (classification === 'dry-run') {
		return mutationOutcome(options, 0, { complete: true, applied: false, dryRun: true, changes: plan.changes, artifact, diagnostics: [] })
	}

	if (classification === 'missing-authorization') {
		return earlyFailure(options, 2, 'EF-VAL-001', 'Mutation authorization is required: supply --dry-run or --yes in non-interactive mode.')
	}

	if (classification === 'needs-confirmation') {
		const confirmed = await deps.prompts.confirmMutation(planPreview(plan.changes))
		if (!confirmed) {
			return mutationOutcome(options, 2, { complete: false, applied: false, dryRun: false, changes: plan.changes, artifact, diagnostics: [] })
		}
	}

	// ---- Application --------------------------------------------------------

	try {
		const applyResult = await applyInitPlan(plan)
		if (applyResult.applied) {
			return mutationOutcome(options, 0, { complete: true, applied: true, dryRun: false, changes: applyResult.changes, artifact, diagnostics: [] })
		}
		if (applyResult.outcome === 'raced') {
			return mutationOutcome(options, 1, {
				complete: true,
				applied: false,
				dryRun: false,
				changes: plan.changes,
				artifact,
				diagnostics: [{ code: 'EF-VAL-001', severity: 'error', message: applyResult.message, related: [] }],
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
			diagnostics: [{ code: 'EF-VAL-008', severity: 'error', message: `Internal failure while applying the initialization plan: ${(error as Error).message}`, related: [] }],
		})
	}
}
