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
import type { OperationStartRefOid } from '../../application/transition-validation'
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

/**
 * `peekConfigAt`'s result: a Git read failure while probing the commit's
 * configuration is neither a proven "no config here" (`absent`) nor a loaded
 * `found` config -- collapsing it into the same shape as a genuine absence
 * previously let a transient or first-observation `readTree`/`readBlob`
 * failure silently proceed as though the commit's config had never existed,
 * skipping the ref-state probe this peek exists to feed
 * (09-validation.md "An inaccessible ref ... makes the operation incomplete
 * rather than eligible by assumption" applies equally to the read that
 * establishes which ref to probe).
 */
type ConfigPeekOutcome
	= | { kind: 'found', config: Config }
		| { kind: 'absent' }
		| { kind: 'error', message: string }

async function peekConfigAt(git: GitRepository, commitOid: string): Promise<ConfigPeekOutcome> {
	const tree = await git.readTree(commitOid)
	// `git-unavailable` (the executor could not run/observe the command) and
	// `error` (the commit was already proven to exist but the tree read then
	// failed unexpectedly) are both execution/read failures, never a proof of
	// absence -- both must surface as `error`, not be folded into `absent`
	// alongside a genuine `missing` commit.
	if (tree.kind === 'git-unavailable' || tree.kind === 'error')
		return { kind: 'error', message: tree.message }
	if (tree.kind !== 'resolved')
		return { kind: 'absent' }
	const entry = tree.entries.find(e => e.path === '.engineering/ef.yaml' && e.type === 'blob')
	if (!entry)
		return { kind: 'absent' }
	const blob = await git.readBlob(entry.oid)
	// Same reasoning as the tree read above: a blob already proven to exist
	// as a tree entry whose content read then fails unexpectedly must not be
	// treated the same as the file simply never existing.
	if (blob.kind === 'git-unavailable' || blob.kind === 'error')
		return { kind: 'error', message: blob.message }
	if (blob.kind !== 'resolved')
		return { kind: 'absent' }
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(blob.bytes)
	const config = decodeConfig(text, '.engineering/ef.yaml').config
	return config ? { kind: 'found', config } : { kind: 'absent' }
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
		let operationStartRefOid: OperationStartRefOid = null
		if (baselineResolved.kind === 'resolved') {
			const baselinePeek = await peekConfigAt(git, baselineResolved.oid)
			if (baselinePeek.kind === 'error')
				return earlyFailure(options, 'EF-VAL-006', `Git is unavailable while reading the trusted baseline's configuration: ${baselinePeek.message}`)
			if (baselinePeek.kind === 'found')
				operationStartRefOid = await resolveRefOidOrNull(git, baselinePeek.config.repository.integrationRef)
		}

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
			const proposedPeek = await peekConfigAt(git, result.proposedOid)
			if (proposedPeek.kind === 'error') {
				diagnostics = [...diagnostics, { code: 'EF-VAL-006', severity: severityOf('EF-VAL-006'), message: `Git is unavailable while reading the proposed commit's configuration for workspace validation: ${proposedPeek.message}`, related: [] }]
				complete = false
			}
			else {
				const linked = proposedPeek.kind === 'found' ? proposedPeek.config.linkedRepositories : []
				const workspaceResult = await applyWorkspaceChecks(root, deps.executor, linked)
				diagnostics = [...diagnostics, ...workspaceResult.diagnostics]
				complete = complete && workspaceResult.complete
			}
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
	let operationStartRefState: OperationStartRefState = { resolved: false }
	let proposedConfig: Config | undefined
	if (proposedResolved.kind === 'resolved') {
		const proposedPeek = await peekConfigAt(git, proposedResolved.oid)
		if (proposedPeek.kind === 'error')
			return earlyFailure(options, 'EF-VAL-006', `Git is unavailable while reading the proposed bootstrap commit's configuration: ${proposedPeek.message}`)
		if (proposedPeek.kind === 'found') {
			proposedConfig = proposedPeek.config
			operationStartRefState = await resolveRefStateOrUnresolved(git, proposedPeek.config.repository.integrationRef)
		}
	}

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

/**
 * Threads {@link GitRepository.resolveRef}'s outcome into `validateTransition`'s
 * `OperationStartRefOid` input without collapsing its `'error'`/`'git-unavailable'`
 * kinds into a bare `null`: a failed probe is neither a proven resolution nor a
 * proven absence, and folding it into `null` here would make `validateTransition`
 * misreport a genuine Git failure as an ordinary ref mismatch (`EF-VAL-002`)
 * instead of the probe failure itself (`EF-VAL-006`, applied by
 * `validateTransition` itself once this distinct shape reaches it;
 * 09-validation.md "An inaccessible ref ... makes the operation incomplete
 * rather than eligible by assumption").
 */
async function resolveRefOidOrNull(git: GitRepository, ref: string): Promise<OperationStartRefOid> {
	const result = await git.resolveRef(ref)
	switch (result.kind) {
		case 'resolved':
			return result.oid
		case 'proven-absent':
			return null
		case 'error':
		case 'git-unavailable':
			return { kind: 'ref-probe-error', message: result.message }
	}
}

/**
 * Same distinction as {@link resolveRefOidOrNull}, threaded into
 * `validateBootstrap`'s `OperationStartRefState` input instead: folding a probe
 * failure into `{ resolved: false }` previously let bootstrap validation
 * proceed as though the ref simply had not resolved yet, silently skipping the
 * required "no prior EF state" history check rather than reporting the probe
 * failure (`EF-VAL-006`, applied by `validateBootstrap` itself).
 */
async function resolveRefStateOrUnresolved(git: GitRepository, ref: string): Promise<OperationStartRefState> {
	const result = await git.resolveRef(ref)
	switch (result.kind) {
		case 'resolved':
			return { resolved: true, oid: result.oid }
		case 'proven-absent':
			return { resolved: false }
		case 'error':
		case 'git-unavailable':
			return { resolved: 'error', message: result.message }
	}
}
