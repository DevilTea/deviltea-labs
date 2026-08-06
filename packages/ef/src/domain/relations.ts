/**
 * Relation validation (04-relations.md).
 *
 * Three independent pure checks, matching the spec's own layering:
 *
 * 1. `validateRelationEntries` checks one Artifact's raw `relations` array in
 *    isolation: entry shape, relation vocabulary, extension fields, duplicate
 *    `(type, target)` pairs, canonical ordering, and self-relations.
 * 2. `validateRelationGraph` checks the complete project graph: target
 *    existence, source/target compatibility, and `derived-from` cycles.
 * 3. `validateNewRelationEdgeTargetStatus` checks transition-time target
 *    lifecycle constraints for newly created `addresses` and `governed-by`
 *    edges.
 *
 * These functions consume decoded values only; they never read files or
 * parse YAML themselves.
 */

import type { DiagnosticCode } from './diagnostic-codes'
import type { Diagnostic, RelatedLocation } from './diagnostics'
import type { ArtifactType, RelationEntry, RelationType, Status } from './model'
import { severityOf } from './diagnostic-codes'
import { aggregateDiagnostics } from './diagnostics'
import {
	compareBytewise,
	DERIVED_FROM_TARGETS,
	EFFECT_RELATION_TYPES,
	RELATION_COMPATIBILITY,
	RELATION_TYPES,
} from './model'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: {
		path?: string
		artifactId?: string
		field?: string
		related?: RelatedLocation[]
	} = {},
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

/** `x-<namespace>-<name>` per 01-artifact-envelope.md, reused verbatim for relation extensions. */
const EXTENSION_NAME_PATTERN = /^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/

function isExtensionFieldName(key: string): boolean {
	return EXTENSION_NAME_PATTERN.test(key)
}

