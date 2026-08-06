/**
 * Transition validation (09-validation.md "Transition scope"; 11-filesystem-and-config.md
 * "Trusted transition baseline"; 07-change-transactions.md net-effect
 * classification and completion criteria; 02-identity.md issued-ID
 * immutability; 03-lifecycle.md transition legality; 05-supersession.md
 * atomicity; 06-resources.md frozen-Resource preservation).
 *
 * `validateTransition` materializes a trusted baseline commit and one
 * explicit proposed commit, snapshot-validates both trees (reusing
 * `validateSnapshot`), and then compares the two validated graphs for every
 * before/after invariant snapshot validation cannot prove on its own:
 * lifecycle transition legality and prohibited first appearance, frozen
 * whole-Artifact and Resource preservation, issued deletion, issued ID/type
 * immutability, `integration_ref` preservation, supersession atomicity, and
 * CHG net-effect classification, exactly-once coverage, and truthfulness.
 *
 * A baseline that fails any trust condition (unresolvable, unmaterializable,
 * internally invalid, ref-mismatched, or `integration_ref`-mismatched against
 * the proposed configuration) makes the whole result incomplete
 * (`EF-VAL-002`) rather than a snapshot-only fallback (09-validation
 * "Missing transition commit input").
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, RelationEntry, ResourceDescriptor, Status } from '../domain/model'
import type { OwnerResourceSnapshot, ResourceContentState } from '../domain/resources'
import type { SupersessionGraphFact } from '../domain/supersession'
import type { GitRepository } from '../git/repository'
import type { LoadSnapshotFailureReason, ProjectSnapshot } from './snapshot'
import type { SnapshotArtifactRecord, SnapshotValidationResult, ValidationPolicy, ValidationSummary } from './snapshot-validation'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { validateTransition as validateLifecycleTransition } from '../domain/lifecycle'
import { TERMINAL_STATUSES } from '../domain/model'
import { validateFrozenResourceMutation } from '../domain/resources'
import { validateSupersessionTransition } from '../domain/supersession'
import { loadSnapshotFromCommit } from './snapshot'
import { summarizeValidation, validateSnapshot } from './snapshot-validation'

const EF_YAML_PATH = '.engineering/ef.yaml'
const GITIGNORE_PATH = '.engineering/.gitignore'

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: { path?: string, artifactId?: string, field?: string, related?: Diagnostic['related'] } = {},
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		artifactId: options.artifactId,
		field: options.field,
		related: options.related ?? [],
	}
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

interface MaterializedCommit {
	snapshot: ProjectSnapshot
	validation: SnapshotValidationResult
	/** Project-relative path -> blob OID, for every entry beneath `.engineering` (config, gitignore, and every local Resource file). */
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
	if (treeResult.kind === 'missing')
		return { ok: false, reason: 'unresolvable', message: `Commit '${commitOid}' could not be materialized.` }

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

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === 'error')
}

// ---------------------------------------------------------------------------
// Aggregate-state comparison (07-change-transactions.md "Artifact aggregate state")
// ---------------------------------------------------------------------------

function isExternalLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

interface ResourceFingerprint {
	location: string
	contentKey: string
	type: string
	role: string
	mediaType: string
	normative: boolean
	description: string
	extensions: string
}

function resourceFingerprints(resources: readonly ResourceDescriptor[], oidByPath: ReadonlyMap<string, string>): ResourceFingerprint[] {
	return resources
		.map(resource => ({
			location: resource.location,
			contentKey: isExternalLocation(resource.location) ? `external:${resource.location}` : (oidByPath.get(resource.location) ?? '<missing>'),
			type: resource.type,
			role: resource.role,
			mediaType: resource.mediaType,
			normative: resource.normative,
			description: resource.description,
			extensions: JSON.stringify(resource.extensions),
		}))
		.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0))
}

interface AggregateSignature {
	present: boolean
	markdownBytes: Uint8Array | undefined
	resources: ResourceFingerprint[]
	configOid: string | undefined
	gitignoreOid: string | undefined
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined)
		return a === b
	if (a.length !== b.length)
		return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i])
			return false
	}
	return true
}

function artifactBytesByPath(snapshot: ProjectSnapshot): ReadonlyMap<string, Uint8Array> {
	return new Map(snapshot.artifacts.map(artifact => [artifact.path, artifact.bytes] as const))
}

