/**
 * Range validation (09-validation.md "Range scope"; 07-change-transactions.md
 * "Atomicity and Git commits": "A fast-forward containing multiple new
 * first-parent commits is valid only when each adjacent commit is
 * independently valid and transition-validated"; 11-filesystem-and-config.md
 * "Trusted transition baseline" and its range-baseline counterpart).
 *
 * `validateRange` proves an entire pre-publication integration range --
 * everything strictly after a trusted range baseline through one explicit
 * proposed commit, inclusive -- deterministically from Git objects plus one
 * captured operation-start ref state, with zero ref mutation, no checkout,
 * and no working-tree materialization.
 *
 * A commit's EF state is identified by the `(mode, type, oid)` triple of its
 * `.engineering` tree entry (or its absence). Walking the validated
 * first-parent sequence oldest-first from the baseline state, every commit's
 * incoming boundary is classified as IDENTITY (trivially valid, no
 * materialization or diagnostic), BOOTSTRAP (absent -> present, validated
 * exactly like `bootstrap-validation.ts`'s own rules), TRANSITION (present ->
 * distinct present, validated by reusing `transition-validation.ts`'s pure
 * `evaluateTransitionBoundary` core -- the SAME graph-wide comparison
 * `query-history.ts` already reuses for its own first-parent walk), or
 * EF-STATE REMOVAL (present -> absent, `EF-VAL-013`, which stops the walk).
 * This makes the boundary set this module evaluates IDENTICAL to the set
 * `ef query history`'s first-parent walk later consumes: a range that
 * validates as complete and valid cannot later be reported as untrusted
 * authoritative history by that walk over the same published commits.
 *
 * The walk reports the findings of the FIRST state or boundary that produces
 * an error-severity diagnostic and then stops (09-validation.md "Walk
 * termination"); later states and boundaries are blocked dependent checks
 * and produce no diagnostics. Warning-severity findings never stop the walk,
 * including under strict or warnings-as-errors policy.
 *
 * Every BOOTSTRAP boundary reuses `bootstrap-validation.ts`'s own pure
 * `evaluateBootstrapStateRules` core for the bootstrap-only state rules, the
 * same way it reuses `transition-validation.ts`'s pure
 * `evaluateTransitionBoundary` core for every ordinary TRANSITION boundary:
 * both are the SAME shared, graph-wide rule cores `query-history.ts` and the
 * dedicated scope orchestrators already depend on, not a hand-maintained
 * duplicate scoped only to this module's own walk.
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { OperationStartRefState } from './bootstrap-validation'
import type { LoadSnapshotFailureReason, ProjectSnapshot } from './snapshot'
import type { SnapshotValidationResult, ValidationPolicy, ValidationSummary } from './snapshot-validation'
import type { TransitionBoundarySide } from './transition-validation'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { evaluateBootstrapStateRules } from './bootstrap-validation'
import { loadSnapshotFromCommit } from './snapshot'
import { summarizeValidation, validateSnapshot } from './snapshot-validation'
import { evaluateTransitionBoundary } from './transition-validation'

const EF_YAML_PATH = '.engineering/ef.yaml'
const ENGINEERING_PATH = '.engineering'

const DEFAULT_POLICY: ValidationPolicy = { strict: false, warningsAsErrors: false }

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: { path?: string, artifactId?: string, field?: string, commitOid?: string } = {},
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		artifactId: options.artifactId,
		field: options.field,
		commitOid: options.commitOid,
		related: [],
	}
}

function withCommitOid(diagnostics: readonly Diagnostic[], commitOid: string): Diagnostic[] {
	return diagnostics.map(d => ({ ...d, commitOid }))
}

function hasErrorSeverity(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === 'error')
}

// ---------------------------------------------------------------------------
// Materialization (mirrors `transition-validation.ts`'s private `materialize`)
// ---------------------------------------------------------------------------

interface MaterializedCommit {
	snapshot: ProjectSnapshot
	validation: SnapshotValidationResult
	/** Project-relative path -> blob OID, for every blob entry beneath `.engineering` (config, gitignore, and every local Resource file). */
	oidByPath: ReadonlyMap<string, string>
}

