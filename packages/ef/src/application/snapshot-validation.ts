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
	/**
	 * `false` when a parse/identity/layout condition prevents ANY query
	 * result over this snapshot from being complete and trustworthy
	 * (10-query-and-trace.md "Invalid Graph and Partial Results"): an
	 * Artifact file failed to decode, a layout entry could itself be an
	 * unparsed Artifact (`EF-FS-003`), or one of the identity findings whose
	 * ID/graph-membership consequence is untrustworthy rather than merely
	 * cosmetic -- `EF-ID-001`/`002`/`003` (the declared ID itself is
	 * malformed, wrong-prefix, or non-canonical, so whatever this file
	 * contributes to the graph is keyed on a fact that is not truly its ID),
	 * `EF-ID-004`/`006` (duplicate ID / PROJECT-singleton ambiguity), or
	 * `EF-ID-007`/`008` (PROJECT missing, or present under the wrong ID, so
	 * required project context is absent from the graph exactly as if no
	 * PROJECT existed). `EF-ID-005` (filename does not match ID) and
	 * `EF-ID-014` (file outside its canonical directory) do NOT gate: the
	 * declared ID itself is unique and decoded correctly in both cases, so
	 * `byId` and its dependent indexes remain trustworthy even though the
	 * file/layout convention is violated (that violation is reported on its
	 * own merits, independent of query trustworthiness). Callers building a
	 * `QueryContext` gate every query kind -- including exact lookup -- on
	 * this.
	 */
	graphTrustworthy: boolean
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
 * Whether `location` is a syntactically valid LOCAL Resource location
 * (06-resources.md "Location classification"/"Local path resolution"): not
 * an external HTTP(S) URL, no other URI scheme, no backslash, does not
 * escape the project root, and has no empty/`.`/`..` path segment. Narrowly
 * mirrors `domain/resources.ts`'s own `analyzeLocation` local-valid branch --
 * duplicated as a small yes/no predicate here (rather than imported) because
 * this module only needs the local-ownership question, not that function's
 * full classification result.
 *
 * 06-resources.md "External URLs do not have exclusive ownership. The same
 * URL MAY appear once in each of multiple Artifacts.": only a location this
 * predicate accepts may participate in cross-Artifact ownership tracking
 * (`EF-RES-009`) below.
 */