/** RFC 8785 JSON-compatible value: string, number, boolean, null, array, or string-keyed mapping. */
function isJsonCompatibleValue(value: unknown): boolean {
	if (value === null)
		return true
	if (typeof value === 'string' || typeof value === 'boolean')
		return true
	if (typeof value === 'number')
		return Number.isFinite(value)
	if (Array.isArray(value))
		return value.every(isJsonCompatibleValue)
	if (typeof value === 'object') {
		return Object.values(value as Record<string, unknown>)
			.every(isJsonCompatibleValue)
	}
	return false
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownRelationType(value: string): value is RelationType {
	return (RELATION_TYPES as readonly string[]).includes(value)
}

function isEffectRelationType(value: RelationType): boolean {
	return (EFFECT_RELATION_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// validateRelationEntries
// ---------------------------------------------------------------------------

export interface RelationEntriesEnvelopeInput {
	/** Owning Artifact's exact ID, used for self-relation detection (EF-REL-005). */
	id: string
	/** Raw `relations` array items in file order, before shape decoding. */
	relations: readonly unknown[]
}

export interface RelationEntriesValidationResult {
	/** Entries with valid shape and recognized vocabulary, in file order, excluding self-relations. */
	entries: RelationEntry[]
	diagnostics: Diagnostic[]
}

/** A raw entry whose shape passed EF-REL-002 (mapping with non-empty string `type` and `target`). */
interface ShapeValidEntry {
	index: number
	type: string
	target: string
	extensions: Record<string, unknown>
	knownType: boolean
}

function entryField(index: number): string {
	return `relations[${index}]`
}

/**
 * Validate one Artifact's raw `relations` array in isolation: entry shape
 * (EF-REL-002), extension fields (EF-REL-015), relation vocabulary
 * (EF-REL-001), duplicate `(type, target)` pairs (EF-REL-006), canonical
 * array and field ordering (EF-REL-007), and self-relations (EF-REL-005).
 *
 * Per 09-validation precedence, an entry that fails EF-REL-002 is entirely
 * excluded from every other check and from the returned `entries`. An entry
 * with an unknown type (EF-REL-001) is still checked for duplicates,
 * ordering, and self-relation (those do not require known vocabulary), but is
 * excluded from the returned `entries` because its type cannot be narrowed to
 * `RelationType`. Self-relation entries are likewise excluded from the
 * returned `entries` so a trivially invalid self-loop never also surfaces as
 * a graph-level cycle finding.
 */
export function validateRelationEntries(
	envelope: RelationEntriesEnvelopeInput,
	path: string,
): RelationEntriesValidationResult {
	const diagnostics: Diagnostic[] = []
	const shapeValid: ShapeValidEntry[] = []

	envelope.relations.forEach((raw, index) => {
		const field = entryField(index)

		if (!isPlainMapping(raw)) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-002',
				'Relation entry must be a mapping with \'type\' and \'target\' fields.',
				{ path, artifactId: envelope.id, field },
			))
			return
		}

		const keys = Object.keys(raw)
		const typeValue = raw.type
		const targetValue = raw.target
		let shapeOk = true

		if (typeof typeValue !== 'string' || typeValue.length === 0) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-002',
				'Relation entry is missing a required non-empty \'type\' field.',
				{ path, artifactId: envelope.id, field: `${field}.type` },
			))
			shapeOk = false
		}

		if (typeof targetValue !== 'string' || targetValue.length === 0) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-002',
				'Relation entry is missing a required non-empty \'target\' field.',
				{ path, artifactId: envelope.id, field: `${field}.target` },
			))
			shapeOk = false
		}

		if (!shapeOk)
			return

		const extensions: Record<string, unknown> = {}
		for (const key of keys) {
			if (key === 'type' || key === 'target')
				continue

			if (!isExtensionFieldName(key)) {
				diagnostics.push(makeDiagnostic(
					'EF-REL-015',
					`Relation field '${key}' is not 'type', 'target', or a valid 'x-*' extension.`,
					{ path, artifactId: envelope.id, field: `${field}.${key}` },
				))
				continue
			}

			if (!isJsonCompatibleValue(raw[key])) {
				diagnostics.push(makeDiagnostic(
					'EF-REL-015',
					`Relation extension field '${key}' has a value that is not JSON-compatible.`,
					{ path, artifactId: envelope.id, field: `${field}.${key}` },
				))
				continue
			}

			extensions[key] = raw[key]
		}

		const type = typeValue as string
		const target = targetValue as string
		const knownType = isKnownRelationType(type)

		if (!knownType) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-001',
				`Relation type '${type}' is not a known EF Core relation type.`,
				{ path, artifactId: envelope.id, field: `${field}.type` },
			))
		}

		if (target === envelope.id) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-005',
				`Relation target '${target}' is the same as the source Artifact; self-relations are invalid.`,
				{ path, artifactId: envelope.id, field: `${field}.target` },
			))
		}

		// Field order: 'type', 'target', then recognized 'x-*' fields in
		// bytewise order. Unrecognized fields (already reported above) are
		// excluded from this comparison.
		const recognizedKeys = keys.filter(key => key === 'type' || key === 'target' || isExtensionFieldName(key))
		const extensionKeys = recognizedKeys.filter(key => key !== 'type' && key !== 'target')
		const expectedOrder = ['type', 'target', ...[...extensionKeys].sort(compareBytewise)]
		const orderMismatch = recognizedKeys.length !== expectedOrder.length
			|| recognizedKeys.some((key, i) => key !== expectedOrder[i])
		if (orderMismatch) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-007',
				'Relation entry fields are not in canonical \'type\', \'target\', \'x-*\' order.',
				{ path, artifactId: envelope.id, field },
			))
		}

		shapeValid.push({ index, type, target, extensions, knownType })
	})

	// Duplicate (type, target) detection, independent of vocabulary validity.
	const firstSeenAt = new Map<string, ShapeValidEntry>()
	for (const entry of shapeValid) {
		const key = `${entry.type} ${entry.target}`
		const first = firstSeenAt.get(key)
		if (first) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-006',
				`Relation '(${entry.type}, ${entry.target})' is a duplicate of an earlier entry.`,
				{
					path,
					artifactId: envelope.id,
					field: entryField(entry.index),
					related: [{
						path,
						artifactId: envelope.id,
						field: entryField(first.index),
						message: 'First occurrence of this relation.',
					}],
				},
			))
			continue
		}
		firstSeenAt.set(key, entry)
	}

	// Canonical array ordering by bytewise (type, target), independent of
	// vocabulary validity.
	for (let i = 1; i < shapeValid.length; i++) {
		const prev = shapeValid[i - 1]!
		const cur = shapeValid[i]!
		const cmp = compareBytewise(prev.type, cur.type) || compareBytewise(prev.target, cur.target)
		if (cmp > 0) {
			diagnostics.push(makeDiagnostic(
				'EF-REL-007',
				'Relation entries are not sorted by canonical (type, target) bytewise order.',
				{ path, artifactId: envelope.id, field: entryField(cur.index) },
			))
		}
	}

	const entries: RelationEntry[] = shapeValid
		.filter(entry => entry.knownType && entry.target !== envelope.id)
		.map(entry => ({
			type: entry.type as RelationType,
			target: entry.target,
			extensions: entry.extensions,
		}))

	return { entries, diagnostics: aggregateDiagnostics(diagnostics) }
}

