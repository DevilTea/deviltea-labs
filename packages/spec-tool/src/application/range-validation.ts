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
 * The authoritative `integration_ref` is fixed by the trusted range
 * baseline's own configuration when the baseline's `.engineering` entry is
 * present, and otherwise by the range's BOOTSTRAP boundary's own
 * configuration -- the oldest commit in the validated sequence whose
 * `.engineering` entry is present. This module never reads a commit LATER in
 * the sequence than the boundary currently being evaluated to decide that
 * boundary's own outcome: doing so (e.g. consulting the proposed commit to
 * fix the ref) would let a later removal or a later malformed configuration
 * preempt an earlier boundary's own findings, which is exactly the property
 * that makes the oldest-first, first-error walk below total
 * (09-validation.md "Ref selection, capture, and staleness", "Walk
 * termination"). {@link findRangeIntegrationRefSource} is the ONE exported
 * definition of this same rule, consumed by the CLI to locate the ref name
 * before this module's own captured-ref-state probe; the two are independent
 * reads of the same immutable Git objects, and a disagreement between them
 * (only reachable through a failed or racing read) is caught by the
 * captured-ref-NAME cross-check (`EF-VAL-002`) or by the missing-capture
 * check (`EF-VAL-006`) below -- never silently accepted.
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
import type { FirstParentResult, GitRepository, GitTreeEntry, GitUnavailable } from '../git/repository'
import type { OperationStartRefState } from './bootstrap-validation'
import type { LoadSnapshotFailureReason, ProjectSnapshot } from './snapshot'
import type { SnapshotValidationResult, ValidationPolicy, ValidationSummary } from './snapshot-validation'
import type { TransitionBoundarySide } from './transition-validation'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { REGULAR_FILE_GIT_MODES } from '../git/repository'
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
// EF-state observation (single source for the `readPathEntry` -> tri-state
// mapping the baseline read and the walk's own per-commit read both need)
// ---------------------------------------------------------------------------

type EfStateObservation
	= | { kind: 'present', entry: GitTreeEntry }
		| { kind: 'absent' }
		/** A Git read failure -- `git-unavailable`, `missing` (contradicts an already-resolved commit), or `error` -- never proof of absence. */
		| { kind: 'blocked', message: string }

/**
 * Exhaustiveness guard mirroring {@link assertNeverFirstParent}: if a new
 * `PathEntryResult` variant is ever added without updating
 * {@link observeEfState}'s switch, `value` stops type-checking as `never` at
 * the `default` branch and the module fails to compile.
 */
function assertNeverPathEntry(value: never): never {
	throw new Error(`Unhandled PathEntryResult variant: ${JSON.stringify(value)}`)
}

/**
 * Reads `commitOid`'s `.engineering` tree entry and maps `readPathEntry`'s
 * five-variant result to the three-state {@link EfStateObservation} both the
 * trusted range baseline read and the walk's own per-commit read need.
 * `resolved`/`absent` are the only two variants a caller may treat as an
 * actual observation; `git-unavailable`, `missing`, and `error` are all Git
 * read failures on a path whose commit -- `commitOid` -- is otherwise already
 * known or assumed to be a valid commit, so none may ever be folded into
 * `absent` (the absolute Git trust rule this module and `peekConfigAt` both
 * hold).
 */
async function observeEfState(git: GitRepository, commitOid: string, subject: string): Promise<EfStateObservation> {
	const entry = await git.readPathEntry(commitOid, ENGINEERING_PATH)
	switch (entry.kind) {
		case 'resolved':
			return { kind: 'present', entry: entry.entry }
		case 'absent':
			return { kind: 'absent' }
		case 'git-unavailable':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: ${entry.message}` }
		case 'missing':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: the commit could not be re-read after already being resolved` }
		case 'error':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: ${entry.message}` }
		default:
			return assertNeverPathEntry(entry)
	}
}

// ---------------------------------------------------------------------------
// Configuration trust (mirrors the CLI's `peekConfigAt` in
// `cli/commands/validate.ts`, the reference implementation of the absolute
// Git trust rule: a read result's `untrusted` and `error` states MUST NEVER
// be collapsed into `absent`)
// ---------------------------------------------------------------------------

type EfYamlTrustCheck
	= | { kind: 'trusted' }
		/** No `.engineering/ef.yaml` blob at this commit at all -- a genuine, ordinary absence, distinct from `untrusted` below. */
		| { kind: 'absent' }
		/** A tree entry exists at exactly `.engineering/ef.yaml` but its Git mode/type is not an ordinary regular file (a symlink, a gitlink/submodule, or a directory literally named `ef.yaml`) -- never a genuine absence, and never safe to read as configuration bytes (Finding 5, `peekConfigAt`). */
		| { kind: 'untrusted', mode: string }
		/** A Git read failure -- `git-unavailable`, `missing` (contradicts an already-resolved commit), or `error` -- never proof of absence. */
		| { kind: 'blocked', message: string }

/**
 * `materialize` (via `loadSnapshotFromCommit`) already excludes a
 * non-regular-file `.engineering/ef.yaml` entry from the bytes it decodes as
 * configuration (`snapshot.ts`'s own Finding 5), so it never reads a
 * symlink's target TEXT as config. But it folds that exclusion into the SAME
 * `config.config === null` shape a genuinely absent `ef.yaml` produces --
 * indistinguishable, from `authoritativeIntegrationRef`-fixing code's point of
 * view, from "this commit simply names no ref." That is exactly the
 * collapse-into-absent this module's own doc comment and `peekConfigAt` both
 * forbid: an untrusted entry is a distinct, unresolved trust question, never
 * a proof of absence.
 *
 * This performs the SAME `readPathEntry` + `REGULAR_FILE_GIT_MODES` check
 * `peekConfigAt` performs, independently, on exactly the ONE commit whose
 * configuration is about to be trusted to fix the range's authoritative
 * `integration_ref` (the trusted range baseline when its `.engineering` entry
 * is present, or the range's bootstrap boundary otherwise) -- never on any
 * other commit in the sequence, so it stays a single-commit check at the
 * exact point of trust rather than another look-ahead.
 */
async function checkEfYamlTrust(git: GitRepository, commitOid: string, subject: string): Promise<EfYamlTrustCheck> {
	const entry = await git.readPathEntry(commitOid, EF_YAML_PATH)
	switch (entry.kind) {
		case 'resolved':
			return entry.entry.type === 'blob' && REGULAR_FILE_GIT_MODES.has(entry.entry.mode)
				? { kind: 'trusted' }
				: { kind: 'untrusted', mode: entry.entry.mode }
		case 'absent':
			return { kind: 'absent' }
		case 'git-unavailable':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: ${entry.message}` }
		case 'missing':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: the commit could not be re-read after already being resolved` }
		case 'error':
			return { kind: 'blocked', message: `Git is unavailable while reading ${subject}: ${entry.message}` }
		default:
			return assertNeverPathEntry(entry)
	}
}

// ---------------------------------------------------------------------------
// Ref selection (09-validation.md "Ref selection, capture, and staleness")
// ---------------------------------------------------------------------------

export type RangeIntegrationRefSource
	= | { kind: 'commit', role: 'baseline' | 'bootstrap', commitOid: string }
		/** No commit in `[baselineOid, proposedOid]` names an authoritative ref: an EF-inert range, or `listFirstParentRange` could not resolve the sequence at all (left for `validateRange` itself to report). */
		| { kind: 'none' }
		| { kind: 'blocked', message: string }

/**
 * Locates the ONE commit whose configuration fixes the range's authoritative
 * `integration_ref`, per 09-validation.md "Ref selection, capture, and
 * staleness": the trusted range baseline's own configuration when the
 * baseline's `.engineering` entry is present, and otherwise the range's
 * bootstrap boundary -- the oldest commit in the validated first-parent
 * sequence whose `.engineering` entry is present. The proposed commit is
 * never consulted to select the ref.
 *
 * This is a Git-object-only read (tree entries along the first-parent
 * sequence, nothing more) and is not itself validation: it materializes no
 * commit, evaluates no rule, and emits no finding. It exists so a caller
 * (the CLI) can learn the ref NAME before performing the single mutable ref
 * probe, still exactly once, still before any boundary is evaluated by
 * {@link validateRange} below -- which independently re-derives the same
 * commit via its own walk, so a disagreement between the two (only reachable
 * through a failed or racing read) is caught by `validateRange`'s own
 * captured-ref-NAME cross-check (`EF-VAL-002`) or missing-capture check
 * (`EF-VAL-006`), never silently accepted.
 *
 * A `listFirstParentRange` failure (`truncated`, `unresolved`,
 * `not-an-ancestor`, `git-unavailable`) is reported as `{ kind: 'none' }`
 * here -- `validateRange` alone owns reporting `EF-VAL-006`/`EF-VAL-007`/
 * `EF-VAL-011` for that same observation, with the full baseline/proposed
 * refs in its envelope.
 */
export async function findRangeIntegrationRefSource(
	git: GitRepository,
	baselineOid: string | null,
	proposedOid: string,
): Promise<RangeIntegrationRefSource> {
	if (baselineOid !== null) {
		const baselineObservation = await observeEfState(git, baselineOid, 'the trusted range baseline\'s EF state')
		if (baselineObservation.kind === 'present')
			return { kind: 'commit', role: 'baseline', commitOid: baselineOid }
		if (baselineObservation.kind === 'blocked')
			return { kind: 'blocked', message: baselineObservation.message }
		// `absent`: the trusted range baseline is pre-EF; fall through to scan
		// the validated sequence for the range's bootstrap boundary.
	}

	const rangeResult = await git.listFirstParentRange(baselineOid, proposedOid)
	if (rangeResult.kind !== 'resolved')
		return { kind: 'none' }

	for (const oid of rangeResult.oids) {
		const observation = await observeEfState(git, oid, `commit '${oid}''s EF state`)
		if (observation.kind === 'present')
			return { kind: 'commit', role: 'bootstrap', commitOid: oid }
		if (observation.kind === 'blocked')
			return { kind: 'blocked', message: observation.message }
		// `absent`: continue scanning oldest-first; a later commit's removal of
		// `.engineering` (if any) must never hide an earlier bootstrap boundary.
	}

	// The validated sequence has no EF-bearing commit at all: an EF-inert range.
	return { kind: 'none' }
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
	/**
	 * The captured operation-start state of the authoritative `integration_ref`.
	 * `undefined` means the caller identified NO authoritative ref from a
	 * trusted commit tree (via {@link findRangeIntegrationRefSource}) and
	 * therefore made no probe at all -- this MUST NOT be read as proven ref
	 * absence (that is `{ resolved: false }`, a distinct, proven fact). If the
	 * walk below nevertheless fixes an authoritative ref while this is
	 * `undefined`, the result is `EF-VAL-006` and incomplete
	 * (09-validation.md "Ref selection, capture, and staleness").
	 */
	operationStartRefState?: OperationStartRefState
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
 *
 * `state === undefined` is a THIRD, distinct case from either: the caller
 * identified an authoritative ref (this function is only ever called once
 * one is known) but made no capture of its operation-start state at all --
 * never a probe result, and never foldable into `{ resolved: false }`'s
 * proven absence. That is `EF-VAL-006` as well, since it is the same
 * observable class as a failed probe (both incomplete, exit 2): the range
 * has a ref that this operation was required to capture and did not.
 */
