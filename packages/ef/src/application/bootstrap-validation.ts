/**
 * Bootstrap validation (09-validation.md "Bootstrap exception";
 * 11-filesystem-and-config.md "Bootstrap validation is the sole no-baseline
 * exception"; 07-change-transactions.md "The bootstrap exception applies only
 * to the first EF state").
 *
 * `validateBootstrap` materializes one explicit proposed commit (there is no
 * trusted baseline) and establishes the required bootstrap history condition:
 * the configured `integration_ref` either does not yet resolve, or resolves
 * only to commits whose first-parent history never contains
 * `.engineering/ef.yaml`. It then snapshot-validates the proposed tree
 * (reusing `validateSnapshot`) and applies the bootstrap-only state rules:
 * no terminal knowledge Artifact and no CHG Artifact may be present
 * (`EF-VAL-010`).
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { GitRepository } from '../git/repository'
import type { ValidationPolicy, ValidationSummary } from './snapshot-validation'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { loadSnapshotFromCommit } from './snapshot'
import { summarizeValidation, validateSnapshot } from './snapshot-validation'

const EF_YAML_PATH = '.engineering/ef.yaml'

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeDiagnostic(code: DiagnosticCode, message: string, options: { path?: string, artifactId?: string } = {}): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		artifactId: options.artifactId,
		related: [],
	}
}

// ---------------------------------------------------------------------------
// validateBootstrap
// ---------------------------------------------------------------------------

/**
 * The operation-start state of the candidate `integration_ref`: it was
 * PROVEN unresolved (`resolved: false`), it resolved to `oid`, or the probe
 * that was supposed to establish either fact failed (`resolved: 'error'`) --
 * distinct from `resolved: false` and MUST NOT be treated as though the ref
 * does not exist (09-validation.md "An inaccessible ref ... makes the
 * operation incomplete rather than eligible by assumption"). Mutable ref
 * state is an explicit caller-supplied input rather than re-resolved here
 * (09-validation.md "operation-start captured project-repository and
 * local-ref state").
 */
export type OperationStartRefState
	= | { resolved: true, oid: string }
		| { resolved: false }
		| { resolved: 'error', message: string }

export interface ValidateBootstrapInput {
	git: GitRepository
	/** Full commit OID of the explicit proposed bootstrap commit. */
	proposedOid: string
	operationStartRefState: OperationStartRefState
	policy?: ValidationPolicy
}

export type BootstrapValidationResult = ValidationSummary & { diagnostics: Diagnostic[] }

const DEFAULT_POLICY: ValidationPolicy = { strict: false, warningsAsErrors: false }

const KNOWLEDGE_TYPES = new Set(['prd', 'requirement', 'decision', 'policy'])

function incompleteResult(
	diagnostics: Diagnostic[],
	policy: ValidationPolicy,
	refs?: { proposedOid?: string | null, integrationRef?: string | null, expectedRefOid?: string | null },
): BootstrapValidationResult {
	const summary = summarizeValidation({ scope: 'bootstrap', diagnostics, complete: false, policy, refs })
	return { ...summary, diagnostics: aggregateDiagnostics(diagnostics) }
}

