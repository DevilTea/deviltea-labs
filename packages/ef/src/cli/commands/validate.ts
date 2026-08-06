/**
 * `ef validate` (13-cli-contract.md "Validation Command"; 09-validation.md
 * "Validation Scopes", "Bootstrap exception").
 *
 * Scope, `--baseline`/`--proposed` applicability, and `--format` are already
 * known-valid by the time this handler runs (`../program.ts` rejects an
 * invalid discriminator or format value pre-envelope); every failure from
 * here on uses the `ef/validation-result@1` envelope, per 13-cli-contract.md
 * "Once a fixed envelope is selected, later option, invocation, discovery, or
 * input failures MUST use that incomplete command envelope."
 *
 * Project resolution uses ordinary upward discovery
 * (`../project-context.ts`) for every scope, not `ef init`'s
 * worktree-root-only rule: 13-cli-contract.md's "Common Options" section
 * carves out only `ef init` from upward discovery. In practice, a bootstrap
 * candidate is validated only after a local `ef init` has already populated
 * the working tree (13-cli-contract.md "Project Initialization"), so ordinary
 * discovery finds real `.engineering` content even though that content is not
 * yet authoritative.
 *
 * `integration_ref` for transition/bootstrap scope is read directly from the
 * relevant trusted commit's own materialized configuration (`peekConfigAt`),
 * not from the current working tree's configuration -- the working tree's
 * config may be unrelated (CI need not have `.engineering/ef.yaml` checked
 * out matching the baseline) and 09-validation.md's "operation-start captured
 * ... local-ref state" is defined against the trusted commit's own fixed
 * ref, resolved fresh at the moment validation begins.
 */

import type { OperationStartRefState } from '../../application/bootstrap-validation'
import type { ValidationPolicy } from '../../application/snapshot-validation'
import type { GitExecutor } from '../../git/executor'
import type { GitRepository } from '../../git/repository'
import type { Config } from '../../repository/config'
import type { CommandOutcome } from '../command-outcome'
import { validateBootstrap } from '../../application/bootstrap-validation'
import { loadSnapshotFromWorkingTree } from '../../application/snapshot'
import { summarizeValidation, validateSnapshot } from '../../application/snapshot-validation'
import { validateTransition } from '../../application/transition-validation'
import { severityOf } from '../../domain/diagnostic-codes'
import { decodeConfig } from '../../repository/config'
import { validateWorkspace } from '../../repository/workspace'
import { buildValidationResultJson } from '../envelopes'
import { renderValidationHuman } from '../human-render'
import { resolveCommitBoundProject, resolveProject } from '../project-context'
import { createWorkspaceDeps } from '../workspace-deps'

export type ValidateScope = 'snapshot' | 'transition' | 'bootstrap'

export interface ValidateCommandOptions {
	scope: ValidateScope
	baseline?: string
	proposed?: string
	strict: boolean
	warningsAsErrors: boolean
	workspace: boolean
	format: 'human' | 'json'
	noColor: boolean
	project?: string
}

export interface ValidateCommandDeps {
	cwd: string
	executor: GitExecutor
}

function policyFrom(options: ValidateCommandOptions): ValidationPolicy {
	return { strict: options.strict, warningsAsErrors: options.warningsAsErrors }
}