type MaterializeFailureReason = 'unresolvable' | 'git-unavailable' | LoadSnapshotFailureReason

interface MaterializeFailure {
	ok: false
	reason: MaterializeFailureReason
	message: string
}

type MaterializeResult = { ok: true, commit: MaterializedCommit } | MaterializeFailure

async function materialize(git: GitRepository, commitOid: string): Promise<MaterializeResult> {
	const treeResult = await git.readTree(commitOid)
	if (treeResult.kind === 'git-unavailable')
		return { ok: false, reason: 'git-unavailable', message: treeResult.message }
	if (treeResult.kind !== 'resolved') {
		const message = treeResult.kind === 'missing'
			? `Commit '${commitOid}' could not be materialized.`
			: `Commit '${commitOid}' tree could not be read: ${treeResult.message}`
		return { ok: false, reason: 'unresolvable', message }
	}

	const oidByPath = new Map<string, string>()
	for (const entry of treeResult.entries) {
		if (entry.type === 'blob')
			oidByPath.set(entry.path, entry.oid)
	}

	const loadResult = await loadSnapshotFromCommit(git, commitOid)
	if (!loadResult.ok)
		return { ok: false, reason: loadResult.reason, message: loadResult.message }

	const validation = validateSnapshot(loadResult.snapshot)
	return { ok: true, commit: { snapshot: loadResult.snapshot, validation, oidByPath } }
}

/** Memoizes {@link materialize} per commit OID so a commit consulted for both ref derivation and its own boundary (or consulted more than once for any other reason) is only ever read from Git once. */
function materializeCache(git: GitRepository): (oid: string) => Promise<MaterializeResult> {
	const cache = new Map<string, Promise<MaterializeResult>>()
	return (oid: string) => {
		let pending = cache.get(oid)
		if (!pending) {
			pending = materialize(git, oid)
			cache.set(oid, pending)
		}
		return pending
	}
}

function toBoundarySide(commit: MaterializedCommit): TransitionBoundarySide {
	return { snapshot: commit.snapshot, validation: commit.validation, oidByPath: commit.oidByPath }
}

// ---------------------------------------------------------------------------
// EF-state identity (09-validation.md "EF state identity and boundary classification")
// ---------------------------------------------------------------------------

interface EfTriple {
	mode: string
	type: string
	oid: string
}

function tripleOf(entry: GitTreeEntry): EfTriple {
	return { mode: entry.mode, type: entry.type, oid: entry.oid }
}

function triplesEqual(a: EfTriple | null, b: EfTriple | null): boolean {
	if (a === null || b === null)
		return a === b
	return a.mode === b.mode && a.type === b.type && a.oid === b.oid
}

// ---------------------------------------------------------------------------
// validateRange
// ---------------------------------------------------------------------------

export interface ValidateRangeInput {
	git: GitRepository
	/** Full commit OID of the trusted range baseline, or `null` to assert `integration_ref` was proven unresolved at operation start (11-filesystem-and-config.md's range-baseline counterpart). */
	baselineOid: string | null
	/** Full commit OID of the explicit proposed (range-end) commit. */
	proposedOid: string
	/**
	 * The exact ref NAME whose operation-start state was captured, when the
	 * caller has one on hand. The authoritative `integration_ref` this module
	 * independently derives MUST equal it; a mismatch is `EF-VAL-002`
	 * (09-validation.md "Ref selection, capture, and staleness").
	 */
	operationStartRef?: string
	operationStartRefState: OperationStartRefState
	policy?: ValidationPolicy
}

export type RangeValidationResult = ValidationSummary & { diagnostics: Diagnostic[] }

interface RangeRefs {
	baselineOid?: string | null
	proposedOid?: string | null
	integrationRef?: string | null
	expectedRefOid?: string | null
}

function incompleteResult(diagnostics: Diagnostic[], policy: ValidationPolicy, refs?: RangeRefs): RangeValidationResult {
	const summary = summarizeValidation({ scope: 'range', diagnostics, complete: false, policy, refs })
	return { ...summary, diagnostics: aggregateDiagnostics(diagnostics) }
}

