import type { ArtifactType, Envelope, RelationEntry, Status } from '../domain/model'
import type { IncomingRelationEdge, SnapshotArtifactRecord } from './snapshot-validation'
import { describe, expect, it } from 'vitest'
import {
	buildNodeSummaries,
	buildSupersessionFacts,
	dedupeSortEdges,
	dedupeSortIds,
	directRelations,
	impactGraph,
	inducedEdges,
	mergeResolveCurrentResults,
	resolveCurrentForQuery,
	traceGraph,
} from './query-graph'

function rel(type: RelationEntry['type'], target: string): RelationEntry {
	return { type, target, extensions: {} }
}

function record(id: string, type: ArtifactType, status: Status, relations: RelationEntry[] = []): SnapshotArtifactRecord {
	const envelope: Envelope = {
		schema: `ef/${type}@1`,
		type,
		id,
		title: `Title of ${id}`,
		status,
		summary: `Summary of ${id}.`,
		tags: [],
		relations,
		resources: [],
		extensions: {},
	}
	return { path: `path/${id}.md`, id, type, status, envelope, relations }
}

/**
 * A small rich graph:
 *
 * PROJECT (active)
 * PRD-001 (active)
 * REQ-001 (active)   --derived-from--> PRD-001
 * REQ-002 (active)   --derived-from--> PRD-001, --references--> REQ-001
 * REQ-003 (superseded) --superseded-by--> REQ-004
 * REQ-004 (active)
 * ADR-001 (active)   --addresses--> REQ-001
 * POL-001 (active)
 * REQ-005 (active)   --governed-by--> POL-001
 * REQ-006 (draft)    --derived-from--> PRD-001 (used for impact non-current pruning)
 * CHG-001 (completed) --modifies--> REQ-001
 */
function buildGraph(): { byId: Map<string, SnapshotArtifactRecord>, incoming: Map<string, IncomingRelationEdge[]> } {
	const records = [
		record('PROJECT', 'project', 'active'),
		record('PRD-001', 'prd', 'active'),
		record('REQ-001', 'requirement', 'active', [rel('derived-from', 'PRD-001')]),
		record('REQ-002', 'requirement', 'active', [rel('derived-from', 'PRD-001'), rel('references', 'REQ-001')]),
		record('REQ-003', 'requirement', 'superseded', [rel('superseded-by', 'REQ-004')]),
		record('REQ-004', 'requirement', 'active'),
		record('ADR-001', 'decision', 'active', [rel('addresses', 'REQ-001')]),
		record('POL-001', 'policy', 'active'),
		record('REQ-005', 'requirement', 'active', [rel('governed-by', 'POL-001')]),
		record('REQ-006', 'requirement', 'draft', [rel('derived-from', 'PRD-001')]),
		record('CHG-001', 'change', 'completed', [rel('modifies', 'REQ-001')]),
	]
	const byId = new Map(records.map(r => [r.id, r] as const))
	const incoming = new Map<string, IncomingRelationEdge[]>()
	for (const r of records) {
		for (const relation of r.relations) {
			const list = incoming.get(relation.target) ?? []
			list.push({ from: r.id, type: relation.type })
			incoming.set(relation.target, list)
		}
	}
	return { byId, incoming }
}