function signatureFor(
	id: string,
	record: SnapshotArtifactRecord | undefined,
	artifactBytes: ReadonlyMap<string, Uint8Array>,
	oidByPath: ReadonlyMap<string, string>,
): AggregateSignature {
	if (!record) {
		return { present: false, markdownBytes: undefined, resources: [], configOid: undefined, gitignoreOid: undefined }
	}
	const isProject = id === 'PROJECT'
	return {
		present: true,
		markdownBytes: artifactBytes.get(record.path),
		resources: resourceFingerprints(record.envelope.resources, oidByPath),
		configOid: isProject ? oidByPath.get(EF_YAML_PATH) : undefined,
		gitignoreOid: isProject ? oidByPath.get(GITIGNORE_PATH) : undefined,
	}
}

function signaturesEqual(a: AggregateSignature, b: AggregateSignature): boolean {
	if (a.present !== b.present)
		return false
	if (!a.present)
		return true
	return bytesEqual(a.markdownBytes, b.markdownBytes)
		&& a.configOid === b.configOid
		&& a.gitignoreOid === b.gitignoreOid
		&& JSON.stringify(a.resources) === JSON.stringify(b.resources)
}

function resourcesOnlyChange(a: AggregateSignature, b: AggregateSignature): boolean {
	return a.present && b.present
		&& bytesEqual(a.markdownBytes, b.markdownBytes)
		&& a.configOid === b.configOid
		&& a.gitignoreOid === b.gitignoreOid
		&& JSON.stringify(a.resources) !== JSON.stringify(b.resources)
}

// ---------------------------------------------------------------------------
// CHG-required mutation classification (07-change-transactions.md "CHG-required mutations" / "CHG-optional mutations")
// ---------------------------------------------------------------------------

/**
 * Whether a change from `before` to `after` for one Artifact falls under
 * 07-change-transactions.md's CHG-required list, given that its aggregate
 * state is already known to have changed. CHG's own creation and status
 * transitions are self-exempt and never CHG-required.
 */
function requiresChg(type: ArtifactType, before: Status | undefined, after: Status): boolean {
	if (type === 'change')
		return false

	if (before === undefined) {
		// First authoritative appearance: draft creation is optional, direct
		// active creation requires CHG's `introduces` effect.
		return after !== 'draft'
	}

	if (before === 'draft') {
		// draft -> draft (edit), draft -> retired: both CHG-optional.
		// draft -> active (activation): CHG-required.
		return after === 'active'
	}

	if (TERMINAL_STATUSES.includes(before)) {
		// A frozen Artifact's own content must never change; that violation is
		// EF-LIFE-004's (and EF-RES-013's) responsibility, not a coverage gap.
		return false
	}

	// before === 'active': every content, relation, Resource, or status change requires CHG.
	return true
}

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

export interface ValidateTransitionInput {
	git: GitRepository
	/** Full commit OID of the trusted baseline (11-filesystem-and-config.md "Trusted transition baseline"). */
	baselineOid: string
	/** Full commit OID of the explicit proposed commit; its first parent MUST be `baselineOid`. */
	proposedOid: string
	/**
	 * The OID that the baseline-fixed `integration_ref` resolved to when the
	 * integration operation began, or `null` when that ref was unresolved.
	 * Mutable ref state is an explicit caller-supplied input rather than
	 * re-resolved here (09-validation.md "Validation hooks": "operation-start
	 * captured project-repository and local-ref state").
	 */
	operationStartRefOid: string | null
	policy?: ValidationPolicy
}

export type TransitionValidationResult = ValidationSummary & { diagnostics: Diagnostic[] }

const DEFAULT_POLICY: ValidationPolicy = { strict: false, warningsAsErrors: false }

function incompleteResult(diagnostics: Diagnostic[], policy: ValidationPolicy, refs?: { baselineOid?: string | null, proposedOid?: string | null, integrationRef?: string | null, expectedRefOid?: string | null }): TransitionValidationResult {
	const summary = summarizeValidation({ scope: 'transition', diagnostics, complete: false, policy, refs })
	return { ...summary, diagnostics: aggregateDiagnostics(diagnostics) }
}