function outcomeFor(
	format: 'human' | 'json',
	noColor: boolean,
	workspace: boolean,
	summary: ReturnType<typeof summarizeValidation>,
	diagnostics: Parameters<typeof buildValidationResultJson>[1],
): CommandOutcome {
	const json = buildValidationResultJson(summary, diagnostics, workspace)
	if (format === 'json')
		return { exitCode: json.exit_code, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
	return { exitCode: json.exit_code, stdout: renderValidationHuman(json, !noColor), stderr: '' }
}

function earlyFailure(options: ValidateCommandOptions, code: Parameters<typeof severityOf>[0], message: string): CommandOutcome {
	const summary = summarizeValidation({
		scope: options.scope,
		diagnostics: [{ code, severity: severityOf(code), message, related: [] }],
		complete: false,
		policy: policyFrom(options),
	})
	return outcomeFor(options.format, options.noColor, options.workspace, summary, [{ code, severity: severityOf(code), message, related: [] }])
}

async function peekConfigAt(git: GitRepository, commitOid: string): Promise<Config | undefined> {
	const tree = await git.readTree(commitOid)
	if (tree.kind !== 'resolved')
		return undefined
	const entry = tree.entries.find(e => e.path === '.engineering/ef.yaml' && e.type === 'blob')
	if (!entry)
		return undefined
	const blob = await git.readBlob(entry.oid)
	if (blob.kind !== 'resolved')
		return undefined
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(blob.bytes)
	return decodeConfig(text, '.engineering/ef.yaml').config ?? undefined
}

async function applyWorkspaceChecks(
	root: string,
	executor: GitExecutor,
	linkedRepositories: Config['linkedRepositories'],
): Promise<{ diagnostics: ReturnType<typeof validateSnapshot>['diagnostics'], complete: boolean }> {
	const result = await validateWorkspace({ linkedRepositories }, createWorkspaceDeps(root, executor))
	return result
}

export async function runValidateCommand(options: ValidateCommandOptions, deps: ValidateCommandDeps): Promise<CommandOutcome> {
	// ---- Scope/option applicability (13-cli-contract.md "Validation Command") ----

	if (options.scope !== 'transition' && options.baseline !== undefined)
		return earlyFailure(options, 'EF-VAL-001', `'--baseline' is invalid for '${options.scope}' scope.`)
	if (options.scope === 'transition' && options.baseline === undefined)
		return earlyFailure(options, 'EF-VAL-002', '\'--baseline\' is required for transition scope.')
	if (options.scope === 'snapshot' && options.proposed !== undefined)
		return earlyFailure(options, 'EF-VAL-001', '\'--proposed\' is invalid for snapshot scope.')
	if (options.scope !== 'snapshot' && options.proposed === undefined)
		return earlyFailure(options, 'EF-VAL-011', `'--proposed' is required for '${options.scope}' scope.`)

	// ---- Project resolution (13-cli-contract.md "Common Options"; ----------
	// ---- 11-filesystem-and-config.md "Project Discovery" commit-bound -----
	// ---- exception) ----------------------------------------------------------

	let root: string
	let config: Config | null
	let git: GitRepository

	if (options.scope !== 'snapshot' && options.project !== undefined) {
		// Commit-bound transition/bootstrap validation may target a working
		// tree whose checked-out state does not (yet) contain the candidate
		// configuration -- e.g. bootstrapping from a pre-EF checkout. An
		// explicit `--project` only needs to be the exact Git worktree root;
		// authoritative configuration comes from the supplied commit(s)
		// below (`peekConfigAt`), never from this working tree.
		const resolved = await resolveCommitBoundProject({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
		if (!resolved.ok) {
			const code = resolved.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
			return earlyFailure(options, code, resolved.message)
		}
		root = resolved.context.root
		git = resolved.context.git
		config = null
	}
	else {
		const resolved = await resolveProject({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
		if (!resolved.ok) {
			const code = resolved.reason === 'incomplete-initialization'
				? 'EF-VAL-012'
				: resolved.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
			return earlyFailure(options, code, resolved.message)
		}
		root = resolved.context.root
		config = resolved.context.config
		git = resolved.context.git
	}

	// ---- Scope-specific validation ------------------------------------------

	if (options.scope === 'snapshot') {
		const loaded = await loadSnapshotFromWorkingTree(root)
		if (!loaded.ok) {
			const code = loaded.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
			return earlyFailure(options, code, loaded.message)
		}

		const validation = validateSnapshot(loaded.snapshot)
		let diagnostics = validation.diagnostics
		let complete = validation.complete

		if (options.workspace) {
			const linked = config?.linkedRepositories ?? []
			const workspaceResult = await applyWorkspaceChecks(root, deps.executor, linked)
			diagnostics = [...diagnostics, ...workspaceResult.diagnostics]
			complete = complete && workspaceResult.complete
		}

		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics,
			complete,
			policy: policyFrom(options),
			refs: { integrationRef: config?.repository.integrationRef ?? null },
		})
		return outcomeFor(options.format, options.noColor, options.workspace, summary, diagnostics)
	}

	if (options.scope === 'transition') {
		const baselineResolved = await git.resolveCommit(options.baseline!)
		const baselineConfig = baselineResolved.kind === 'resolved' ? await peekConfigAt(git, baselineResolved.oid) : undefined
		const operationStartRefOid = baselineConfig ? await resolveRefOidOrNull(git, baselineConfig.repository.integrationRef) : null

		const result = await validateTransition({
			git,
			baselineOid: options.baseline!,
			proposedOid: options.proposed!,
			operationStartRefOid,
			policy: policyFrom(options),
		})

		let diagnostics = result.diagnostics
		let complete = result.complete

		if (options.workspace && result.proposedOid) {
			const proposedConfig = await peekConfigAt(git, result.proposedOid)
			const linked = proposedConfig?.linkedRepositories ?? []
			const workspaceResult = await applyWorkspaceChecks(root, deps.executor, linked)
			diagnostics = [...diagnostics, ...workspaceResult.diagnostics]
			complete = complete && workspaceResult.complete
		}

		const summary = summarizeValidation({
			scope: 'transition',
			diagnostics,
			complete,
			policy: policyFrom(options),
			refs: {
				baselineOid: result.baselineOid,
				proposedOid: result.proposedOid,
				integrationRef: result.integrationRef,
				expectedRefOid: result.expectedRefOid,
			},
		})
		return outcomeFor(options.format, options.noColor, options.workspace, summary, diagnostics)
	}

	// ---- bootstrap ------------------------------------------------------------

	const proposedResolved = await git.resolveCommit(options.proposed!)
	const proposedConfig = proposedResolved.kind === 'resolved' ? await peekConfigAt(git, proposedResolved.oid) : undefined
	const operationStartRefState: OperationStartRefState = proposedConfig
		? await resolveRefStateOrUnresolved(git, proposedConfig.repository.integrationRef)
		: { resolved: false }

	const result = await validateBootstrap({
		git,
		proposedOid: options.proposed!,
		operationStartRefState,
		policy: policyFrom(options),
	})

	let diagnostics = result.diagnostics
	let complete = result.complete

	if (options.workspace) {
		const linked = proposedConfig?.linkedRepositories ?? []
		const workspaceResult = await applyWorkspaceChecks(root, deps.executor, linked)
		diagnostics = [...diagnostics, ...workspaceResult.diagnostics]
		complete = complete && workspaceResult.complete
	}

	const summary = summarizeValidation({
		scope: 'bootstrap',
		diagnostics,
		complete,
		policy: policyFrom(options),
		refs: {
			proposedOid: result.proposedOid,
			integrationRef: result.integrationRef,
			expectedRefOid: result.expectedRefOid,
		},
	})
	return outcomeFor(options.format, options.noColor, options.workspace, summary, diagnostics)
}

async function resolveRefOidOrNull(git: GitRepository, ref: string): Promise<string | null> {
	const result = await git.resolveRef(ref)
	return result.kind === 'resolved' ? result.oid : null
}

async function resolveRefStateOrUnresolved(git: GitRepository, ref: string): Promise<OperationStartRefState> {
	const result = await git.resolveRef(ref)
	return result.kind === 'resolved' ? { resolved: true, oid: result.oid } : { resolved: false }
}