// ---------------------------------------------------------------------------
// validateRelationGraph
// ---------------------------------------------------------------------------

export interface RelationGraphArtifact {
	path: string
	id: string
	type: ArtifactType
	relations: readonly RelationEntry[]
}

interface DerivedFromEdge {
	from: string
	to: string
	path: string
	index: number
}

/**
 * Validate the complete project relation graph: target existence
 * (EF-REL-003), source/target compatibility including the `derived-from`
 * refinement (EF-REL-004), and `derived-from` cycles (EF-REL-008).
 *
 * `superseded-by` source/target type mismatches are entirely the
 * supersession module's concern (EF-SUP-003) and are never reported here,
 * even though the coarse `RELATION_COMPATIBILITY` table alone could not
 * distinguish them; this validator applies no additional same-type
 * refinement for `superseded-by`. Likewise, a CHG effect relation
 * (`introduces`, `modifies`, `retires`) targeting another CHG is the CHG
 * module's concern (EF-CHG-017) and is excluded from the general
 * compatibility check here.
 */
export function validateRelationGraph(
	artifacts: readonly RelationGraphArtifact[],
	byId: ReadonlyMap<string, RelationGraphArtifact>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const derivedFromEdges: DerivedFromEdge[] = []
	const derivedFromNodes = new Set<string>()
	const nodePath = new Map<string, string>()

	for (const artifact of artifacts) {
		artifact.relations.forEach((entry, index) => {
			const target = byId.get(entry.target)

			if (!target) {
				diagnostics.push(makeDiagnostic(
					'EF-REL-003',
					`Relation target '${entry.target}' does not exist in the project graph.`,
					{ path: artifact.path, artifactId: artifact.id, field: `${entryField(index)}.target` },
				))
				return
			}

			const compat = RELATION_COMPATIBILITY[entry.type]
			const sourceOk = compat.sources.includes(artifact.type)
			const targetOk = compat.targets.includes(target.type)
			const isChgEffectTargetingChg = isEffectRelationType(entry.type) && target.type === 'change'

			if (!isChgEffectTargetingChg) {
				let incompatible = !sourceOk || !targetOk

				if (!incompatible && entry.type === 'derived-from') {
					const allowedTargets = DERIVED_FROM_TARGETS[artifact.type as 'prd' | 'requirement' | 'policy']
					incompatible = !allowedTargets.includes(target.type)
				}

				if (incompatible) {
					diagnostics.push(makeDiagnostic(
						'EF-REL-004',
						`Relation type '${entry.type}' does not allow source type '${artifact.type}' with target type '${target.type}'.`,
						{ path: artifact.path, artifactId: artifact.id, field: `${entryField(index)}.type` },
					))
				}
			}

			if (entry.type === 'derived-from') {
				derivedFromEdges.push({ from: artifact.id, to: target.id, path: artifact.path, index })
				derivedFromNodes.add(artifact.id)
				derivedFromNodes.add(target.id)
				nodePath.set(artifact.id, artifact.path)
				if (!nodePath.has(target.id))
					nodePath.set(target.id, target.path)
			}
		})
	}

	diagnostics.push(...findDerivedFromCycleDiagnostics(derivedFromNodes, derivedFromEdges, nodePath))

	return aggregateDiagnostics(diagnostics)
}

