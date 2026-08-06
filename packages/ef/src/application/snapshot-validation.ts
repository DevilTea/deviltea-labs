/**
 * Snapshot validation pipeline (09-validation.md "Validation Pipeline",
 * "Snapshot scope", "Cascading Diagnostics") and validation summary semantics
 * (09-validation.md "Validation Summary", "CI Contract").
 *
 * `validateSnapshot` composes the already-verified domain and repository
 * validators over one `ProjectSnapshot` (./snapshot) in the spec's phase
 * order, respecting cascading suppression, and produces the aggregated,
 * deterministically ordered diagnostic list plus derived indexes
 * (`byId`, incoming relation edges, Resource ownership, current-canonical
 * resolution, CHG effect edges) for the transition/query layer to reuse
 * without recomputing them.
 *
 * CHG net-effect classification, coverage, and truthfulness (`EF-CHG-002`,
 * `003`, `005`, `006`, `007`, `012`), lifecycle-transition legality, and
 * every other before/after comparison are out of snapshot scope
 * (09-validation.md "Snapshot validation cannot prove ... CHG effect
 * truthfulness ... because those checks require a trusted previous state.")
 * and are left for the transition-validation module to add once a baseline
 * is available; this module exposes the CHG effect edges it already knows
 * about (from the current graph's `introduces`/`modifies`/`retires`
 * relations) so that module does not need to re-derive them.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope, RelationType, Status } from '../domain/model'
import type { RelationGraphArtifact } from '../domain/relations'
import type { LocalResourceFileEntry, LocalResourceFileState, ResourceOwnershipEntry } from '../domain/resources'
import type { SupersessionGraphFact } from '../domain/supersession'
import type { ExtractedSections } from '../parsing/markdown'
import type { SymlinkFact } from '../repository/symlinks'
import type { PathNormalizationEntry } from '../repository/text-normalization'
import type { ProjectSnapshot, SnapshotEntryKind } from './snapshot'
import { validateBody } from '../domain/body-schemas'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { validateFilename, validateGraphIdentity, validateIdSyntax } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { validateRelationEntries, validateRelationGraph } from '../domain/relations'
import {
	findOrphanResourceFiles,
	validateLocalResourceFiles,
	validateResourceDescriptors,
	validateResourceOwnership,
} from '../domain/resources'
import { resolveCurrent, validateSupersessionGraph } from '../domain/supersession'
import { checkManagedSymlinks, managedSymlinkPaths } from '../repository/symlinks'
import { checkPathNormalization, checkTextNormalization } from '../repository/text-normalization'
import { rawArrayField } from './snapshot-raw-fields'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** One successfully decoded Artifact, reduced to the facts the graph indexes need. */
export interface SnapshotArtifactRecord {
	path: string
	id: string
	type: ArtifactType
	status: Status
	envelope: Envelope
	/** Relation entries that passed `validateRelationEntries`' own shape and vocabulary checks. */
	relations: RelationGraphArtifact['relations']
}

export interface IncomingRelationEdge {
	from: string
	type: RelationType
}

export interface ChgEffectEdge {
	chgId: string
	type: Extract<RelationType, 'introduces' | 'modifies' | 'retires'>
	target: string
}

