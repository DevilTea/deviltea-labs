/**
 * EF Core supersession topology and current-resolution validation
 * (docs/ef-core/05-supersession.md).
 *
 * Pure functions only: every input arrives as prepared graph facts supplied
 * by the caller (decoded envelopes reduced to the fields this module needs).
 * No filesystem or process access happens here.
 */

import type { Diagnostic, RelatedLocation } from './diagnostics'
import type { ArtifactType, Status } from './model'
import { severityOf } from './diagnostic-codes'
import { compareBytewise } from './model'

/** One Artifact's supersession-relevant facts, reduced from its envelope. */
export interface SupersessionGraphFact {
	id: string
	type: ArtifactType
	status: Status
	/** Direct outgoing `superseded-by` targets, in stored order. */
	supersededBy: readonly string[]
}

function byId(graph: readonly SupersessionGraphFact[]): Map<string, SupersessionGraphFact> {
	return new Map(graph.map(node => [node.id, node] as const))
}

function related(artifactId: string, message: string): RelatedLocation {
	return { artifactId, message }
}

/**
 * Rotates a cycle path so it starts at its bytewise-smallest Artifact ID,
 * giving every equivalent traversal of the same cycle an identical
 * representation for deduplication.
 */
function rotateToMin(path: readonly string[]): string[] {
	let minIndex = 0
	for (let i = 1; i < path.length; i++) {
		if (compareBytewise(path[i]!, path[minIndex]!) < 0)
			minIndex = i
	}
	return [...path.slice(minIndex), ...path.slice(0, minIndex)]
}

/**
 * Finds every direct or indirect `superseded-by` cycle reachable in `graph`,
 * including self-replacement. Each cycle is returned once, as the ordered
 * list of participant IDs starting at the bytewise-smallest ID.
 */
function detectCycles(nodes: Map<string, SupersessionGraphFact>): string[][] {
	const state = new Map<string, 'visiting' | 'done'>()
	const stack: string[] = []
	const cycles: string[][] = []
	const seen = new Set<string>()

	function visit(id: string): void {
		const node = nodes.get(id)
		if (!node)
			return
		state.set(id, 'visiting')
		stack.push(id)

		for (const targetId of node.supersededBy) {
			const targetState = state.get(targetId)
			if (targetState === 'visiting') {
				const idx = stack.indexOf(targetId)
				const cycle = rotateToMin(stack.slice(idx))
				const key = cycle.join('>')
				if (!seen.has(key)) {
					seen.add(key)
					cycles.push(cycle)
				}
				continue
			}
			if (targetState !== 'done' && nodes.has(targetId))
				visit(targetId)
		}

		stack.pop()
		state.set(id, 'done')
	}

	for (const id of [...nodes.keys()].sort(compareBytewise)) {
		if (!state.has(id))
			visit(id)
	}

	return cycles
}

/**
 * Validates supersession topology over the complete current graph
 * (05-supersession Rules: "Supersession invariants", "Cycle prohibition").
 *
 * Checks that do not depend on a before/after transition:
 * - `EF-SUP-001` a `superseded` Artifact has no direct replacement.
 * - `EF-SUP-002` a non-`superseded` Artifact declares `superseded-by`.
 * - `EF-SUP-003` a source and one of its direct replacements have different types.
 * - `EF-SUP-005` a direct or indirect supersession cycle exists.
 *
 * A `superseded-by` target absent from `graph` is not flagged here: target
 * existence is a relations-layer concern (`EF-REL-*`), not supersession
 * topology.
 */