/** Tarjan's strongly-connected-components algorithm over the `derived-from` subgraph. */
function computeStronglyConnectedComponents(nodes: ReadonlySet<string>, edges: readonly DerivedFromEdge[]): Map<string, number> {
	const adjacency = new Map<string, string[]>()
	for (const node of nodes)
		adjacency.set(node, [])
	for (const edge of edges)
		adjacency.get(edge.from)!.push(edge.to)

	let counter = 0
	let sccCount = 0
	const indices = new Map<string, number>()
	const lowlink = new Map<string, number>()
	const onStack = new Set<string>()
	const stack: string[] = []
	const sccOf = new Map<string, number>()

	function strongconnect(v: string): void {
		indices.set(v, counter)
		lowlink.set(v, counter)
		counter++
		stack.push(v)
		onStack.add(v)

		for (const w of adjacency.get(v) ?? []) {
			if (!indices.has(w)) {
				strongconnect(w)
				lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
			}
			else if (onStack.has(w)) {
				lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
			}
		}

		if (lowlink.get(v) === indices.get(v)) {
			const current = sccCount++
			let w: string
			do {
				w = stack.pop()!
				onStack.delete(w)
				sccOf.set(w, current)
			} while (w !== v)
		}
	}

	for (const node of nodes) {
		if (!indices.has(node))
			strongconnect(node)
	}

	return sccOf
}

function findDerivedFromCycleDiagnostics(
	nodes: ReadonlySet<string>,
	edges: readonly DerivedFromEdge[],
	nodePath: ReadonlyMap<string, string>,
): Diagnostic[] {
	if (edges.length === 0)
		return []

	const sccOf = computeStronglyConnectedComponents(nodes, edges)
	const sccMembers = new Map<number, string[]>()
	for (const [node, scc] of sccOf) {
		const members = sccMembers.get(scc) ?? []
		members.push(node)
		sccMembers.set(scc, members)
	}

	const diagnostics: Diagnostic[] = []
	for (const edge of edges) {
		const scc = sccOf.get(edge.from)
		if (scc === undefined || sccOf.get(edge.to) !== scc)
			continue
		const members = sccMembers.get(scc) ?? []
		if (members.length < 2)
			continue

		diagnostics.push(makeDiagnostic(
			'EF-REL-008',
			`Relation target '${edge.to}' forms a 'derived-from' cycle with source '${edge.from}'.`,
			{
				path: edge.path,
				artifactId: edge.from,
				field: `${entryField(edge.index)}.target`,
				related: members
					.filter(member => member !== edge.from)
					.map(member => ({
						path: nodePath.get(member),
						artifactId: member,
						message: 'Also part of this \'derived-from\' cycle.',
					})),
			},
		))
	}

	return diagnostics
}

// ---------------------------------------------------------------------------
// validateNewRelationEdgeTargetStatus
// ---------------------------------------------------------------------------

export interface NewRelationEdge {
	path: string
	sourceId: string
	type: RelationType
	target: string
	/** Index within the source Artifact's `relations` array, for the diagnostic field path. */
	index: number
}

/**
 * Validate transition-time target lifecycle state for newly created
 * `addresses` and `governed-by` edges: a new `addresses` edge MUST target an
 * active REQ (EF-REL-017), and a new `governed-by` edge MUST target an
 * active POL (EF-REL-018). Other relation types in `newEdges` are ignored.
 *
 * When `targetStatusAt` returns `undefined` the target does not exist; that
 * condition is EF-REL-003's responsibility elsewhere, so no finding is
 * reported here for that edge.
 */
export function validateNewRelationEdgeTargetStatus(
	newEdges: readonly NewRelationEdge[],
	targetStatusAt: (target: string) => Status | undefined,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	for (const edge of newEdges) {
		if (edge.type !== 'addresses' && edge.type !== 'governed-by')
			continue

		const status = targetStatusAt(edge.target)
		if (status === undefined || status === 'active')
			continue

		const code: DiagnosticCode = edge.type === 'addresses' ? 'EF-REL-017' : 'EF-REL-018'
		const targetKind = edge.type === 'addresses' ? 'REQ' : 'POL'
		diagnostics.push(makeDiagnostic(
			code,
			`New '${edge.type}' relation must target an active ${targetKind}; '${edge.target}' has status '${status}'.`,
			{ path: edge.path, artifactId: edge.sourceId, field: `${entryField(edge.index)}.target` },
		))
	}

	return aggregateDiagnostics(diagnostics)
}