function checkOperationStartRefState(
	state: OperationStartRefState | undefined,
	expectedOid: string | null,
	integrationRef: string,
): { ok: true, expectedRefOid: string | null } | { ok: false, code: 'EF-VAL-002' | 'EF-VAL-006', message: string, expectedRefOid: string | null } {
	if (state === undefined) {
		return { ok: false, code: 'EF-VAL-006', message: `The operation-start state of the authoritative integration ref '${integrationRef}' was never captured before validation began; a missing capture is not proven absence.`, expectedRefOid: null }
	}
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

/**
 * Exhaustiveness guard for a discriminated union already narrowed to
 * `never`. If a new `FirstParentResult` variant is ever added without
 * updating {@link checkBootstrapHistoryCondition}'s switch, `value` stops
 * type-checking as `never` at the `default` branch below and the module fails
 * to compile -- a future Git adapter change can never silently reopen a
 * fall-through here.
 */
function assertNeverFirstParent(value: never): never {
	throw new Error(`Unhandled FirstParentResult variant: ${JSON.stringify(value)}`)
}

type BootstrapHistoryConditionResult
	= | { kind: 'satisfied' }
		| { kind: 'violated', commitOid: string }
		| { kind: 'incomplete', code: DiagnosticCode, message: string }

/**
 * Establishes the bootstrap history condition (09-validation.md "Bootstrap
 * exception": "a commit with no first parent satisfies the condition
 * vacuously and requires no probe"). `firstParent` is `oid`'s OWN
 * `getFirstParent` result, already narrowed by the caller to exclude
 * `git-unavailable`.
 *
 * `root-commit` is the ONLY variant treated as vacuous success. Every other
 * variant is either a proof (`resolved`, probed further below) or an
 * incomplete result -- never a silent fall-through into the vacuous-success
 * case. `missing` and `not-a-commit` are, in this context, an execution/
 * observation anomaly rather than a legitimate absence: `oid` was already
 * proven to exist and materialized as a commit earlier in this same walk (via
 * `listFirstParentRange` and `materialize`), so a `getFirstParent` probe on
 * that SAME `oid` reporting it is missing or not a commit contradicts an
 * already-established fact. That is exactly "the observation could not be
 * made" territory (09-validation.md "the first-parent chain cannot be walked
 * far enough to decide membership ... is `EF-VAL-007`"; "a shallow or
 * unresolvable required history is `EF-VAL-007`"), the SAME code this
 * function already uses immediately below for `error` and for an
 * unresolved/shallow history probe -- never a proof the bootstrap history
 * condition is satisfied.
 */
async function checkBootstrapHistoryCondition(
	git: GitRepository,
	firstParent: Exclude<FirstParentResult, GitUnavailable>,
	oid: string,
): Promise<BootstrapHistoryConditionResult> {
	switch (firstParent.kind) {
		case 'root-commit':
			return { kind: 'satisfied' }
		case 'resolved': {
			const historyCheck = await git.pathExistsInFirstParentHistory(firstParent.parentOid, EF_YAML_PATH)
			if (historyCheck.kind === 'git-unavailable') {
				return { kind: 'incomplete', code: 'EF-VAL-006', message: `Git is unavailable while checking the bootstrap history condition for commit '${oid}': ${historyCheck.message}` }
			}
			if (historyCheck.kind === 'unresolved' || historyCheck.kind === 'shallow') {
				return { kind: 'incomplete', code: 'EF-VAL-007', message: `Commit '${oid}''s first-parent history cannot be completely inspected to establish the bootstrap history condition.` }
			}
			if (historyCheck.kind === 'found') {
				return { kind: 'violated', commitOid: historyCheck.commitOid }
			}
			return { kind: 'satisfied' }
		}
		case 'error':
			return { kind: 'incomplete', code: 'EF-VAL-007', message: `Commit '${oid}''s parentage could not be determined to establish the bootstrap history condition: ${firstParent.message}` }
		case 'missing':
		case 'not-a-commit':
			return { kind: 'incomplete', code: 'EF-VAL-007', message: `Commit '${oid}''s parentage could not be re-established (reported '${firstParent.kind}') to check the bootstrap history condition, contradicting its earlier successful materialization.` }
		default:
			return assertNeverFirstParent(firstParent)
	}
}

export async function validateRange(input: ValidateRangeInput): Promise<RangeValidationResult> {
	const { git, baselineOid, proposedOid, operationStartRef, operationStartRefState } = input
	const policy = input.policy ?? DEFAULT_POLICY

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
		const baselineObservation = await observeEfState(git, resolvedBaselineOid, 'the trusted range baseline\'s EF state')
		if (baselineObservation.kind === 'blocked') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', baselineObservation.message),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
		}

		if (baselineObservation.kind === 'present') {
			previousTriple = tripleOf(baselineObservation.entry)

			// Absolute Git trust rule (`peekConfigAt`, `cli/commands/validate.ts`):
			// this commit's configuration is about to be trusted to fix the
			// range's authoritative `integration_ref`, so its
			// `.engineering/ef.yaml` entry must itself be a trusted regular file
			// BEFORE that trust is extended -- never folded into the `!baselineConfig`
			// branch below, which is reserved for a genuine absence of a valid
			// ref (a missing or malformed `ef.yaml`), not an unresolved trust
			// question over a symlink, gitlink, or directory at that exact path.
			const baselineYamlTrust = await checkEfYamlTrust(git, resolvedBaselineOid, 'the trusted range baseline\'s \'.engineering/ef.yaml\'')
			if (baselineYamlTrust.kind === 'blocked') {
				return incompleteResult([
					makeDiagnostic('EF-VAL-006', baselineYamlTrust.message),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
			}
			if (baselineYamlTrust.kind === 'untrusted') {
				return incompleteResult([
					makeDiagnostic('EF-VAL-006', `The trusted range baseline's '.engineering/ef.yaml' is not a regular file (Git mode '${baselineYamlTrust.mode}') and cannot be used to establish the range's authoritative integration ref.`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid })
			}
			// `trusted` or `absent`: fall through to materialization -- `absent`
			// (no `ef.yaml` at all) is a genuine, ordinary absence, still handled
			// by the `!baselineConfig` branch below exactly as before.

			const baselineMaterialized = await materialize(git, resolvedBaselineOid)
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
		// `baselineObservation.kind === 'absent'`: the trusted range baseline is
		// pre-EF. `previousTriple` stays `null`; `authoritativeIntegrationRef` is
		// fixed lazily from the range's OWN bootstrap boundary's configuration
		// the first time one is found below -- never from the proposed commit.
	}

	// ---- Walk the validated commit sequence, oldest-first --------------------

	const accumulated: Diagnostic[] = []
	let sawPresentState = previousTriple !== null

	for (const oid of oids) {
		const observation = await observeEfState(git, oid, `commit '${oid}''s EF state`)
		if (observation.kind === 'blocked') {
			return incompleteResult([
				...accumulated,
				makeDiagnostic('EF-VAL-006', observation.message),
			], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
		}

		const currentTriple = observation.kind === 'present' ? tripleOf(observation.entry) : null

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

			// Absolute Git trust rule (`peekConfigAt`, `cli/commands/validate.ts`):
			// reached with `previousTriple === null`, so by the loop invariant
			// documented below (`previousTriple !== null => authoritativeIntegrationRef
			// !== undefined`, established at the baseline and preserved by every
			// subsequent boundary) this commit is unconditionally the range's
			// bootstrap boundary -- the ONE commit whose own configuration is
			// about to be trusted to fix the authoritative `integration_ref` when
			// the trusted range baseline did not already fix it. Its
			// `.engineering/ef.yaml` entry must itself be a trusted regular file
			// BEFORE that trust is extended -- never folded into the
			// `!bootstrapConfig` branch below, which is reserved for a genuine
			// absence of a valid ref, not an unresolved trust question over a
			// symlink, gitlink, or directory at that exact path.
			const bootstrapYamlTrust = await checkEfYamlTrust(git, oid, `commit '${oid}''s '.engineering/ef.yaml'`)
			if (bootstrapYamlTrust.kind === 'blocked') {
				return incompleteResult([
					...accumulated,
					makeDiagnostic('EF-VAL-006', bootstrapYamlTrust.message),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
			}
			if (bootstrapYamlTrust.kind === 'untrusted') {
				return incompleteResult([
					...accumulated,
					makeDiagnostic('EF-VAL-006', `Commit '${oid}''s '.engineering/ef.yaml' is not a regular file (Git mode '${bootstrapYamlTrust.mode}') and cannot be used to establish the range's authoritative integration ref.`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
			}
			// `trusted` or `absent`: fall through to materialization -- `absent`
			// (no `ef.yaml` at all) is a genuine, ordinary absence, still handled
			// by the `!bootstrapConfig` branch below exactly as before.

			const bootstrapMaterialized = await materialize(git, oid)
			if (!bootstrapMaterialized.ok) {
				const code = bootstrapMaterialized.reason === 'git-unavailable' ? 'EF-VAL-006' : 'EF-VAL-011'
				return incompleteResult([
					...accumulated,
					makeDiagnostic(code, `Commit '${oid}' could not be materialized: ${bootstrapMaterialized.message}`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef ?? null, expectedRefOid })
			}

			// `bootstrapConfig` is read up front, before deciding whether the ref
			// still needs fixing: THIS boundary -- never the proposed commit -- is
			// the one authoritative source when the trusted range baseline did not
			// already fix the ref (09-validation.md "Ref selection, capture, and
			// staleness"). Reading the proposed commit's configuration here would
			// be a look-ahead letting a later removal or a later malformed
			// configuration preempt this boundary's own findings, breaking
			// oldest-first walk termination (09-validation.md "Walk termination").
			const bootstrapConfig = bootstrapMaterialized.commit.snapshot.config.config

			if (authoritativeIntegrationRef === undefined) {
				if (!bootstrapConfig) {
					// `config.config === null` provably implies an error-severity
					// diagnostic is already present in
					// `bootstrapMaterialized.commit.validation.diagnostics`:
					// `decodeConfig` returns `{ config: null }` only alongside an
					// `EF-FS-001` (repository/config.ts) or under `hasError`
					// (repository/config.ts), and a wholly absent `ef.yaml` makes
					// `validateSnapshot` push `EF-VAL-007` (snapshot-validation.ts).
					// This boundary is therefore already the first error-severity
					// boundary the walk was going to report; no authoritative ref
					// exists for this range at all, so the ref-dependent checks and
					// the bootstrap-exception history probe below are blocked
					// dependent checks that must never be reached -- the same shape
					// `validateTransition` already uses after its own ref-deviation
					// return (transition-validation.ts).
					return completeResult([
						...accumulated,
						...withCommitOid(bootstrapMaterialized.commit.validation.diagnostics, oid),
					], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: null, expectedRefOid: null })
				}

				authoritativeIntegrationRef = bootstrapConfig.repository.integrationRef

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
			// `authoritativeIntegrationRef !== undefined` unconditionally past
			// this point: either the trusted range baseline already fixed it
			// before the walk began, or it was just fixed above by THIS bootstrap
			// boundary's own configuration. The loop invariant `previousTriple !==
			// null => authoritativeIntegrationRef !== undefined` (established at
			// the baseline, preserved by every subsequent boundary) makes a
			// bootstrap boundary reached with an ALREADY-fixed ref unreachable --
			// the bootstrap exception is available at most once per range
			// (09-validation.md "Bootstrap exception") -- so there is no
			// equality check to make here against `bootstrapConfig`: the value
			// just assigned above IS `bootstrapConfig`'s own `integrationRef` by
			// construction. The transition-branch check below is the sole
			// enforcement point for later states preserving it.

			const boundaryDiagnostics: Diagnostic[] = [...bootstrapMaterialized.commit.validation.diagnostics]

			// ---- Bootstrap history condition (09-validation.md "Bootstrap exception") ----

			const firstParent = await git.getFirstParent(oid)
			if (firstParent.kind === 'git-unavailable') {
				return incompleteResult([
					...accumulated,
					makeDiagnostic('EF-VAL-006', `Git is unavailable while checking commit '${oid}''s parentage: ${firstParent.message}`),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}
			const historyCondition = await checkBootstrapHistoryCondition(git, firstParent, oid)
			if (historyCondition.kind === 'incomplete') {
				// `commit_oid` mirrors the sibling EF-VAL-007 diagnostics below
				// (unresolved/shallow history, undetermined parentage): finding
				// attribution to the specific boundary commit. `EF-VAL-006`
				// (Git/capability unavailable) never carries `commit_oid` anywhere
				// in this module -- it is an execution-capability failure, not a
				// boundary-specific finding -- so it is omitted here too.
				const options = historyCondition.code === 'EF-VAL-006' ? {} : { commitOid: oid }
				return incompleteResult([
					...accumulated,
					makeDiagnostic(historyCondition.code, historyCondition.message, options),
				], policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}
			if (historyCondition.kind === 'violated') {
				accumulated.push(makeDiagnostic('EF-VAL-009', `Bootstrap ref '${authoritativeIntegrationRef}' already contains an EF state before commit '${oid}'; commit '${historyCondition.commitOid}' has '.engineering/ef.yaml'.`, { commitOid: oid }))
				return completeResult(accumulated, policy, { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef: authoritativeIntegrationRef, expectedRefOid })
			}
			// `historyCondition.kind === 'satisfied'`: continue to the
			// bootstrap-only state rules below.

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

		const transitionMaterialized = await materialize(git, oid)
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