function completeResult(diagnostics: Diagnostic[], policy: ValidationPolicy, refs?: RangeRefs): RangeValidationResult {
	const summary = summarizeValidation({ scope: 'range', diagnostics, complete: true, policy, refs })
	return { ...summary, diagnostics: aggregateDiagnostics(diagnostics) }
}

/**
 * Validates the operation-start state of `integration_ref` against the
 * expected OID (the trusted range baseline OID, or `null` when the caller
 * asserted the ref was proven unresolved). A probe failure is `EF-VAL-006`
 * and MUST NOT be folded into proven absence; any other mismatch (including
 * an OID that differs, or a ref that unexpectedly did/did not resolve) is
 * `EF-VAL-002` (09-validation.md "A complete range result requires the
 * captured operation-start OID to equal the trusted range baseline OID").
 */
function checkOperationStartRefState(
	state: OperationStartRefState,
	expectedOid: string | null,
	integrationRef: string,
): { ok: true, expectedRefOid: string | null } | { ok: false, code: 'EF-VAL-002' | 'EF-VAL-006', message: string, expectedRefOid: string | null } {
	if (state.resolved === 'error') {
		return { ok: false, code: 'EF-VAL-006', message: `Git is unavailable while resolving the integration ref '${integrationRef}' at the start of the operation: ${state.message}`, expectedRefOid: null }
	}
	const actualOid = state.resolved === true ? state.oid : null
	if (actualOid !== expectedOid) {
		return {
			ok: false,
			code: 'EF-VAL-002',
			message: `Integration ref '${integrationRef}' resolved to '${actualOid ?? 'nothing'}' when the operation began, not the trusted range baseline '${expectedOid ?? 'nothing (asserted unresolved)'}'.`,
			expectedRefOid: actualOid,
		}
	}
	return { ok: true, expectedRefOid: actualOid }
}