export function validateSupersessionGraph(graph: readonly SupersessionGraphFact[]): Diagnostic[] {
	const nodes = byId(graph)
	const diagnostics: Diagnostic[] = []

	for (const node of graph) {
		if (node.status === 'superseded' && node.supersededBy.length === 0) {
			diagnostics.push({
				code: 'EF-SUP-001',
				severity: severityOf('EF-SUP-001'),
				message: `Superseded Artifact "${node.id}" has no direct replacement.`,
				artifactId: node.id,
				related: [],
			})
		}

		if (node.status !== 'superseded' && node.supersededBy.length > 0) {
			diagnostics.push({
				code: 'EF-SUP-002',
				severity: severityOf('EF-SUP-002'),
				message: `Non-superseded Artifact "${node.id}" (status: "${node.status}") declares a "superseded-by" relation.`,
				artifactId: node.id,
				related: [],
			})
		}

		for (const targetId of node.supersededBy) {
			const target = nodes.get(targetId)
			if (!target)
				continue
			if (target.type !== node.type) {
				diagnostics.push({
					code: 'EF-SUP-003',
					severity: severityOf('EF-SUP-003'),
					message: `Source "${node.id}" (${node.type}) and replacement "${targetId}" (${target.type}) have different Artifact types.`,
					artifactId: node.id,
					related: [related(targetId, `Replacement type: "${target.type}".`)],
				})
			}
		}
	}

	for (const cycle of detectCycles(nodes)) {
		diagnostics.push({
			code: 'EF-SUP-005',
			severity: severityOf('EF-SUP-005'),
			message: `Supersession cycle detected: ${[...cycle, cycle[0]].join(' -> ')}.`,
			artifactId: cycle[0],
			related: cycle.slice(1)
				.map(id => related(id, 'Participates in the cycle.')),
		})
	}

	return diagnostics
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

export interface SupersessionTransitionInput {
	/** The trusted graph immediately before the proposed atomic transition. */
	before: readonly SupersessionGraphFact[]
	/** The proposed graph immediately after the atomic transition completes. */
	after: readonly SupersessionGraphFact[]
}

/**
 * Validates a proposed atomic supersession transition against the previous
 * authoritative graph (05-supersession Rules: "Atomic supersession mutation",
 * "Complete and immutable replacement set").
 *
 * - `EF-SUP-004` a source that became `superseded` in this transition has a
 *   direct replacement that is not `active` in the resulting graph.
 * - `EF-SUP-007` a source that was already `superseded` before this
 *   transition had its frozen replacement set added to, removed from,
 *   reordered, or retargeted.
 *
 * A replacement's later independent lifecycle change (for example a
 * replacement retiring after an earlier, already-completed supersession)
 * does not retroactively violate that earlier transition and is not flagged
 * (05-supersession Examples: "Retired replacement leaves").
 */
export function validateSupersessionTransition(input: SupersessionTransitionInput): Diagnostic[] {
	const { before, after } = input
	const beforeById = byId(before)
	const afterById = byId(after)
	const diagnostics: Diagnostic[] = []

	for (const node of after) {
		const priorStatus = beforeById.get(node.id)?.status
		const becameSuperseded = node.status === 'superseded' && priorStatus !== 'superseded'
		if (!becameSuperseded)
			continue

		for (const targetId of node.supersededBy) {
			const target = afterById.get(targetId)
			if (target?.status === 'active')
				continue
			diagnostics.push({
				code: 'EF-SUP-004',
				severity: severityOf('EF-SUP-004'),
				message: `Direct replacement "${targetId}" for source "${node.id}" is not active when the transition completes.`,
				artifactId: node.id,
				related: [related(targetId, target ? `Status at completion: "${target.status}".` : 'Not found in the resulting graph.')],
			})
		}
	}

	for (const [id, priorNode] of beforeById) {
		if (priorNode.status !== 'superseded')
			continue
		const nextNode = afterById.get(id)
		if (!nextNode)
			continue
		if (!arraysEqual(priorNode.supersededBy, nextNode.supersededBy)) {
			diagnostics.push({
				code: 'EF-SUP-007',
				severity: severityOf('EF-SUP-007'),
				message: `Frozen replacement set for "${id}" was modified after its terminal transition.`,
				artifactId: id,
				related: [],
			})
		}
	}

	return diagnostics
}

export type ResolveCurrentFailureReason = 'unknown-root' | 'unsupported-type' | 'invalid-graph' | 'cycle'

export interface ResolveCurrentFailure {
	ok: false
	reason: ResolveCurrentFailureReason
	message: string
}

export interface ResolveCurrentSuccess {
	ok: true
	inputId: string
	/** Deduplicated, bytewise-sorted Artifact IDs current resolution reaches (05-supersession Current-resolution algorithm). */
	currentIds: string[]
	/** The exact input Artifact and every replacement visited during resolution, bytewise sorted by ID. */
	nodes: SupersessionGraphFact[]
	/** Exactly the direct `superseded-by` edges traversed, in traversal order. */
	edges: { from: string, to: string }[]
}

export type ResolveCurrentResult = ResolveCurrentSuccess | ResolveCurrentFailure

/**
 * Implements the current-resolution algorithm (05-supersession
 * "Current-resolution algorithm"):
 *
 * ```text
 * resolve-current(A):
 *   if A.status is active:      return {A}
 *   if A.status is superseded:  return union(resolve-current(T) for each direct replacement T)
 *   if A.status is draft/retired: return {}
 * ```
 *
 * CHG resolution is an unsupported operation. An unknown root, a missing
 * node referenced by a `superseded-by` edge, an unrecognized status, or any
 * reachable cycle fails the whole resolution rather than returning a partial
 * result (05-supersession: "An invalid or incomplete graph causes resolution
 * to fail rather than return a partial result that appears authoritative.").
 */
export function resolveCurrent(id: string, graph: readonly SupersessionGraphFact[]): ResolveCurrentResult {
	const nodes = byId(graph)
	const root = nodes.get(id)
	if (!root) {
		return {
			ok: false,
			reason: 'unknown-root',
			message: `Artifact "${id}" was not found in the supplied graph.`,
		}
	}
	if (root.type === 'change') {
		return {
			ok: false,
			reason: 'unsupported-type',
			message: `Current resolution of a CHG ("${id}") is an unsupported operation.`,
		}
	}

	const visitedNodes = new Map<string, SupersessionGraphFact>()
	const edges: { from: string, to: string }[] = []
	const activeLeaves = new Set<string>()
	const state = new Map<string, 'visiting' | 'done'>()
	const stack: string[] = []
	let failure: ResolveCurrentFailure | undefined

	function visit(nodeId: string): void {
		if (failure)
			return
		const node = nodes.get(nodeId)
		if (!node) {
			failure = {
				ok: false,
				reason: 'invalid-graph',
				message: `Artifact "${nodeId}" referenced by "superseded-by" was not found in the supplied graph.`,
			}
			return
		}

		visitedNodes.set(nodeId, node)
		state.set(nodeId, 'visiting')
		stack.push(nodeId)

		if (node.status === 'active') {
			activeLeaves.add(nodeId)
		}
		else if (node.status === 'superseded') {
			for (const targetId of node.supersededBy) {
				if (failure)
					return
				edges.push({ from: nodeId, to: targetId })
				const targetState = state.get(targetId)
				if (targetState === 'visiting') {
					failure = {
						ok: false,
						reason: 'cycle',
						message: `Supersession cycle detected while resolving "${id}": "${nodeId}" -> "${targetId}" closes the cycle.`,
					}
					return
				}
				if (targetState !== 'done')
					visit(targetId)
			}
		}
		else if (node.status === 'draft' || node.status === 'retired') {
			// Resolves to the empty set; no further traversal.
		}
		else {
			failure = {
				ok: false,
				reason: 'invalid-graph',
				message: `Artifact "${nodeId}" has an unrecognized lifecycle status.`,
			}
			return
		}

		if (failure)
			return
		stack.pop()
		state.set(nodeId, 'done')
	}

	visit(id)

	if (failure)
		return failure

	return {
		ok: true,
		inputId: id,
		currentIds: [...activeLeaves].sort(compareBytewise),
		nodes: [...visitedNodes.values()].sort((a, b) => compareBytewise(a.id, b.id)),
		edges,
	}
}
