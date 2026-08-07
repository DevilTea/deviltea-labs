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
import type { validateSnapshot, ValidationPolicy } from '../../application/snapshot-validation'
import type { OperationStartRefOid } from '../../application/transition-validation'
import type { GitExecutor } from '../../git/executor'
import type { GitRepository } from '../../git/repository'
import type { Config } from '../../repository/config'
import type { CommandOutcome } from '../command-outcome'
import type { LoadWorkingTreeContextResult } from '../working-tree-context'
import { validateBootstrap } from '../../application/bootstrap-validation'
import { summarizeValidation } from '../../application/snapshot-validation'
import { validateTransition } from '../../application/transition-validation'
import { severityOf } from '../../domain/diagnostic-codes'
import { REGULAR_FILE_GIT_MODES } from '../../git/repository'
import { decodeConfig } from '../../repository/config'
import { validateWorkspace } from '../../repository/workspace'
import { buildValidationResultJson } from '../envelopes'
import { renderValidationHuman } from '../human-render'
import { resolveCommitBoundProject, resolveProject } from '../project-context'
import { loadWorkingTreeContext } from '../working-tree-context'
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
 *
 * Finding 5: `untrusted` covers a tree entry existing at exactly
 * `.engineering/ef.yaml` whose Git mode/type is not an ordinary regular file
 * -- a symlink (`120000`, reported by `ls-tree` as `type: 'blob'` exactly
 * like an ordinary file), a gitlink/submodule (`160000`, `type: 'commit'`),
 * or a tree (a directory literally named `ef.yaml`). None of these is a
 * genuine absence (something IS committed at that exact path) and none is
 * safe to read as configuration bytes (a symlink's "content" is its target
 * TEXT, which could name an attacker-chosen `integration_ref` without ever
 * being the project's real configuration). This is distinct from both
 * `found` and `absent` so a caller cannot silently fall back to either.
 */
type ConfigPeekOutcome
	= | { kind: 'found', config: Config }
		| { kind: 'absent' }
		| { kind: 'untrusted', mode: string }
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
	// Matched by path alone (not also `type === 'blob'`, Finding 5): a tree
	// (directory) or gitlink entry at this exact path must be classified as
	// `untrusted` below, not silently treated as `absent` merely because it
	// fails a `type === 'blob'` filter.
	const entry = tree.entries.find(e => e.path === '.engineering/ef.yaml')
	if (!entry)
		return { kind: 'absent' }
	if (entry.type !== 'blob' || !REGULAR_FILE_GIT_MODES.has(entry.mode))
		return { kind: 'untrusted', mode: entry.mode }
	const blob = await git.readBlob(entry.oid)
	// Same reasoning as the tree read above: a blob already proven to exist
	// as a tree entry whose content read then fails unexpectedly must not be
	// treated the same as the file simply never existing.
	if (blob.kind === 'git-unavailable' || blob.kind === 'error')
		return { kind: 'error', message: blob.message }
	if (blob.kind !== 'resolved') {
		// `blob.kind` is `missing` or `not-a-blob`: `entry` was already proven
		// to exist as a blob-type tree entry, so this is read corruption on an
		// object already known to exist, never a legitimate absence. Folding it
		// into `absent` would let validation proceed as though the baseline or
		// proposed commit simply had no `ef.yaml`, silently skipping the
		// ref-state probe this peek exists to feed.
		const detail = blob.kind === 'not-a-blob' ? `not a blob (actual type '${blob.actualType}')` : 'missing'
		return { kind: 'error', message: `'.engineering/ef.yaml' was listed in the tree as blob '${entry.oid}' but reading it reported it ${detail}.` }
	}
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

/**
 * Maps a `loadWorkingTreeContext` failure to snapshot scope's diagnostic
 * code, preserving each stage's existing identity (Finding 10): the
 * association-recheck failure (`stage: 'association'`) uses the SAME
 * generic invocation/resolution class `resolveProject`'s own
 * `'unassociated'` reason already maps to below (`EF-VAL-001`), never
 * `EF-VAL-012` -- that code is registry-owned by "an incomplete working-tree
 * initialization claim exists," a condition association re-checking never
 * establishes (association can fail against a project whose initialization
 * is perfectly complete).
 */
function workingTreeContextFailureCode(failure: Exclude<LoadWorkingTreeContextResult, { ok: true }>): 'EF-VAL-001' | 'EF-VAL-006' | 'EF-VAL-012' {
	switch (failure.stage) {
		case 'resolve':
			return failure.reason === 'incomplete-initialization'
				? 'EF-VAL-012'
				: failure.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
		case 'load':
		case 'association':
			return failure.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-001'
	}
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

	// ---- Snapshot scope: single, shared working-tree resolution -------------
	// ---- (13-cli-contract.md "Common Options"; consolidated per Findings ----
	// ---- 9-10, eighth round) --------------------------------------------------

	if (options.scope === 'snapshot') {
		// `loadWorkingTreeContext` (Findings 3-5, 9-10, consolidated): resolves
		// the project, loads its snapshot bound to discovery's own
		// `.engineering` identity observation (Finding 4), and -- for implicit
		// discovery only (an explicit `--project` is exempt per
		// 11-filesystem-and-config.md "Project Discovery") -- re-checks
		// working-directory association against the snapshot's own freshest
		// configuration (Finding 5), never against project resolution's
		// separate, earlier read (Finding 3).
		const loaded = await loadWorkingTreeContext({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
		if (!loaded.ok)
			return earlyFailure(options, workingTreeContextFailureCode(loaded), loaded.message)

		const { root, validation, config } = loaded.context
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

	// ---- Transition/bootstrap project resolution (11-filesystem-and-config.md
	// ---- "Project Discovery" commit-bound exception) ------------------------
	//
	// Neither scope loads a working-tree snapshot at all: authoritative
	// configuration comes from the relevant trusted commit(s) via
	// `peekConfigAt` below, never from this working tree, so
	// `loadWorkingTreeContext`'s snapshot-loading/association-recheck
	// machinery does not apply here.

	let root: string
	let git: GitRepository

	if (options.project !== undefined) {
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
		git = resolved.context.git
	}

	if (options.scope === 'transition') {
		const baselineResolved = await git.resolveCommit(options.baseline!)
		let operationStartRefOid: OperationStartRefOid = null
		if (baselineResolved.kind === 'resolved') {
			const baselinePeek = await peekConfigAt(git, baselineResolved.oid)
			if (baselinePeek.kind === 'error')
				return earlyFailure(options, 'EF-VAL-006', `Git is unavailable while reading the trusted baseline's configuration: ${baselinePeek.message}`)
			if (baselinePeek.kind === 'untrusted') {
				return earlyFailure(options, 'EF-VAL-006', `The trusted baseline's '.engineering/ef.yaml' is not a regular file (Git mode '${baselinePeek.mode}') and cannot be used to establish operation-start ref state.`)
			}
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
			if (proposedPeek.kind === 'error' || proposedPeek.kind === 'untrusted') {
				// Finding 5: `untrusted` (a non-regular-file `ef.yaml`, e.g. a
				// symlink) is folded in here alongside `error` -- NOT into the
				// `else` branch's `proposedPeek.kind === 'found' ? ... : []`,
				// which would silently treat it exactly like a genuine `absent`
				// and proceed with an empty linked-repositories list computed
				// from an untrustworthy observation.
				const detail = proposedPeek.kind === 'error'
					? proposedPeek.message
					: `'.engineering/ef.yaml' is not a regular file (Git mode '${proposedPeek.mode}')`
				diagnostics = [...diagnostics, { code: 'EF-VAL-006', severity: severityOf('EF-VAL-006'), message: `Git is unavailable while reading the proposed commit's configuration for workspace validation: ${detail}`, related: [] }]
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
		if (proposedPeek.kind === 'untrusted') {
			return earlyFailure(options, 'EF-VAL-006', `The proposed bootstrap commit's '.engineering/ef.yaml' is not a regular file (Git mode '${proposedPeek.mode}') and cannot be used to establish operation-start ref state.`)
		}
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