describe('dedupeSortEdges / dedupeSortIds', () => {
	it('deduplicates and sorts edges by (source, type, target) bytewise', () => {
		const edges = dedupeSortEdges([
			{ source: 'REQ-002', type: 'derived-from', target: 'PRD-001' },
			{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
			{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
		])
		expect(edges)
			.toEqual([
				{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
				{ source: 'REQ-002', type: 'derived-from', target: 'PRD-001' },
			])
	})

	it('deduplicates and bytewise-sorts IDs', () => {
		expect(dedupeSortIds(['REQ-002', 'REQ-001', 'REQ-001']))
			.toEqual(['REQ-001', 'REQ-002'])
	})

	it('falls through to comparing target when source and type both tie', () => {
		const edges = dedupeSortEdges([
			{ source: 'A', type: 'derived-from', target: 'Z' },
			{ source: 'A', type: 'derived-from', target: 'B' },
		])
		expect(edges)
			.toEqual([
				{ source: 'A', type: 'derived-from', target: 'B' },
				{ source: 'A', type: 'derived-from', target: 'Z' },
			])
	})
})

describe('inducedEdges', () => {
	it('includes only edges whose both endpoints are in the node set', () => {
		const { byId } = buildGraph()
		const edges = inducedEdges(new Set(['REQ-001', 'REQ-002', 'PRD-001']), new Set(['derived-from', 'references']), byId)
		expect(edges)
			.toEqual([
				{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
				{ source: 'REQ-002', type: 'derived-from', target: 'PRD-001' },
				{ source: 'REQ-002', type: 'references', target: 'REQ-001' },
			])
	})

	it('skips a node ID absent from byId instead of throwing', () => {
		const { byId } = buildGraph()
		const edges = inducedEdges(new Set(['REQ-001', 'GHOST', 'PRD-001']), new Set(['derived-from']), byId)
		expect(edges)
			.toEqual([{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' }])
	})
})

describe('directRelations', () => {
	it('returns outgoing + incoming edges and every opposite endpoint as a node, both directions by default', () => {
		const { byId, incoming } = buildGraph()
		const result = directRelations('REQ-001', 'both', new Set(['derived-from', 'references', 'addresses', 'modifies']), byId, incoming)
		expect(result)
			.toBeDefined()
		expect(result!.edges)
			.toEqual([
				{ source: 'ADR-001', type: 'addresses', target: 'REQ-001' },
				{ source: 'CHG-001', type: 'modifies', target: 'REQ-001' },
				{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
				{ source: 'REQ-002', type: 'references', target: 'REQ-001' },
			])
		expect(result!.nodeIds)
			.toEqual(['ADR-001', 'CHG-001', 'PRD-001', 'REQ-001', 'REQ-002'])
	})

	it('an Artifact with no matching edge still appears as the sole node', () => {
		const { byId, incoming } = buildGraph()
		const result = directRelations('POL-001', 'outgoing', new Set(['derived-from']), byId, incoming)
		expect(result)
			.toEqual({ edges: [], nodeIds: ['POL-001'] })
	})

	it('outgoing direction only follows the artifact\'s own outgoing edges', () => {
		const { byId, incoming } = buildGraph()
		const result = directRelations('REQ-001', 'outgoing', new Set(['derived-from', 'addresses']), byId, incoming)
		expect(result!.edges)
			.toEqual([{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' }])
	})

	it('incoming direction only follows edges targeting the artifact', () => {
		const { byId, incoming } = buildGraph()
		const result = directRelations('REQ-001', 'incoming', new Set(['derived-from', 'addresses']), byId, incoming)
		expect(result!.edges)
			.toEqual([{ source: 'ADR-001', type: 'addresses', target: 'REQ-001' }])
	})

	it('returns undefined when a returned edge references a dangling (non-existent) target', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['REQ-001', record('REQ-001', 'requirement', 'active', [rel('derived-from', 'PRD-999')])],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>()
		const result = directRelations('REQ-001', 'outgoing', new Set(['derived-from']), byId, incoming)
		expect(result)
			.toBeUndefined()
	})
})

describe('traceGraph', () => {
	it('performs breadth-first traversal, recording shortest depth per node', () => {
		const { byId, incoming } = buildGraph()
		const result = traceGraph(['PRD-001'], 'incoming', new Set(['derived-from']), 4, byId, incoming)
		expect(result)
			.toBeDefined()
		expect([...result!.depths.entries()].sort())
			.toEqual([['PRD-001', 0], ['REQ-001', 1], ['REQ-002', 1], ['REQ-006', 1]])
	})

	it('max_depth 0 returns only roots and no edges', () => {
		const { byId, incoming } = buildGraph()
		const result = traceGraph(['PRD-001', 'REQ-001'], 'both', new Set(['derived-from']), 0, byId, incoming)
		expect(result)
			.toEqual({ depths: new Map([['PRD-001', 0], ['REQ-001', 0]]), edges: [] })
	})

	it('includes every stored edge of a selected type between visited nodes, not just BFS-tree edges', () => {
		const { byId, incoming } = buildGraph()
		// REQ-002 --references--> REQ-001 is not a derived-from edge, so
		// tracing only "derived-from" from PRD-001 must not include it, but
		// once both endpoints are visited via derived-from, a *references*
		// trace from the same roots should surface it if requested.
		const result = traceGraph(['REQ-001', 'REQ-002'], 'both', new Set(['references']), 1, byId, incoming)
		expect(result!.edges)
			.toEqual([{ source: 'REQ-002', type: 'references', target: 'REQ-001' }])
	})

	it('deduplicates and sorts roots', () => {
		const { byId, incoming } = buildGraph()
		const result = traceGraph(['REQ-002', 'REQ-001', 'REQ-001'], 'outgoing', new Set(['derived-from']), 0, byId, incoming)
		expect([...result!.depths.keys()].sort())
			.toEqual(['REQ-001', 'REQ-002'])
	})

	it('returns undefined for a dangling relation target reached during traversal', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['REQ-001', record('REQ-001', 'requirement', 'active', [rel('derived-from', 'PRD-999')])],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>()
		const result = traceGraph(['REQ-001'], 'outgoing', new Set(['derived-from']), 3, byId, incoming)
		expect(result)
			.toBeUndefined()
	})

	it('stops expanding once a queued node\'s depth reaches max_depth', () => {
		const { byId, incoming } = buildGraph()
		// PRD-001 (depth 0) --incoming derived-from--> REQ-001/REQ-002/REQ-006
		// (depth 1). With max_depth 1, those depth-1 nodes must be enqueued (for
		// correct depth bookkeeping) but never expanded further.
		const result = traceGraph(['PRD-001'], 'incoming', new Set(['derived-from']), 1, byId, incoming)
		expect([...result!.depths.entries()].sort())
			.toEqual([['PRD-001', 0], ['REQ-001', 1], ['REQ-002', 1], ['REQ-006', 1]])
	})

	it('tolerates a root Artifact ID absent from byId, discovering no neighbors for it', () => {
		const { byId, incoming } = buildGraph()
		const result = traceGraph(['GHOST-ROOT'], 'outgoing', new Set(['derived-from']), 2, byId, incoming)
		expect(result)
			.toEqual({ depths: new Map([['GHOST-ROOT', 0]]), edges: [] })
	})

	it('supports cyclic relation types (e.g. references) without infinite traversal', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['A', record('A', 'requirement', 'active', [rel('references', 'B')])],
			['B', record('B', 'requirement', 'active', [rel('references', 'A')])],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>([
			['A', [{ from: 'B', type: 'references' }]],
			['B', [{ from: 'A', type: 'references' }]],
		])
		const result = traceGraph(['A'], 'both', new Set(['references']), 5, byId, incoming)
		expect([...result!.depths.entries()].sort())
			.toEqual([['A', 0], ['B', 1]])
	})
})

describe('impactGraph', () => {
	it('only active candidates advance traversal and appear by default', () => {
		const { byId, incoming } = buildGraph()
		// PRD-001 <- derived-from - REQ-001 (active), REQ-002 (active), REQ-006 (draft)
		const result = impactGraph(['PRD-001'], new Set(['derived-from']), 4, false, byId, incoming)
		expect(result)
			.toBeDefined()
		// All three are discovered (for correct depth tracking) ...
		expect([...result!.depths.keys()].sort())
			.toEqual(['PRD-001', 'REQ-001', 'REQ-002', 'REQ-006'])
		// ... but only the root and active candidates are included by default.
		expect([...result!.includedIds].sort())
			.toEqual(['PRD-001', 'REQ-001', 'REQ-002'])
	})

	it('includeNonCurrent keeps non-active candidates in the result and lets them advance traversal', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['PRD-001', record('PRD-001', 'prd', 'active')],
			['REQ-DRAFT', record('REQ-DRAFT', 'requirement', 'draft', [rel('derived-from', 'PRD-001')])],
			['REQ-FURTHER', record('REQ-FURTHER', 'requirement', 'active', [rel('derived-from', 'REQ-DRAFT')])],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>([
			['PRD-001', [{ from: 'REQ-DRAFT', type: 'derived-from' }]],
			['REQ-DRAFT', [{ from: 'REQ-FURTHER', type: 'derived-from' }]],
		])

		const defaultResult = impactGraph(['PRD-001'], new Set(['derived-from']), 4, false, byId, incoming)
		// REQ-DRAFT does not advance traversal by default, so REQ-FURTHER is never discovered.
		expect([...defaultResult!.depths.keys()].sort())
			.toEqual(['PRD-001', 'REQ-DRAFT'])
		expect([...defaultResult!.includedIds].sort())
			.toEqual(['PRD-001'])

		const includeResult = impactGraph(['PRD-001'], new Set(['derived-from']), 4, true, byId, incoming)
		expect([...includeResult!.includedIds].sort())
			.toEqual(['PRD-001', 'REQ-DRAFT', 'REQ-FURTHER'])
	})

	it('roots are context nodes at depth 0 regardless of their own status', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['REQ-DRAFT-ROOT', record('REQ-DRAFT-ROOT', 'requirement', 'draft')],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>()
		const result = impactGraph(['REQ-DRAFT-ROOT'], new Set(['derived-from']), 4, false, byId, incoming)
		expect([...result!.includedIds])
			.toEqual(['REQ-DRAFT-ROOT'])
	})

	it('returns undefined for a dangling incoming reference', () => {
		const byId = new Map<string, SnapshotArtifactRecord>()
		const incoming = new Map<string, IncomingRelationEdge[]>([
			['POL-001', [{ from: 'REQ-GHOST', type: 'governed-by' }]],
		])
		byId.set('POL-001', record('POL-001', 'policy', 'active'))
		const result = impactGraph(['POL-001'], new Set(['governed-by']), 4, false, byId, incoming)
		expect(result)
			.toBeUndefined()
	})

	it('discovers a reconvergent node only once, via whichever path reaches it first', () => {
		// Diamond: ROOT <-t- A <-t- COMMON, ROOT <-t- B <-t- COMMON. COMMON is
		// reachable from ROOT via both A and B; the second arrival must not
		// re-enqueue or overwrite its already-recorded depth.
		const byId = new Map<string, SnapshotArtifactRecord>([
			['ROOT', record('ROOT', 'policy', 'active')],
			['A', record('A', 'requirement', 'active')],
			['B', record('B', 'requirement', 'active')],
			['COMMON', record('COMMON', 'requirement', 'active')],
		])
		const incoming = new Map<string, IncomingRelationEdge[]>([
			['ROOT', [{ from: 'A', type: 'governed-by' }, { from: 'B', type: 'governed-by' }]],
			['A', [{ from: 'COMMON', type: 'governed-by' }]],
			['B', [{ from: 'COMMON', type: 'governed-by' }]],
		])
		const result = impactGraph(['ROOT'], new Set(['governed-by']), 4, false, byId, incoming)
		expect(result)
			.toBeDefined()
		expect([...result!.depths.entries()].sort())
			.toEqual([['A', 1], ['B', 1], ['COMMON', 2], ['ROOT', 0]])
	})
})

describe('resolveCurrentForQuery / mergeResolveCurrentResults', () => {
	it('resolves an active Artifact to itself', () => {
		const { byId } = buildGraph()
		const facts = buildSupersessionFacts(byId)
		const outcome = resolveCurrentForQuery('REQ-001', facts)
		expect(outcome)
			.toEqual({ ok: true, result: { currentIds: ['REQ-001'], nodeIds: ['REQ-001'], edges: [] } })
	})

	it('resolves a superseded Artifact through its replacement', () => {
		const { byId } = buildGraph()
		const facts = buildSupersessionFacts(byId)
		const outcome = resolveCurrentForQuery('REQ-003', facts)
		expect(outcome.ok)
			.toBe(true)
		if (outcome.ok) {
			expect(outcome.result.currentIds)
				.toEqual(['REQ-004'])
			expect(outcome.result.edges)
				.toEqual([{ source: 'REQ-003', type: 'superseded-by', target: 'REQ-004' }])
		}
	})

	it('reports invalid-graph (not unsupported-type) for a dangling supersession replacement', () => {
		const byId = new Map<string, SnapshotArtifactRecord>([
			['REQ-GHOST-SUP', record('REQ-GHOST-SUP', 'requirement', 'superseded', [rel('superseded-by', 'REQ-GHOST-REPLACEMENT')])],
		])
		const facts = buildSupersessionFacts(byId)
		const outcome = resolveCurrentForQuery('REQ-GHOST-SUP', facts)
		expect(outcome)
			.toEqual({ ok: false, reason: 'invalid-graph' })
	})

	it('reports unsupported-type for a CHG root', () => {
		const { byId } = buildGraph()
		const facts = buildSupersessionFacts(byId)
		const outcome = resolveCurrentForQuery('CHG-001', facts)
		expect(outcome)
			.toEqual({ ok: false, reason: 'unsupported-type' })
	})

	it('merges multiple roots\' resolutions, deduplicated and sorted', () => {
		const { byId } = buildGraph()
		const facts = buildSupersessionFacts(byId)
		const a = resolveCurrentForQuery('REQ-001', facts)
		const b = resolveCurrentForQuery('REQ-003', facts)
		if (!a.ok || !b.ok)
			throw new Error('expected both to resolve')
		const merged = mergeResolveCurrentResults([a.result, b.result])
		expect(merged.currentIds)
			.toEqual(['REQ-001', 'REQ-004'])
		expect(merged.nodeIds)
			.toEqual(['REQ-001', 'REQ-003', 'REQ-004'])
	})
})

describe('buildNodeSummaries', () => {
	it('builds a summary per ID, sorted bytewise', () => {
		const { byId } = buildGraph()
		const summaries = buildNodeSummaries(['REQ-002', 'REQ-001'], byId)
		expect(summaries.map(s => s.id))
			.toEqual(['REQ-001', 'REQ-002'])
	})
})