export interface SnapshotValidationResult {
	/** Complete, deduplicated, deterministically ordered diagnostics (09-validation "Diagnostic aggregation"). */
	diagnostics: Diagnostic[]
	/** `false` only when the validator lacked context or capability required by snapshot scope (09-validation "Validation completeness"). */
	complete: boolean
	/** Every successfully decoded Artifact, keyed by its declared ID. Excludes files whose envelope failed to decode and files whose ID duplicates another file's (ambiguous; see 09-validation "Cascading Diagnostics"). */
	byId: ReadonlyMap<string, SnapshotArtifactRecord>
	/** Outgoing relation edges, indexed by target Artifact ID. */
	incomingRelations: ReadonlyMap<string, IncomingRelationEdge[]>
	/** Local Resource `location` -> the Artifact IDs that declare it (usually one; more than one is `EF-RES-009`). */
	resourceOwnership: ReadonlyMap<string, string[]>
	/** Artifact ID -> its current-resolution result (05-supersession "Current-resolution algorithm"); `[]` when resolution failed or the root is a CHG. */
	currentIds: ReadonlyMap<string, string[]>
	/** Every `introduces`/`modifies`/`retires` edge declared by a CHG whose relation entries passed shape/vocabulary validation. */
	chgEffects: ChgEffectEdge[]
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeValDiagnostic(code: 'EF-VAL-004' | 'EF-VAL-007', message: string, path?: string, artifactId?: string): Diagnostic {
	return { code, severity: severityOf(code), message, path, artifactId, related: [] }
}

/**
 * `domain/envelope.ts` reports `EF-ENV-004` for a `relations[i]`/`resources[i]`
 * entry that is not a YAML mapping (its own documented "every entry must be a
 * mapping" rule). `domain/relations.ts`/`domain/resources.ts` independently
 * report the same "not a mapping" condition as `EF-REL-002`/`EF-RES-001` --
 * the diagnostics 09-validation.md's precedence table explicitly names as the
 * primary finding for that exact violation ("Relation entry is not a mapping
 * or lacks a required field -> EF-REL-002"). This filters out the redundant,
 * broader `EF-ENV-004` so only the more specific relation/resource-owned
 * diagnostic survives; `EF-ENV-004` for every other field (a genuinely
 * missing/malformed core field) is unaffected, since `envelope.ts` only ever
 * emits this exact `field` shape for the "not a mapping" array-entry case.
 */
const ARRAY_ENTRY_SHAPE_FIELD = /^(?:relations|resources)\[\d+\]$/

function withoutRedundantArrayEntryShapeFindings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	return diagnostics.filter(d => !(d.code === 'EF-ENV-004' && d.field !== undefined && ARRAY_ENTRY_SHAPE_FIELD.test(d.field)))
}

/** Structured-location identity, ignoring message text (mirrors `diagnostics.ts`'s own dedup key, minus `code`). */
function diagnosticShapeIdentity(d: Diagnostic): string {
	return JSON.stringify([d.path ?? null, d.artifactId ?? null, d.location ?? null, d.field ?? null, d.section ?? null])
}

// ---------------------------------------------------------------------------
// validateSnapshot
// ---------------------------------------------------------------------------

interface FileOutcome {
	path: string
	envelope: Envelope
	relations: RelationGraphArtifact['relations']
}

function fileStateFor(kind: SnapshotEntryKind | undefined): LocalResourceFileState {
	if (kind === 'file')
		return 'file'
	if (kind === 'directory')
		return 'directory'
	if (kind === 'symlink')
		return 'symlink'
	return 'missing'
}

function isExternalLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

/**
 * Whether a `draft` Artifact's body content is genuinely incomplete: rerun
 * `validateBody` as though the Artifact had reached the status whose
 * completeness rules are the strictest available for its type (`active` for
 * knowledge Artifacts, `completed` for CHG), and check whether that surfaces
 * any diagnostic the real `draft`-mode validation did not already report.
 * Comparing diagnostic identity (rather than hand-picking codes) reuses
 * `validateBody`'s own completeness logic exactly instead of duplicating it.
 */
function draftContentIsIncomplete(input: { type: ArtifactType, path: string, body: ExtractedSections }, realDiagnostics: readonly Diagnostic[]): boolean {
	const probeStatus: Status = input.type === 'change' ? 'completed' : 'active'
	const probeDiagnostics = validateBody({ type: input.type, status: probeStatus, path: input.path, body: input.body })
	const realIdentities = new Set(realDiagnostics.map(d => JSON.stringify([d.code, diagnosticShapeIdentity(d)])))
	return probeDiagnostics.some(d => !realIdentities.has(JSON.stringify([d.code, diagnosticShapeIdentity(d)])))
}