function isValidLocalLocation(location: string): boolean {
	if (location.length === 0 || isExternalLocation(location))
		return false
	if (location.includes(':') || location.includes('\\'))
		return false
	if (location.startsWith('/') || location.startsWith('~'))
		return false
	return !location.split('/')
		.some(segment => segment === '' || segment === '.' || segment === '..')
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
	// Whether any Artifact file could not be decoded into a `fileOutcomes`
	// entry at all (frontmatter split or envelope decode failure). A `list`,
	// `search`, or unrelated `lookup` result computed while this is `true`
	// could silently omit that Artifact from an otherwise `complete: true`
	// result (10-query-and-trace.md "Invalid Graph and Partial Results": "MUST
	// NOT return a partial ... collection that an Agent could mistake for
	// complete context"); `graphTrustworthy` below folds this into every
	// query's own completeness gate.
	let hasUndecodedArtifact = false

	for (const artifact of snapshot.artifacts) {
		if (!artifact.frontmatter.ok) {
			diagnostics.push({ ...artifact.frontmatter.diagnostic, path: artifact.path })
			hasUndecodedArtifact = true
			continue
		}

		diagnostics.push(...artifact.document!.diagnostics)

		const envelopeResult = artifact.envelope!
		diagnostics.push(...withoutRedundantArrayEntryShapeFindings(envelopeResult.diagnostics))

		if (artifact.body && !artifact.body.ok)
			diagnostics.push({ ...artifact.body.diagnostic, path: artifact.path })

		const envelope = envelopeResult.envelope
		if (!envelope) {
			hasUndecodedArtifact = true
			continue
		}

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

	// 02-identity.md "Duplicate handling": "graph validation MUST NOT resolve
	// the ID to either file; tooling MUST NOT infer a canonical copy." Count
	// every declared ID first so every dependent index below -- `byId`,
	// relation-graph/supersession construction, `incomingRelations`,
	// `currentIds`, and `chgEffects` -- can exclude an ambiguous ID entirely
	// instead of the prior code silently keeping an arbitrary one of the
	// colliding files (a `Map` construction overwrites earlier entries for a
	// repeated key). A relation entry that TARGETS an ambiguous ID is excluded
	// the same way its target's own outgoing relations are: reporting it as a
	// dangling target (`EF-REL-003`) would be a speculative secondary
	// diagnostic once `EF-ID-004` already reports the collision
	// (09-validation.md "Cascading Diagnostics").
	const idCounts = new Map<string, number>()
	for (const outcome of fileOutcomes)
		idCounts.set(outcome.envelope.id, (idCounts.get(outcome.envelope.id) ?? 0) + 1)
	const ambiguousIds = new Set<string>([...idCounts.entries()].filter(([, count]) => count > 1)
		.map(([id]) => id))

	const resolvedOutcomes = fileOutcomes.filter(o => !ambiguousIds.has(o.envelope.id))

	function withoutAmbiguousTargets(relations: RelationGraphArtifact['relations']): RelationGraphArtifact['relations'] {
		return relations.filter(r => !ambiguousIds.has(r.target))
	}

	const relationGraphArtifacts: RelationGraphArtifact[] = resolvedOutcomes.map(o => ({
		path: o.path,
		id: o.envelope.id,
		type: o.envelope.type,
		relations: withoutAmbiguousTargets(o.relations),
	}))
	const relationById = new Map(relationGraphArtifacts.map(a => [a.id, a] as const))
	diagnostics.push(...validateRelationGraph(relationGraphArtifacts, relationById))

	const supersessionFacts: SupersessionGraphFact[] = resolvedOutcomes
		.filter(o => o.envelope.type !== 'change')
		.map(o => ({
			id: o.envelope.id,
			type: o.envelope.type,
			status: o.envelope.status,
			supersededBy: withoutAmbiguousTargets(o.relations)
				.filter(r => r.type === 'superseded-by')
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
	for (const outcome of resolvedOutcomes) {
		if (outcome.envelope.type !== 'change')
			continue
		for (const relation of withoutAmbiguousTargets(outcome.relations)) {
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
			// Only a syntactically valid LOCAL location is exclusively owned
			// (06-resources.md); an external URL, or the same URL declared by
			// several Artifacts, must not be reported as EF-RES-009. The
			// within-one-Artifact duplicate-location check (`EF-RES-008`)
			// already covers every location -- local or external -- inside
			// `validateResourceDescriptors` and is unaffected by this filter.
			if (isValidLocalLocation(resource.location))
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

	// 11-filesystem-and-config.md "exact filesystem case": resolve each
	// declared local Resource location to its discovered case-preserving path
	// -- already captured, verbatim from the walked filesystem, as
	// `snapshot.entryKinds`' keys -- so `checkPathNormalization` can compare
	// declared case against actual case and report `EF-FS-006` for a
	// wrong-case descriptor, instead of that mismatch only ever surfacing (if
	// at all) as an ordinary EF-RES-006 "missing" finding. Artifact files
	// need no such resolution: `snapshot.artifacts[].path` already IS the
	// walked, case-preserving path used to read them.
	const discoveredPathsByLowercase = new Map<string, string>()
	for (const discoveredPath of snapshot.entryKinds.keys()) {
		const key = discoveredPath.toLowerCase()
		if (!discoveredPathsByLowercase.has(key))
			discoveredPathsByLowercase.set(key, discoveredPath)
	}
	function resolveActualPath(location: string): string | undefined {
		return discoveredPathsByLowercase.get(location.toLowerCase())
	}

	const pathNormalizationEntries: PathNormalizationEntry[] = [
		...snapshot.artifacts.map(a => ({ path: a.path })),
		...localResourceLocations.map(location => ({ path: location, actualPath: resolveActualPath(location) })),
	]
	diagnostics.push(...checkPathNormalization(pathNormalizationEntries))

	const byId = new Map<string, SnapshotArtifactRecord>()
	for (const outcome of resolvedOutcomes) {
		byId.set(outcome.envelope.id, {
			path: outcome.path,
			id: outcome.envelope.id,
			type: outcome.envelope.type,
			status: outcome.envelope.status,
			envelope: outcome.envelope,
			relations: outcome.relations,
		})
	}

	// 10-query-and-trace.md "Invalid Graph and Partial Results": a query
	// result is untrustworthy whenever an error condition prevented an
	// Artifact file from being decoded (`hasUndecodedArtifact`), flagged a
	// layout entry that could itself be an unparsed Artifact (`EF-FS-003`),
	// or made the graph's identity/membership facts themselves untrustworthy:
	//
	// - `EF-ID-004` (duplicate ID) / `EF-ID-006` (more than one PROJECT):
	//   ambiguity -- graph validation deliberately excludes the colliding
	//   ID from `byId` rather than picking one file, so any query result
	//   naming or omitting it would be a guess.
	// - `EF-ID-007` (no PROJECT Artifact) / `EF-ID-008` (PROJECT declares an
	//   ID other than `PROJECT`): required PROJECT context is absent from the
	//   graph. Without this, `lookup PROJECT` would return the ordinary
	//   `complete: true, found: false` result and `list`/`search` would
	//   return an otherwise-"complete" collection, even though mandatory
	//   project context never loaded.
	// - `EF-ID-001`/`002`/`003` (ID missing/malformed, wrong type prefix, or
	//   non-canonical numeric component): the file's own declared identity is
	//   defective, so whatever it contributed to `byId`/relation/supersession
	//   indexes is keyed on a fact that was never truly its ID -- the same
	//   graph-membership untrustworthiness `EF-ID-004`/`006` already gate on.
	//
	// `EF-ID-005` (filename does not match ID) and `EF-ID-014` (file outside
	// its canonical directory) are deliberately excluded: in both cases the
	// declared ID itself is unique and decoded correctly, so `byId` and every
	// dependent index remain trustworthy even though the file/layout
	// convention is violated -- that violation is reported on its own merits
	// and does not need to block every query kind. Every other diagnostic
	// (body-schema, resource, ordering warnings, ...) likewise leaves every
	// already-decoded Artifact in the graph and does not affect this.
	const BLOCKING_IDENTITY_OR_LAYOUT_CODES = new Set<string>([
		'EF-ID-001',
		'EF-ID-002',
		'EF-ID-003',
		'EF-ID-004',
		'EF-ID-006',
		'EF-ID-007',
		'EF-ID-008',
		'EF-FS-003',
	])
	const hasBlockingIdentityOrLayoutFinding = diagnostics.some(d => BLOCKING_IDENTITY_OR_LAYOUT_CODES.has(d.code))
	const graphTrustworthy = !hasUndecodedArtifact && !hasBlockingIdentityOrLayoutFinding

	return {
		diagnostics: aggregateDiagnostics(diagnostics),
		complete,
		byId,
		incomingRelations,
		resourceOwnership,
		currentIds,
		chgEffects,
		graphTrustworthy,
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