export async function validateTransition(input: ValidateTransitionInput): Promise<TransitionValidationResult> {
	const { git, baselineOid, proposedOid, operationStartRefOid } = input
	const policy = input.policy ?? DEFAULT_POLICY

	// ---- Resolve and materialize the trusted baseline -----------------------

	const baselineResolved = await git.resolveCommit(baselineOid)
	if (baselineResolved.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while resolving the trusted baseline: ${baselineResolved.message}`),
		], policy)
	}
	if (baselineResolved.kind !== 'resolved') {
		const message = baselineResolved.kind === 'malformed'
			? `Baseline '${baselineOid}' is not a full commit OID for this repository's object format.`
			: baselineResolved.kind === 'missing'
				? `Baseline '${baselineOid}' does not resolve to any object.`
				: `Baseline '${baselineOid}' resolves to a ${baselineResolved.actualType}, not a commit.`
		return incompleteResult([makeDiagnostic('EF-VAL-002', message)], policy)
	}
	const resolvedBaselineOid = baselineResolved.oid

	const baselineMaterialized = await materialize(git, resolvedBaselineOid)
	if (!baselineMaterialized.ok) {
		if (baselineMaterialized.reason === 'git-unavailable') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', `Git is unavailable while materializing the trusted baseline: ${baselineMaterialized.message}`),
			], policy)
		}
		return incompleteResult([
			makeDiagnostic('EF-VAL-002', `Trusted baseline '${resolvedBaselineOid}' could not be materialized: ${baselineMaterialized.message}`),
		], policy)
	}
	const baseline = baselineMaterialized.commit

	if (hasErrors(baseline.validation.diagnostics)) {
		return incompleteResult([
			...baseline.validation.diagnostics,
			makeDiagnostic('EF-VAL-002', `Trusted baseline '${resolvedBaselineOid}' does not contain a valid authoritative EF snapshot.`),
		], policy, { baselineOid: resolvedBaselineOid })
	}

	const baselineConfig = baseline.snapshot.config.config
	if (!baselineConfig) {
		return incompleteResult([
			makeDiagnostic('EF-VAL-002', `Trusted baseline '${resolvedBaselineOid}' does not name a valid 'integration_ref'.`),
		], policy, { baselineOid: resolvedBaselineOid })
	}
	const integrationRef = baselineConfig.repository.integrationRef

	// ---- Verify operation-start ref state against the baseline ---------------

	if (operationStartRefOid !== resolvedBaselineOid) {
		return incompleteResult([
			makeDiagnostic('EF-VAL-002', `Integration ref '${integrationRef}' resolved to '${operationStartRefOid ?? 'nothing'}' when the operation began, not the trusted baseline '${resolvedBaselineOid}'.`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}

	// ---- Resolve, verify parentage, and materialize the proposed commit ------

	const proposedResolved = await git.resolveCommit(proposedOid)
	if (proposedResolved.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while resolving the proposed commit: ${proposedResolved.message}`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}
	if (proposedResolved.kind !== 'resolved') {
		const message = proposedResolved.kind === 'malformed'
			? `Proposed '${proposedOid}' is not a full commit OID for this repository's object format.`
			: proposedResolved.kind === 'missing'
				? `Proposed '${proposedOid}' does not resolve to any object.`
				: `Proposed '${proposedOid}' resolves to a ${proposedResolved.actualType}, not a commit.`
		return incompleteResult([makeDiagnostic('EF-VAL-011', message)], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}
	const resolvedProposedOid = proposedResolved.oid

	const firstParent = await git.getFirstParent(resolvedProposedOid)
	if (firstParent.kind === 'git-unavailable') {
		return incompleteResult([
			makeDiagnostic('EF-VAL-006', `Git is unavailable while checking proposed parentage: ${firstParent.message}`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}
	if (firstParent.kind !== 'resolved' || firstParent.parentOid !== resolvedBaselineOid) {
		return incompleteResult([
			makeDiagnostic('EF-VAL-011', `Proposed commit '${resolvedProposedOid}' does not use the trusted baseline '${resolvedBaselineOid}' as its first parent.`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}

	const proposedMaterialized = await materialize(git, resolvedProposedOid)
	if (!proposedMaterialized.ok) {
		if (proposedMaterialized.reason === 'git-unavailable') {
			return incompleteResult([
				makeDiagnostic('EF-VAL-006', `Git is unavailable while materializing the proposed commit: ${proposedMaterialized.message}`),
			], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
		}
		return incompleteResult([
			makeDiagnostic('EF-VAL-011', `Proposed commit '${resolvedProposedOid}' could not be materialized: ${proposedMaterialized.message}`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}
	const proposed = proposedMaterialized.commit

	const diagnostics: Diagnostic[] = [...proposed.validation.diagnostics]

	// ---- integration_ref preservation (11-filesystem-and-config.md "Trusted
	// transition baseline": the baseline "MUST ... use the same integration_ref
	// value as the proposed configuration") ------------------------------------

	const proposedConfig = proposed.snapshot.config.config
	if (proposedConfig && proposedConfig.repository.integrationRef !== integrationRef) {
		return incompleteResult([
			...diagnostics,
			makeDiagnostic('EF-VAL-002', `Proposed configuration's 'integration_ref' ('${proposedConfig.repository.integrationRef}') does not match the trusted baseline's fixed 'integration_ref' ('${integrationRef}').`),
		], policy, { baselineOid: resolvedBaselineOid, integrationRef, expectedRefOid: operationStartRefOid })
	}

	// ---- Transition integrity (phase 9) ---------------------------------------

	diagnostics.push(...compareTransition(baseline, proposed))

	return {
		...summarizeValidation({
			scope: 'transition',
			diagnostics,
			complete: true,
			policy,
			refs: { baselineOid: resolvedBaselineOid, proposedOid: resolvedProposedOid, integrationRef, expectedRefOid: operationStartRefOid },
		}),
		diagnostics: aggregateDiagnostics(diagnostics),
	}
}

// ---------------------------------------------------------------------------
// compareTransition: everything requiring both validated snapshots
// ---------------------------------------------------------------------------

function compareTransition(baseline: MaterializedCommit, proposed: MaterializedCommit): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	const baselineById = baseline.validation.byId
	const proposedById = proposed.validation.byId
	const baselineArtifactBytes = artifactBytesByPath(baseline.snapshot)
	const proposedArtifactBytes = artifactBytesByPath(proposed.snapshot)
	const proposedArtifactPaths = new Set(proposed.snapshot.artifacts.map(a => a.path))

	const allIds = new Set([...baselineById.keys(), ...proposedById.keys()])

	// ---- EF-LIFE-003 / EF-LIFE-009: transition legality and deletion --------

	const chgEffectIntroducesTargets = new Set(
		proposed.validation.chgEffects
			.filter(effect => effect.type === 'introduces' && proposedById.get(effect.chgId)?.status === 'completed')
			.map(effect => effect.target),
	)

	for (const id of allIds) {
		const before = baselineById.get(id)
		const after = proposedById.get(id)

		if (before && !after) {
			if (!proposedArtifactPaths.has(before.path)) {
				diagnostics.push(makeDiagnostic(
					'EF-LIFE-009',
					`Issued Artifact '${id}' was physically deleted.`,
					{ path: before.path, artifactId: id },
				))
			}
			continue
		}

		if (!after)
			continue

		diagnostics.push(...validateLifecycleTransition({
			type: after.type,
			before: before?.status,
			after: after.status,
			id,
			path: after.path,
			introducedByCompletedChg: chgEffectIntroducesTargets.has(id),
			isProjectBootstrap: false,
		}))
	}

	// ---- EF-ID-010 / EF-ID-009: issued ID and type immutability -------------

	for (const artifact of baseline.snapshot.artifacts) {
		const baselineEnvelope = artifact.envelope?.envelope
		if (!baselineEnvelope)
			continue
		const proposedArtifact = proposed.snapshot.artifacts.find(a => a.path === artifact.path)
		const proposedEnvelope = proposedArtifact?.envelope?.envelope
		if (proposedEnvelope && proposedEnvelope.id !== baselineEnvelope.id) {
			diagnostics.push(makeDiagnostic(
				'EF-ID-010',
				`Issued Artifact ID '${baselineEnvelope.id}' at '${artifact.path}' was changed to '${proposedEnvelope.id}'.`,
				{ path: artifact.path, artifactId: baselineEnvelope.id, field: 'id' },
			))
		}
	}

	for (const [id, before] of baselineById) {
		const after = proposedById.get(id)
		if (after && after.path !== before.path) {
			diagnostics.push(makeDiagnostic(
				'EF-ID-009',
				`Issued ID '${id}' was transferred from '${before.path}' to '${after.path}'.`,
				{ path: after.path, artifactId: id },
			),
			)
		}
	}

	// ---- EF-ID-012: provisional branch collision (detectable subset) -------
	// A duplicate ID within the proposed graph where none of the participating
	// files existed in the (already-verified-valid) baseline is a collision
	// between two freshly allocated candidates, not a corruption of an issued
	// identity (which `EF-ID-004` already reports as the primary finding).

	for (const d of proposed.validation.diagnostics) {
		if (d.code !== 'EF-ID-004' || !d.artifactId)
			continue
		if (baselineById.has(d.artifactId))
			continue
		diagnostics.push(makeDiagnostic(
			'EF-ID-012',
			`Provisional Artifact ID '${d.artifactId}' collides across independently allocated candidates and blocks integration.`,
			{ path: d.path, artifactId: d.artifactId },
		))
	}

	// ---- EF-LIFE-004: frozen whole-Artifact preservation --------------------

	for (const [id, before] of baselineById) {
		if (!TERMINAL_STATUSES.includes(before.status))
			continue
		if (!proposedArtifactPaths.has(before.path))
			continue // already reported as EF-LIFE-009 if truly gone; otherwise handled below by path lookup.
		const beforeBytes = baselineArtifactBytes.get(before.path)
		const afterBytes = proposedArtifactBytes.get(before.path)
		if (!bytesEqual(beforeBytes, afterBytes)) {
			diagnostics.push(makeDiagnostic(
				'EF-LIFE-004',
				`Frozen terminal Artifact '${id}' was modified.`,
				{ path: before.path, artifactId: id },
			))
		}
	}

	// ---- EF-RES-013: frozen Resource preservation ---------------------------

	for (const [id, before] of baselineById) {
		if (!TERMINAL_STATUSES.includes(before.status))
			continue
		const after = proposedById.get(id)
		if (!after)
			continue
		const beforeSnapshot: OwnerResourceSnapshot = {
			artifactId: id,
			path: before.path,
			frozen: true,
			resources: resourceContentStates(before.envelope.resources, baseline.oidByPath),
		}
		const afterSnapshot: OwnerResourceSnapshot = {
			artifactId: id,
			path: after.path,
			frozen: true,
			resources: resourceContentStates(after.envelope.resources, proposed.oidByPath),
		}
		diagnostics.push(...validateFrozenResourceMutation(beforeSnapshot, afterSnapshot))
	}

	// ---- EF-SUP-004 / EF-SUP-007: supersession atomicity --------------------

	const baselineSupersessionFacts = supersessionFactsFrom(baselineById)
	const proposedSupersessionFacts = supersessionFactsFrom(proposedById)
	diagnostics.push(...validateSupersessionTransition({ before: baselineSupersessionFacts, after: proposedSupersessionFacts }))

	// ---- EF-SUP-013: implicit retargeting during supersession ---------------

	diagnostics.push(...detectImplicitRetargeting(baselineById, proposedById, baselineSupersessionFacts, proposedSupersessionFacts))

	// ---- EF-CHG-*: net-effect classification, coverage, and truthfulness ----

	diagnostics.push(...validateChgTransaction({
		baselineById,
		proposedById,
		baselineArtifactBytes,
		proposedArtifactBytes,
		baselineOidByPath: baseline.oidByPath,
		proposedOidByPath: proposed.oidByPath,
	}))

	return diagnostics
}

function resourceContentStates(resources: readonly ResourceDescriptor[], oidByPath: ReadonlyMap<string, string>): ResourceContentState[] {
	return resources.map(resource => ({
		location: resource.location,
		type: resource.type,
		role: resource.role,
		mediaType: resource.mediaType,
		normative: resource.normative,
		description: resource.description,
		extensions: resource.extensions,
		contentHash: isExternalLocation(resource.location) ? undefined : oidByPath.get(resource.location),
	}))
}

function supersessionFactsFrom(byId: ReadonlyMap<string, SnapshotArtifactRecord>): SupersessionGraphFact[] {
	const facts: SupersessionGraphFact[] = []
	for (const record of byId.values()) {
		if (record.type === 'change')
			continue
		facts.push({
			id: record.id,
			type: record.type,
			status: record.status,
			supersededBy: record.relations.filter(r => r.type === 'superseded-by')
				.map(r => r.target),
		})
	}
	return facts
}

/**
 * `EF-SUP-013`: an Artifact other than a supersession source itself has, in
 * this same transition, an edge to a source's replacement that exactly
 * replaces a removed edge of the same relation type to that source
 * (05-supersession.md "No implicit retargeting"). This detects the documented
 * pattern -- an existing `addresses`/`governed-by`/`references`/`derived-from`
 * edge silently rewritten to a replacement rather than the source's original
 * historical edge being preserved -- without asserting whether one particular
 * CHG performed the rewrite.
 */
function detectImplicitRetargeting(
	baselineById: ReadonlyMap<string, SnapshotArtifactRecord>,
	proposedById: ReadonlyMap<string, SnapshotArtifactRecord>,
	baselineFacts: readonly SupersessionGraphFact[],
	proposedFacts: readonly SupersessionGraphFact[],
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const baselineFactById = new Map(baselineFacts.map(f => [f.id, f] as const))

	const newlySuperseded = proposedFacts.filter((fact) => {
		const before = baselineFactById.get(fact.id)
		return fact.status === 'superseded' && before?.status !== 'superseded'
	})

	for (const source of newlySuperseded) {
		const replacements = new Set(source.supersededBy)

		for (const [id, after] of proposedById) {
			if (id === source.id)
				continue
			const before = baselineById.get(id)
			if (!before)
				continue

			const beforeEdges = new Set(before.relations.map(r => `${r.type} ${r.target}`))
			const afterEdges = new Set(after.relations.map(r => `${r.type} ${r.target}`))

			for (const relation of before.relations) {
				if (relation.target !== source.id)
					continue
				const removedKey = `${relation.type} ${relation.target}`
				if (afterEdges.has(removedKey))
					continue // the historical edge to the source is preserved.

				for (const replacement of replacements) {
					const addedKey = `${relation.type} ${replacement}`
					if (!beforeEdges.has(addedKey) && afterEdges.has(addedKey)) {
						diagnostics.push(makeDiagnostic(
							'EF-SUP-013',
							`Existing relation '${relation.type}' from '${id}' to '${source.id}' was implicitly retargeted to '${replacement}' during supersession.`,
							{ path: after.path, artifactId: id, field: 'relations' },
						))
					}
				}
			}
		}
	}

	return diagnostics
}

// ---------------------------------------------------------------------------
// CHG net-effect classification, coverage, and truthfulness
// ---------------------------------------------------------------------------

interface ChgEffectDeclaration {
	chgId: string
	target: string
	type: RelationEntry['type']
	path: string
}

function classifyActualEffect(before: AggregateSignature, after: AggregateSignature, afterStatus: Status | undefined): 'introduces' | 'modifies' | 'retires' | 'unchanged' {
	if (!before.present && after.present)
		return 'introduces'
	if (before.present && !after.present)
		return 'unchanged' // physical deletion; not a CHG effect shape (EF-LIFE-009 owns this).
	if (!before.present && !after.present)
		return 'unchanged'
	if (afterStatus === 'retired')
		return 'retires'
	return signaturesEqual(before, after) ? 'unchanged' : 'modifies'
}

function validateChgTransaction(input: {
	baselineById: ReadonlyMap<string, SnapshotArtifactRecord>
	proposedById: ReadonlyMap<string, SnapshotArtifactRecord>
	baselineArtifactBytes: ReadonlyMap<string, Uint8Array>
	proposedArtifactBytes: ReadonlyMap<string, Uint8Array>
	baselineOidByPath: ReadonlyMap<string, string>
	proposedOidByPath: ReadonlyMap<string, string>
}): Diagnostic[] {
	const { baselineById, proposedById, baselineArtifactBytes, proposedArtifactBytes, baselineOidByPath, proposedOidByPath } = input
	const diagnostics: Diagnostic[] = []

	const knownTargetIds = new Set([...baselineById.keys(), ...proposedById.keys(), 'PROJECT'])

	function signatureOfBefore(id: string): AggregateSignature {
		return signatureFor(id, baselineById.get(id), baselineArtifactBytes, baselineOidByPath)
	}
	function signatureOfAfter(id: string): AggregateSignature {
		return signatureFor(id, proposedById.get(id), proposedArtifactBytes, proposedOidByPath)
	}

	// PROJECT is always implicitly known even when its record decoded, so the
	// aggregate-signature helper already treats id 'PROJECT' specially.

	// ---- Classify every id's change and CHG requirement ----------------------

	const changed = new Map<string, boolean>()
	const required = new Map<string, boolean>()
	for (const id of knownTargetIds) {
		const before = signatureOfBefore(id)
		const after = signatureOfAfter(id)
		const isChanged = !signaturesEqual(before, after)
		changed.set(id, isChanged)
		if (!isChanged) {
			required.set(id, false)
			continue
		}
		const beforeRecord = baselineById.get(id)
		const afterRecord = proposedById.get(id)
		const type: ArtifactType | undefined = afterRecord?.type ?? beforeRecord?.type ?? (id === 'PROJECT' ? 'project' : undefined)
		if (!type) {
			required.set(id, false)
			continue
		}
		required.set(id, requiresChg(type, beforeRecord?.status, afterRecord?.status ?? beforeRecord!.status))
	}

	// ---- Gather new completed CHGs and their declared effects ---------------

	const newCompletedChgIds: string[] = []
	for (const [id, after] of proposedById) {
		if (after.type !== 'change')
			continue
		const before = baselineById.get(id)
		if (after.status === 'completed' && before?.status !== 'completed')
			newCompletedChgIds.push(id)
	}

	// EF-CHG-008: draft or retired CHG (any CHG in the proposed graph, not only
	// newly appearing ones) declaring a factual effect relation.
	const exemptChgIds = new Set<string>()
	for (const [id, record] of proposedById) {
		if (record.type !== 'change')
			continue
		if (record.status === 'completed')
			continue
		const effectRelations = record.relations.filter(r => r.type === 'introduces' || r.type === 'modifies' || r.type === 'retires')
		if (effectRelations.length > 0) {
			exemptChgIds.add(id)
			diagnostics.push(makeDiagnostic(
				'EF-CHG-008',
				`${record.status === 'draft' ? 'Draft' : 'Retired'} CHG '${id}' declares a factual effect relation.`,
				{ path: record.path, artifactId: id, field: 'relations' },
			))
		}
	}

	const declarations: ChgEffectDeclaration[] = []
	for (const chgId of newCompletedChgIds) {
		if (exemptChgIds.has(chgId))
			continue
		const record = proposedById.get(chgId)!
		for (const relation of record.relations) {
			if (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires')
				declarations.push({ chgId, target: relation.target, type: relation.type, path: record.path })
		}
	}

	// EF-CHG-017: an effect targets a CHG.
	const nonChgDeclarations: ChgEffectDeclaration[] = []
	for (const declaration of declarations) {
		const targetType = proposedById.get(declaration.target)?.type
		if (targetType === 'change') {
			diagnostics.push(makeDiagnostic(
				'EF-CHG-017',
				`CHG '${declaration.chgId}' declares a '${declaration.type}' effect on another CHG '${declaration.target}'.`,
				{ path: declaration.path, artifactId: declaration.chgId, field: 'relations' },
			))
		}
		else {
			nonChgDeclarations.push(declaration)
		}
	}

	// EF-CHG-004: one CHG declares conflicting effect types for one target.
	const perChgTargetTypes = new Map<string, Map<string, Set<string>>>()
	for (const declaration of nonChgDeclarations) {
		let byTarget = perChgTargetTypes.get(declaration.chgId)
		if (!byTarget) {
			byTarget = new Map()
			perChgTargetTypes.set(declaration.chgId, byTarget)
		}
		const types = byTarget.get(declaration.target) ?? new Set<string>()
		types.add(declaration.type)
		byTarget.set(declaration.target, types)
	}
	const conflictingChgTargets = new Set<string>() // `${chgId} ${target}`
	for (const [chgId, byTarget] of perChgTargetTypes) {
		for (const [target, types] of byTarget) {
			if (types.size > 1) {
				conflictingChgTargets.add(`${chgId} ${target}`)
				const record = proposedById.get(chgId)!
				diagnostics.push(makeDiagnostic(
					'EF-CHG-004',
					`CHG '${chgId}' declares conflicting effects (${[...types].sort()
						.join(', ')}) for target '${target}'.`,
					{ path: record.path, artifactId: chgId, field: 'relations' },
				))
			}
		}
	}

	const resolvableDeclarations = nonChgDeclarations.filter(d => !conflictingChgTargets.has(`${d.chgId} ${d.target}`))

	// EF-CHG-007: multiple completing CHGs claim the same target.
	const chgIdsByTarget = new Map<string, Set<string>>()
	for (const declaration of resolvableDeclarations) {
		const set = chgIdsByTarget.get(declaration.target) ?? new Set<string>()
		set.add(declaration.chgId)
		chgIdsByTarget.set(declaration.target, set)
	}
	for (const [target, chgIds] of chgIdsByTarget) {
		if (chgIds.size <= 1)
			continue
		for (const declaration of resolvableDeclarations.filter(d => d.target === target)) {
			diagnostics.push(makeDiagnostic(
				'EF-CHG-007',
				`Target '${target}' is claimed as an effect by multiple completing CHGs: ${[...chgIds].sort()
					.join(', ')}.`,
				{ path: declaration.path, artifactId: declaration.chgId, field: 'relations' },
			))
		}
	}

	// EF-CHG-006 / EF-CHG-012 / EF-CHG-003: per-declaration truthfulness.
	const coveredTargets = new Set<string>()
	for (const declaration of resolvableDeclarations) {
		coveredTargets.add(declaration.target)

		const isChanged = changed.get(declaration.target) ?? false
		if (!isChanged) {
			diagnostics.push(makeDiagnostic(
				'EF-CHG-006',
				`CHG '${declaration.chgId}' declares an effect on unchanged target '${declaration.target}'.`,
				{ path: declaration.path, artifactId: declaration.chgId, field: 'relations' },
			))
			continue
		}

		const before = signatureOfBefore(declaration.target)
		const after = signatureOfAfter(declaration.target)

		if (resourcesOnlyChange(before, after)) {
			if (declaration.type !== 'modifies') {
				diagnostics.push(makeDiagnostic(
					'EF-CHG-012',
					`CHG '${declaration.chgId}' declares '${declaration.type}' for '${declaration.target}', but only its Resources changed, which requires 'modifies'.`,
					{ path: declaration.path, artifactId: declaration.chgId, field: 'relations' },
				))
			}
			continue
		}

		const afterStatus = proposedById.get(declaration.target)?.status
		const actual = classifyActualEffect(before, after, afterStatus)
		if (actual !== 'unchanged' && actual !== declaration.type) {
			diagnostics.push(makeDiagnostic(
				'EF-CHG-003',
				`CHG '${declaration.chgId}' declares '${declaration.type}' for '${declaration.target}', but its actual net effect is '${actual}'.`,
				{ path: declaration.path, artifactId: declaration.chgId, field: 'relations' },
			))
		}
	}

	// EF-CHG-005: a changed, CHG-required target with no effective coverage.
	let anyChangedRequiredTarget = false
	for (const [id, isRequired] of required) {
		if (!isRequired)
			continue
		anyChangedRequiredTarget = true
		if (!coveredTargets.has(id)) {
			const path = proposedById.get(id)?.path ?? baselineById.get(id)?.path
			diagnostics.push(makeDiagnostic(
				'EF-CHG-005',
				`Changed CHG-required target '${id}' is not covered by exactly one completed CHG effect.`,
				{ path, artifactId: id === 'PROJECT' ? undefined : id },
			))
		}
	}

	// EF-CHG-002: a new completed CHG with no effect relations at all, only
	// when no changed CHG-required target exists anywhere in this transition
	// (09-validation.md precedence: "Completed CHG has no effects and changed
	// required targets exist -> per-target EF-CHG-005; EF-CHG-002 is suppressed").
	if (!anyChangedRequiredTarget) {
		for (const chgId of newCompletedChgIds) {
			if (exemptChgIds.has(chgId))
				continue
			const record = proposedById.get(chgId)!
			const hasAnyEffect = record.relations.some(r => r.type === 'introduces' || r.type === 'modifies' || r.type === 'retires')
			if (!hasAnyEffect) {
				diagnostics.push(makeDiagnostic(
					'EF-CHG-002',
					`Completed CHG '${chgId}' has no effect relations.`,
					{ path: record.path, artifactId: chgId },
				))
			}
		}
	}

	return diagnostics
}