export function validateSnapshot(snapshot: ProjectSnapshot): SnapshotValidationResult {
	const diagnostics: Diagnostic[] = []
	let complete = true

	// ---- Phase 1/2/3: discovery, config, layout ----------------------------

	diagnostics.push(...snapshot.config.diagnostics)
	if (snapshot.configBytes === undefined) {
		complete = false
		diagnostics.push(makeValDiagnostic('EF-VAL-007', 'No \'.engineering/ef.yaml\' configuration was found in the validated snapshot.'))
	}
	else {
		diagnostics.push(...checkTextNormalization('.engineering/ef.yaml', snapshot.configBytes))
	}
	if (snapshot.gitignoreBytes !== undefined)
		diagnostics.push(...checkTextNormalization('.engineering/.gitignore', snapshot.gitignoreBytes))

	diagnostics.push(...snapshot.layoutDiagnostics)

	// ---- Phase 2..8 per file: parse, envelope, identity, status, relations, --
	// ---- resources, body ----------------------------------------------------

	const fileOutcomes: FileOutcome[] = []

	for (const artifact of snapshot.artifacts) {
		if (!artifact.frontmatter.ok) {
			diagnostics.push({ ...artifact.frontmatter.diagnostic, path: artifact.path })
			continue
		}

		diagnostics.push(...artifact.document!.diagnostics)

		const envelopeResult = artifact.envelope!
		diagnostics.push(...withoutRedundantArrayEntryShapeFindings(envelopeResult.diagnostics))

		if (artifact.body && !artifact.body.ok)
			diagnostics.push({ ...artifact.body.diagnostic, path: artifact.path })

		const envelope = envelopeResult.envelope
		if (!envelope)
			continue

		diagnostics.push(...validateIdSyntax({ type: envelope.type, id: envelope.id }, artifact.path))
		diagnostics.push(...validateFilename({ type: envelope.type, id: envelope.id }, artifact.path))
		diagnostics.push(...validateStatus({ type: envelope.type, status: envelope.status, id: envelope.id }, artifact.path))

		const mapping = artifact.document!.mapping
		const rawRelations = mapping ? rawArrayField(mapping, 'relations') : []
		const rawResources = mapping ? rawArrayField(mapping, 'resources') : []

		const relationResult = validateRelationEntries({ id: envelope.id, relations: rawRelations }, artifact.path)
		diagnostics.push(...relationResult.diagnostics)

		diagnostics.push(...validateResourceDescriptors({ id: envelope.id, resources: rawResources }, artifact.path))

		if (artifact.sections) {
			const bodyDiagnostics = validateBody({ type: envelope.type, status: envelope.status, path: artifact.path, body: artifact.sections })
			diagnostics.push(...bodyDiagnostics)

			if (envelope.status === 'draft' && draftContentIsIncomplete({ type: envelope.type, path: artifact.path, body: artifact.sections }, bodyDiagnostics))
				diagnostics.push(makeValDiagnostic('EF-VAL-004', `Draft content for '${envelope.id}' is incomplete, which its lifecycle status permits.`, artifact.path, envelope.id))
		}

		fileOutcomes.push({ path: artifact.path, envelope, relations: relationResult.entries })
	}

	// ---- Phase 5/6: graph construction and graph integrity ------------------

	diagnostics.push(...validateGraphIdentity(fileOutcomes.map(o => ({ id: o.envelope.id, type: o.envelope.type, path: o.path }))))

	const relationGraphArtifacts: RelationGraphArtifact[] = fileOutcomes.map(o => ({
		path: o.path,
		id: o.envelope.id,
		type: o.envelope.type,
		relations: o.relations,
	}))
	const relationById = new Map(relationGraphArtifacts.map(a => [a.id, a] as const))
	diagnostics.push(...validateRelationGraph(relationGraphArtifacts, relationById))

	const supersessionFacts: SupersessionGraphFact[] = fileOutcomes
		.filter(o => o.envelope.type !== 'change')
		.map(o => ({
			id: o.envelope.id,
			type: o.envelope.type,
			status: o.envelope.status,
			supersededBy: o.relations.filter(r => r.type === 'superseded-by')
				.map(r => r.target),
		}))
	diagnostics.push(...validateSupersessionGraph(supersessionFacts))

	const incomingRelations = new Map<string, IncomingRelationEdge[]>()
	for (const artifact of relationGraphArtifacts) {
		for (const relation of artifact.relations) {
			const edges = incomingRelations.get(relation.target) ?? []
			edges.push({ from: artifact.id, type: relation.type })
			incomingRelations.set(relation.target, edges)
		}
	}

	const currentIds = new Map<string, string[]>()
	for (const fact of supersessionFacts) {
		const result = resolveCurrent(fact.id, supersessionFacts)
		currentIds.set(fact.id, result.ok ? result.currentIds : [])
	}

	const chgEffects: ChgEffectEdge[] = []
	for (const outcome of fileOutcomes) {
		if (outcome.envelope.type !== 'change')
			continue
		for (const relation of outcome.relations) {
			if (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires')
				chgEffects.push({ chgId: outcome.envelope.id, type: relation.type, target: relation.target })
		}
	}

	// ---- Phase 7: resource integrity ----------------------------------------

	const ownershipEntries: ResourceOwnershipEntry[] = []
	const localFileEntries: LocalResourceFileEntry[] = []
	const declaredLocations = new Set<string>()
	for (const outcome of fileOutcomes) {
		for (const resource of outcome.envelope.resources) {
			if (resource.location.length === 0)
				continue
			declaredLocations.add(resource.location)
			ownershipEntries.push({ artifactId: outcome.envelope.id, path: outcome.path, location: resource.location })
			localFileEntries.push({ artifactId: outcome.envelope.id, path: outcome.path, location: resource.location })
		}
	}
	diagnostics.push(...validateResourceOwnership(ownershipEntries))

	const fileFacts = new Map<string, LocalResourceFileState>()
	for (const location of declaredLocations)
		fileFacts.set(location, fileStateFor(snapshot.entryKinds.get(location)))
	diagnostics.push(...validateLocalResourceFiles(localFileEntries, fileFacts))

	const managedRootFiles = snapshot.resourceFiles.filter(entry => entry.kind === 'file')
		.map(entry => entry.path)
	diagnostics.push(...findOrphanResourceFiles(managedRootFiles, declaredLocations))

	const resourceOwnership = new Map<string, string[]>()
	for (const entry of ownershipEntries) {
		const owners = resourceOwnership.get(entry.location) ?? []
		if (!owners.includes(entry.artifactId))
			owners.push(entry.artifactId)
		resourceOwnership.set(entry.location, owners)
	}

	// ---- Text normalization, layout, and symlink diagnostics ----------------

	for (const artifact of snapshot.artifacts)
		diagnostics.push(...checkTextNormalization(artifact.path, artifact.bytes))

	const localResourceLocations = [...declaredLocations].filter(location => !isExternalLocation(location))
	const symlinkPaths = managedSymlinkPaths({
		artifactFiles: snapshot.artifacts.map(a => a.path),
		resourceFiles: localResourceLocations,
	})
	const symlinkFacts: SymlinkFact[] = symlinkPaths.map(p => ({ path: p, isSymlink: snapshot.entryKinds.get(p) === 'symlink' }))
	diagnostics.push(...checkManagedSymlinks(symlinkFacts))

	const pathNormalizationEntries: PathNormalizationEntry[] = [
		...snapshot.artifacts.map(a => ({ path: a.path })),
		...localResourceLocations.map(location => ({ path: location })),
	]
	diagnostics.push(...checkPathNormalization(pathNormalizationEntries))

	const byId = new Map<string, SnapshotArtifactRecord>()
	for (const outcome of fileOutcomes) {
		byId.set(outcome.envelope.id, {
			path: outcome.path,
			id: outcome.envelope.id,
			type: outcome.envelope.type,
			status: outcome.envelope.status,
			envelope: outcome.envelope,
			relations: outcome.relations,
		})
	}

	return {
		diagnostics: aggregateDiagnostics(diagnostics),
		complete,
		byId,
		incomingRelations,
		resourceOwnership,
		currentIds,
		chgEffects,
	}
}

// ---------------------------------------------------------------------------
// summarizeValidation
// ---------------------------------------------------------------------------

export type ValidationScope = 'snapshot' | 'transition' | 'bootstrap'

export interface ValidationPolicy {
	strict: boolean
	warningsAsErrors: boolean
}

export interface ValidationRefs {
	baselineOid?: string | null
	proposedOid?: string | null
	integrationRef?: string | null
	expectedRefOid?: string | null
}

export interface SummarizeValidationInput {
	scope: ValidationScope
	/** Diagnostics from `validateSnapshot` (or a transition/bootstrap orchestrator); re-aggregated defensively. */
	diagnostics: readonly Diagnostic[]
	/** Whether the validator had every required context/capability for `scope` (09-validation "Validation completeness"). */
	complete: boolean
	/** Set by the caller when an internal invariant failed (`EF-VAL-008`); forces exit `3` regardless of `complete`. */
	internalFailure?: boolean
	policy: ValidationPolicy
	refs?: ValidationRefs
}

export interface ValidationCounts {
	error: number
	warning: number
	info: number
}

export interface ValidationSummary {
	scope: ValidationScope
	baselineOid: string | null
	proposedOid: string | null
	integrationRef: string | null
	expectedRefOid: string | null
	strict: boolean
	/** Effective warnings-as-errors, `true` whenever `strict` is `true` (09-validation "Strict mode is equivalent to: warnings-as-errors + ..."). */
	warningsAsErrors: boolean
	complete: boolean
	valid: boolean
	counts: ValidationCounts
	exitCode: 0 | 1 | 2 | 3
}

/**
 * Compute the 09-validation.md "Validation Summary" object: `valid`/`complete`
 * interplay, deduplicated counts, and exit-code priority
 * (`internal failure (3) > incomplete (2) > invalid findings (1) > success (0)`).
 *
 * `complete`/`internalFailure` are caller-supplied facts rather than inferred
 * from diagnostic codes: this module has no registry of which `EF-VAL-*` code
 * maps to which exit class (that mapping lives in the owning specification,
 * not in `diagnostic-codes.ts`'s severity-only table), so a caller that emits
 * an exit-class-`2` or `3` `EF-VAL-*` diagnostic MUST also set `complete:
 * false` (or `internalFailure: true`) at the same call site.
 */
export function summarizeValidation(input: SummarizeValidationInput): ValidationSummary {
	const aggregated = aggregateDiagnostics(input.diagnostics)
	const counts: ValidationCounts = { error: 0, warning: 0, info: 0 }
	for (const d of aggregated)
		counts[d.severity] += 1

	const strict = input.policy.strict
	const warningsAsErrors = input.policy.warningsAsErrors || strict
	const internalFailure = input.internalFailure ?? false
	const refs = input.refs ?? {}

	let complete: boolean
	let valid: boolean
	let exitCode: 0 | 1 | 2 | 3

	if (internalFailure) {
		complete = false
		valid = false
		exitCode = 3
	}
	else if (!input.complete) {
		complete = false
		valid = false
		exitCode = 2
	}
	else {
		complete = true
		const fails = counts.error > 0 || (counts.warning > 0 && warningsAsErrors)
		valid = !fails
		exitCode = fails ? 1 : 0
	}

	return {
		scope: input.scope,
		baselineOid: refs.baselineOid ?? null,
		proposedOid: refs.proposedOid ?? null,
		integrationRef: refs.integrationRef ?? null,
		expectedRefOid: refs.expectedRefOid ?? null,
		strict,
		warningsAsErrors,
		complete,
		valid,
		counts,
		exitCode,
	}
}