export async function validateRange(input: ValidateRangeInput): Promise<RangeValidationResult> {
	const { git, baselineOid, proposedOid, operationStartRef, operationStartRefState } = input
	const policy = input.policy ?? DEFAULT_POLICY
	const getCommit = materializeCache(git)

	// ---- Resolve the explicit proposed commit --------------------------------

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

	// ---- Resolve the trusted range baseline, when supplied -------------------

	let resolvedBaselineOid: string | null = null
	if (baselineOid !== null) {
		const baselineResolved = await git.resolveCommit(baselineOid)
		if (baselineResolved.kind === 'git-unavailable') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', `Git is unavailable while resolving the trusted range baseline: ${baselineResolved.message}`),
			], policy, { proposedOid: resolvedProposedOid })
		}
		if (baselineResolved.kind !== 'resolved') {
			const message = baselineResolved.kind === 'malformed'
				? `Baseline '${baselineOid}' is not a full commit OID for this repository's object format.`
				: baselineResolved.kind === 'missing'
					? `Baseline '${baselineOid}' does not resolve to any object.`
					: `Baseline '${baselineOid}' resolves to a ${baselineResolved.actualType}, not a commit.`
			return incompleteResult([makeDiagnostic('EF-VAL-002', message)], policy, { proposedOid: resolvedProposedOid })
		}
		resolvedBaselineOid = baselineResolved.oid
	}

	// ---- Validated commit sequence (ancestry) --------------------------------

	const rangeResult = await git.listFirstParentRange(resolvedBaselineOid, resolvedProposedOid)
	if (rangeResult.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while determining the validated commit sequence: ${rangeResult.message}`),
		], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
	}
	if (rangeResult.kind === 'unresolved') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-007', `The first-parent commit sequence for '${resolvedProposedOid}' could not be resolved.`),
		], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
	}
	if (rangeResult.kind === 'truncated') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-007', `The first-parent history between '${resolvedBaselineOid ?? 'a root commit'}' and '${resolvedProposedOid}' is incomplete (a shallow boundary or an unreadable object was reached before membership could be decided).`),
		], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
	}
	if (rangeResult.kind === 'not-an-ancestor') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-011', `Trusted range baseline '${resolvedBaselineOid ?? 'null'}' is not a first-parent ancestor of proposed commit '${resolvedProposedOid}'.`),
		], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
	}
	const oids = rangeResult.oids

	// ---- Baseline EF state ----------------------------------------------------

	let previousTriple: EfTriple | null = null
	let previousSide: TransitionBoundarySide | undefined
	let previousOid: string | undefined
	let authoritativeIntegrationRef: string | undefined
	let expectedRefOid: string | null = null

	if (resolvedBaselineOid !== null) {
		const baselineEntry = await git.readPathEntry(resolvedBaselineOid, ENGINEERING_PATH)
		if (baselineEntry.kind === 'git-unavailable') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', `Git is unavailable while reading the trusted range baseline's EF state: ${baselineEntry.message}`),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
		}
		if (baselineEntry.kind === 'missing' || baselineEntry.kind === 'error') {
			const detail = baselineEntry.kind === 'error' ? baselineEntry.message : 'the commit could not be re-read after already being resolved'
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', `Git is unavailable while reading the trusted range baseline's EF state: ${detail}`),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
		}

		if (baselineEntry.kind === 'resolved') {
			previousTriple = tripleOf(baselineEntry.entry)

			const baselineMaterialized = await getCommit(resolvedBaselineOid)
			if (!baselineMaterialized.ok) {
				if (baselineMaterialized.reason === 'git-unavailable') {
					return incompleteResult([
						makeDiagnostic('EF-VAL-006', `Git is unavailable while materializing the trusted range baseline: ${baselineMaterialized.message}`),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
				}
				return incompleteResult([
					makeDiagnostic('EF-VAL-002', `Trusted range baseline '${resolvedBaselineOid}' could not be materialized: ${baselineMaterialized.message}`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
			}
			if (hasErrorSeverity(baselineMaterialized.commit.validation.diagnostics)) {
				return incompleteResult([
					...baselineMaterialized.commit.validation.diagnostics,
					makeDiagnostic('EF-VAL-002', `Trusted range baseline '${resolvedBaselineOid}' does not contain a valid authoritative EF snapshot.`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
			}
			const baselineConfig = baselineMaterialized.commit.snapshot.config.config
			if (!baselineConfig) {
				return incompleteResult([
					makeDiagnostic('EF-VAL-002', `Trusted range baseline '${resolvedBaselineOid}' does not name a valid 'integration_ref'.`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
			}
			authoritativeIntegrationRef = baselineConfig.repository.integrationRef
			previousSide = toBoundarySide(baselineMaterialized.commit)
			previousOid = resolvedBaselineOid

			if (operationStartRef !== undefined && operationStartRef !== authoritativeIntegrationRef) {
				return incompleteResult([
					makeDiagnostic('EF-VAL-002', `Captured operation-start ref '${operationStartRef}' does not name the authoritative integration ref '${authoritativeIntegrationRef}'.`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef })
			}
			const refCheck = checkOperationStartRefState(operationStartRefState, resolvedBaselineOid, authoritativeIntegrationRef)
			if (!refCheck.ok) {
				return incompleteResult([
					makeDiagnostic(refCheck.code, refCheck.message),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid: refCheck.expectedRefOid })
			}
			expectedRefOid = refCheck.expectedRefOid
		}
		// `baselineEntry.kind === 'absent'`: the trusted range baseline is
		// pre-EF. `previousTriple` stays `null`; `authoritativeIntegrationRef`
		// is derived lazily from the proposed commit's configuration the first
		// time a bootstrap boundary is found below.
	}

	// ---- Walk the validated commit sequence, oldest-first --------------------

	const accumulated: Diagnostic[] = []
	let sawPresentState = previousTriple !== null

	for (const oid of oids) {
		const entryResult = await git.readPathEntry(oid, ENGINEERING_PATH)
		if (entryResult.kind === 'git-unavailable') {
			return incompleteResult([
				...accumulated,
				makeDiagnostic('EF-VAL-006', `Git is unavailable while reading commit '${oid}''s EF state: ${entryResult.message}`),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}
		if (entryResult.kind === 'missing' || entryResult.kind === 'error') {
			const detail = entryResult.kind === 'error' ? entryResult.message : 'the commit could not be re-read after already being resolved'
			return incompleteResult([
				...accumulated,
				makeDiagnostic('EF-VAL-006', `Git is unavailable while reading commit '${oid}''s EF state: ${detail}`),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}

		const currentTriple = entryResult.kind === 'resolved' ? tripleOf(entryResult.entry) : null

		if (triplesEqual(currentTriple, previousTriple)) {
			previousTriple = currentTriple
			continue
		}

		// ---- EF-state removal (present -> absent): EF-VAL-013, walk stops -----

		if (previousTriple !== null && currentTriple === null) {
			accumulated.push(makeDiagnostic('EF-VAL-013', `Commit '${oid}' removes the authoritative EF state.`, { commitOid: oid }))
			return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}

		// ---- Bootstrap boundary (absent -> present) ----------------------------

		if (previousTriple === null && currentTriple !== null) {
			sawPresentState = true
			const bootstrapMaterialized = await getCommit(oid)
			if (!bootstrapMaterialized.ok) {
				const code = bootstrapMaterialized.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-011'
				return incompleteResult([
					...accumulated,
					makeDiagnostic(code, `Commit '${oid}' could not be materialized: ${bootstrapMaterialized.message}`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
			}

			if (authoritativeIntegrationRef === undefined) {
				// The trusted range baseline was pre-EF (or omitted): the
				// authoritative ref is derived from the proposed commit's
				// configuration, exactly as bootstrap scope trusts the proposed
				// configuration (09-validation.md "Ref selection, capture, and
				// staleness").
				const proposedMaterialized = await getCommit(resolvedProposedOid)
				if (!proposedMaterialized.ok) {
					const code = proposedMaterialized.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-011'
					return incompleteResult([
						...accumulated,
						makeDiagnostic(code, `Proposed commit '${resolvedProposedOid}' could not be materialized: ${proposedMaterialized.message}`),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, expectedRefOid })
				}
				const proposedConfig = proposedMaterialized.commit.snapshot.config.config
				if (!proposedConfig) {
					return incompleteResult([
						...accumulated,
						makeDiagnostic('EF-VAL-007', `Proposed commit '${resolvedProposedOid}' does not name a valid 'integration_ref' to establish the authoritative ref for this range.`),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, expectedRefOid })
				}
				authoritativeIntegrationRef = proposedConfig.repository.integrationRef

				if (operationStartRef !== undefined && operationStartRef !== authoritativeIntegrationRef) {
					return incompleteResult([
						...accumulated,
						makeDiagnostic('EF-VAL-002', `Captured operation-start ref '${operationStartRef}' does not name the authoritative integration ref '${authoritativeIntegrationRef}'.`),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef })
				}
				const refCheck = checkOperationStartRefState(operationStartRefState, resolvedBaselineOid, authoritativeIntegrationRef)
				if (!refCheck.ok) {
					return incompleteResult([
						...accumulated,
						makeDiagnostic(refCheck.code, refCheck.message),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid: refCheck.expectedRefOid })
				}
				expectedRefOid = refCheck.expectedRefOid
			}

			const boundaryDiagnostics: Diagnostic[] = [...bootstrapMaterialized.commit.validation.diagnostics]

			const bootstrapConfig = bootstrapMaterialized.commit.snapshot.config.config
			if (bootstrapConfig && bootstrapConfig.repository.integrationRef !== authoritativeIntegrationRef) {
				return incompleteResult([
					...accumulated,
					...withCommitOid(boundaryDiagnostics, oid),
					makeDiagnostic('EF-VAL-002', `Commit '${oid}''s configuration's 'integration_ref' ('${bootstrapConfig.repository.integrationRef}') does not match the range's fixed 'integration_ref' ('${authoritativeIntegrationRef}').`, { commitOid: oid }),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}

			// ---- Bootstrap history condition (09-validation.md "Bootstrap exception") ----

			const firstParent = await git.getFirstParent(oid)
			if (firstParent.kind === 'git-unavailable') {
				return incompleteResult([
					...accumulated,
					makeDiagnostic('EF-VAL-006', `Git is unavailable while checking commit '${oid}''s parentage: ${firstParent.message}`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}
			if (firstParent.kind === 'resolved') {
				const historyCheck = await git.pathExistsInFirstParentHistory(firstParent.parentOid, EF_YAML_PATH)
				if (historyCheck.kind === 'git-unavailable') {
					return incompleteResult([
						...accumulated,
						makeDiagnostic('EF-VAL-006', `Git is unavailable while checking the bootstrap history condition for commit '${oid}': ${historyCheck.message}`),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
				}
				if (historyCheck.kind === 'unresolved' || historyCheck.kind === 'shallow') {
					return incompleteResult([
						...accumulated,
						makeDiagnostic('EF-VAL-007', `Commit '${oid}''s first-parent history cannot be completely inspected to establish the bootstrap history condition.`, { commitOid: oid }),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
				}
				if (historyCheck.kind === 'found') {
					accumulated.push(makeDiagnostic('EF-VAL-009', `Bootstrap ref '${authoritativeIntegrationRef}' already contains an EF state before commit '${oid}'; commit '${historyCheck.commitOid}' has '.engineering/ef.yaml'.`, { commitOid: oid }))
					return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
				}
			}
			else if (firstParent.kind === 'error') {
				return incompleteResult([
					...accumulated,
					makeDiagnostic('EF-VAL-007', `Commit '${oid}''s parentage could not be determined to establish the bootstrap history condition: ${firstParent.message}`, { commitOid: oid }),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}
			// `firstParent.kind === 'root-commit'`: the condition is vacuously
			// satisfied, no probe required.

			// ---- Bootstrap-only state rules (reuses bootstrap-validation.ts's evaluateBootstrapStateRules core) ----

			boundaryDiagnostics.push(...evaluateBootstrapStateRules(bootstrapMaterialized.commit.validation.byId))

			const taggedBoundaryDiagnostics = withCommitOid(boundaryDiagnostics, oid)
			accumulated.push(...taggedBoundaryDiagnostics)

			previousTriple = currentTriple
			previousSide = toBoundarySide(bootstrapMaterialized.commit)
			previousOid = oid

			if (hasErrorSeverity(taggedBoundaryDiagnostics))
				return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })

			continue
		}

		// ---- Ordinary transition boundary (present -> distinct present) -------

		const transitionMaterialized = await getCommit(oid)
		if (!transitionMaterialized.ok) {
			const code = transitionMaterialized.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-011'
			return incompleteResult([
				...accumulated,
				makeDiagnostic(code, `Commit '${oid}' could not be materialized: ${transitionMaterialized.message}`),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}

		const proposedSideConfig = transitionMaterialized.commit.snapshot.config.config
		if (proposedSideConfig && proposedSideConfig.repository.integrationRef !== authoritativeIntegrationRef) {
			return incompleteResult([
				...accumulated,
				...withCommitOid(transitionMaterialized.commit.validation.diagnostics, oid),
				makeDiagnostic('EF-VAL-002', `Commit '${oid}''s configuration's 'integration_ref' ('${proposedSideConfig.repository.integrationRef}') does not match the range's fixed 'integration_ref' ('${authoritativeIntegrationRef}').`, { commitOid: oid }),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}

		const currentSide = toBoundarySide(transitionMaterialized.commit)
		const boundaryDiagnostics: Diagnostic[] = [
			...transitionMaterialized.commit.validation.diagnostics,
			...evaluateTransitionBoundary({ before: previousSide!, after: currentSide, beforeOid: previousOid, afterOid: oid }),
		]
		const taggedBoundaryDiagnostics = withCommitOid(boundaryDiagnostics, oid)
		accumulated.push(...taggedBoundaryDiagnostics)

		previousTriple = currentTriple
		previousSide = currentSide
		previousOid = oid

		if (hasErrorSeverity(taggedBoundaryDiagnostics))
			return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
	}

	// ---- Walk completed without an error-severity boundary --------------------

	if (!sawPresentState) {
		// 09-validation.md "Ranges with no EF state": neither the trusted range
		// baseline nor any commit in the validated sequence has an
		// `.engineering` entry. No ref check is performed because no EF
		// publication occurs.
		accumulated.push(makeDiagnostic('EF-VAL-014', 'The validated integration range contains no EF state boundary.'))
		return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: null, expectedRefOid: null })
	}

	return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
}