export async function validateBootstrap(input: ValidateBootstrapInput): Promise<BootstrapValidationResult> {
	const { git, proposedOid, operationStartRefState } = input
	const policy = input.policy ?? DEFAULT_POLICY
	const expectedRefOid = operationStartRefState.resolved === true ? operationStartRefState.oid : null

	// ---- Resolve and materialize the explicit proposed commit ---------------

	const proposedResolved = await git.resolveCommit(proposedOid)
	if (proposedResolved.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while resolving the proposed commit: ${proposedResolved.message}`),
		], policy)
	}
	if (proposedResolved.kind !== 'resolved') {
		const message = proposedResolved.kind === 'malformed'
			? `Proposed '${proposedOid}' is not a full commit OID for this repository's object format.`
			: proposedResolved.kind === 'missing'
				? `Proposed '${proposedOid}' does not resolve to any object.`
				: `Proposed '${proposedOid}' resolves to a ${proposedResolved.actualType}, not a commit.`
		return incompleteResult([makeDiagnostic('EF-VAL-011', message)], policy)
	}
	const resolvedProposedOid = proposedResolved.oid

	const loadResult = await loadSnapshotFromCommit(git, resolvedProposedOid)
	if (!loadResult.ok) {
		const code: DiagnosticCode = loadResult.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-011'
		return incompleteResult([
			makeDiagnostic(code, `Proposed commit '${resolvedProposedOid}' could not be materialized: ${loadResult.message}`),
		], policy, { proposedOid: resolvedProposedOid, expectedRefOid })
	}
	const snapshot = loadResult.snapshot
	const validation = validateSnapshot(snapshot)

	const config = snapshot.config.config
	if (!config) {
		return incompleteResult([
			...validation.diagnostics,
			makeDiagnostic('EF-VAL-007', `Proposed bootstrap commit '${resolvedProposedOid}' does not name a valid 'integration_ref' to establish the bootstrap history condition.`),
		], policy, { proposedOid: resolvedProposedOid, expectedRefOid })
	}
	const integrationRef = config.repository.integrationRef

	// ---- Operation-start ref probe failure -----------------------------------
	// A failed probe is neither a proven resolution nor a proven absence: it
	// MUST make bootstrap incomplete, never fall through and be treated as
	// though `integration_ref` does not exist.

	if (operationStartRefState.resolved === 'error') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while resolving the integration ref '${integrationRef}' at the start of the operation: ${operationStartRefState.message}`),
		], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid: null })
	}

	// ---- Establish the required bootstrap history condition -----------------
	// (09-validation.md "Bootstrap exception": the ref does not yet resolve, or
	// resolves and no commit in its first-parent history contains
	// `.engineering/ef.yaml`.)

	const historyCheck = operationStartRefState.resolved === true
		? await checkNoPriorEfState(git, operationStartRefState.oid)
		: undefined

	if (historyCheck?.kind === 'incomplete') {
		return incompleteResult([
			makeDiagnostic(historyCheck.code, historyCheck.message),
		], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid })
	}
	if (historyCheck?.kind === 'found') {
		return {
			...summarizeValidation({
				scope: 'bootstrap',
				diagnostics: [makeDiagnostic('EF-VAL-009', `Bootstrap ref '${integrationRef}' already contains an EF state; commit '${historyCheck.commitOid}' has '.engineering/ef.yaml'.`)],
				complete: true,
				policy,
				refs: { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid },
			}),
			diagnostics: [makeDiagnostic('EF-VAL-009', `Bootstrap ref '${integrationRef}' already contains an EF state; commit '${historyCheck.commitOid}' has '.engineering/ef.yaml'.`)],
		}
	}

	// ---- Proposed parentage (11-filesystem-and-config.md "Bootstrap validation") ----

	const firstParent = await git.getFirstParent(resolvedProposedOid)
	if (firstParent.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while checking proposed parentage: ${firstParent.message}`),
		], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid })
	}

	if (operationStartRefState.resolved === true) {
		if (firstParent.kind !== 'resolved' || firstParent.parentOid !== operationStartRefState.oid) {
			return incompleteResult([
				makeDiagnostic('EF-VAL-011', `Proposed bootstrap commit '${resolvedProposedOid}' does not use the captured ref tip '${operationStartRefState.oid}' as its first parent.`),
			], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid })
		}
	}
	else {
		if (firstParent.kind === 'missing' || firstParent.kind === 'not-a-commit') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-011', `Proposed bootstrap commit '${resolvedProposedOid}' has inapplicable parentage.`),
			], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid })
		}
		if (firstParent.kind === 'resolved') {
			const priorHistoryCheck = await checkNoPriorEfState(git, firstParent.parentOid)
			if (priorHistoryCheck.kind === 'incomplete') {
				return incompleteResult([
					makeDiagnostic(priorHistoryCheck.code, priorHistoryCheck.message),
				], policy, { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid })
			}
			if (priorHistoryCheck.kind === 'found') {
				const d = makeDiagnostic('EF-VAL-009', `Proposed bootstrap commit's first parent's history already contains an EF state; commit '${priorHistoryCheck.commitOid}' has '.engineering/ef.yaml'.`)
				return {
					...summarizeValidation({ scope: 'bootstrap', diagnostics: [d], complete: true, policy, refs: { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid } }),
					diagnostics: [d],
				}
			}
		}
		// 'root-commit': fine, no prior history to check.
	}

	// ---- Bootstrap state rules (09-validation.md "Bootstrap exception") -----

	const diagnostics: Diagnostic[] = [...validation.diagnostics]

	if (snapshot.gitignoreBytes === undefined) {
		diagnostics.push(makeDiagnostic('EF-VAL-010', `Bootstrap proposed tree is missing the required control file '.engineering/.gitignore'.`))
	}

	for (const record of validation.byId.values()) {
		if (record.type === 'change') {
			diagnostics.push(makeDiagnostic(
				'EF-VAL-010',
				`Bootstrap proposed tree contains a CHG Artifact '${record.id}', which is prohibited before the first EF state.`,
				{ path: record.path, artifactId: record.id },
			))
			continue
		}
		if (KNOWLEDGE_TYPES.has(record.type) && (record.status === 'superseded' || record.status === 'retired')) {
			diagnostics.push(makeDiagnostic(
				'EF-VAL-010',
				`Bootstrap proposed tree contains a terminal knowledge Artifact '${record.id}' (status '${record.status}'), which is prohibited before the first EF state.`,
				{ path: record.path, artifactId: record.id },
			))
		}
	}

	return {
		...summarizeValidation({
			scope: 'bootstrap',
			diagnostics,
			complete: true,
			policy,
			refs: { proposedOid: resolvedProposedOid, integrationRef, expectedRefOid },
		}),
		diagnostics: aggregateDiagnostics(diagnostics),
	}
}

// ---------------------------------------------------------------------------
// History-condition helper
// ---------------------------------------------------------------------------

type HistoryCheckResult
	= | { kind: 'not-found' }
		| { kind: 'found', commitOid: string }
		| { kind: 'incomplete', code: DiagnosticCode, message: string }

async function checkNoPriorEfState(git: GitRepository, startOid: string): Promise<HistoryCheckResult> {
	const result = await git.pathExistsInFirstParentHistory(startOid, EF_YAML_PATH)
	if (result.kind === 'git-unavailable')
		return { kind: 'incomplete', code: 'EF-VAL-006', message: `Git is unavailable while checking bootstrap history: ${result.message}` }
	if (result.kind === 'unresolved')
		return { kind: 'incomplete', code: 'EF-VAL-011', message: `Commit '${startOid}' could not be walked to establish the bootstrap history condition.` }
	if (result.kind === 'shallow') {
		return { kind: 'incomplete', code: 'EF-VAL-007', message: `Commit '${startOid}' is in a shallow repository; its first-parent history cannot be completely inspected to establish the bootstrap history condition.` }
	}
	if (result.kind === 'found')
		return { kind: 'found', commitOid: result.commitOid }
	return { kind: 'not-found' }
}
