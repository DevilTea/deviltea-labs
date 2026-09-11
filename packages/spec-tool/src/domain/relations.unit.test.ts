import type { RelationEntry } from './model'
import type { NewRelationEdge, RelationGraphArtifact } from './relations'
import { describe, expect, it } from 'vitest'
import {
	validateNewRelationEdgeTargetStatus,
	validateRelationEntries,
	validateRelationGraph,
} from './relations'

function entry(type: string, target: string, extensions: Record<string, unknown> = {}): Record<string, unknown> {
	return { type, target, ...extensions }
}

describe('validateRelationEntries', () => {
	it('accepts a well-formed, canonically ordered relations array with no diagnostics', () => {
		const result = validateRelationEntries(
			{
				id: 'REQ-031',
				relations: [
					entry('derived-from', 'PRD-012'),
					entry('governed-by', 'POL-006'),
				],
			},
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([])
		expect(result.entries)
			.toEqual<RelationEntry[]>([
				{ type: 'derived-from', target: 'PRD-012', extensions: {} },
				{ type: 'governed-by', target: 'POL-006', extensions: {} },
			])
	})

	it('accepts the ADR coverage example with a valid extension field', () => {
		const result = validateRelationEntries(
			{
				id: 'ADR-010',
				relations: [
					entry('addresses', 'REQ-031'),
					entry('addresses', 'REQ-044'),
					entry('governed-by', 'POL-009', { 'x-acme-enforcement': 'ci' }),
				],
			},
			'.engineering/adr/ADR-010.md',
		)

		expect(result.diagnostics)
			.toEqual([])
		expect(result.entries)
			.toEqual<RelationEntry[]>([
				{ type: 'addresses', target: 'REQ-031', extensions: {} },
				{ type: 'addresses', target: 'REQ-044', extensions: {} },
				{ type: 'governed-by', target: 'POL-009', extensions: { 'x-acme-enforcement': 'ci' } },
			])
	})

	it('reports EF-REL-002 when an entry is not a mapping', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: ['derived-from:PRD-012'] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.entries)
			.toEqual([])
		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-002',
				severity: 'error',
				message: 'Relation entry must be a mapping with \'type\' and \'target\' fields.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0]',
				related: [],
			}])
	})

	it('reports EF-REL-002 when an entry is an array', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [['derived-from', 'PRD-012']] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002', field: 'relations[0]' })])
	})

	it('reports EF-REL-002 for a missing target field', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ type: 'derived-from' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.entries)
			.toEqual([])
		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-002',
				severity: 'error',
				message: 'Relation entry is missing a required non-empty \'target\' field.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].target',
				related: [],
			}])
	})

	it('reports EF-REL-002 for a missing type field', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ target: 'PRD-012' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002', field: 'relations[0].type' })])
	})

	it('reports both EF-REL-002 findings when both required fields are missing', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{}] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toHaveLength(2)
		expect(result.diagnostics.map(d => d.field)
			.sort())
			.toEqual(['relations[0].target', 'relations[0].type'])
	})

	it('reports EF-REL-002 for an empty string type', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ type: '', target: 'PRD-012' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002', field: 'relations[0].type' })])
	})

	it('reports EF-REL-002 for an empty string target', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ type: 'derived-from', target: '' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002', field: 'relations[0].target' })])
	})

	it('reports EF-REL-002 for a non-string type value', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ type: 123, target: 'PRD-012' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002', field: 'relations[0].type' })])
	})

	it('reports EF-REL-001 for an unknown relation type and excludes the entry from output', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [entry('related-to', 'PRD-012')] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.entries)
			.toEqual([])
		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-001',
				severity: 'error',
				message: 'Relation type \'related-to\' is not a known EF Core relation type.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].type',
				related: [],
			}])
	})

	it('reports EF-REL-001 for a case variant of a known relation type', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [entry('Derived-From', 'PRD-012')] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-001' })])
	})

	it('reports EF-REL-015 for an unknown non-extension field', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [entry('references', 'PRD-012', { note: 'context' })] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-015',
				severity: 'error',
				message: 'Relation field \'note\' is not \'type\', \'target\', or a valid \'x-*\' extension.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].note',
				related: [],
			}])
		expect(result.entries)
			.toEqual<RelationEntry[]>([{ type: 'references', target: 'PRD-012', extensions: {} }])
	})

	it('reports EF-REL-015 for an unnamespaced extension field name', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [entry('references', 'PRD-012', { 'x-owner': 'team' })] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-015', field: 'relations[0].x-owner' })])
	})

	it('reports EF-REL-015 for a non-JSON-compatible extension value', () => {
		const result = validateRelationEntries(
			{
				id: 'REQ-031',
				relations: [entry('references', 'PRD-012', { 'x-acme-callback': () => {} })],
			},
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-015', field: 'relations[0].x-acme-callback' })])
		expect(result.entries[0]!.extensions)
			.toEqual({})
	})

	it('reports EF-REL-005 for a self-relation and excludes the entry from output', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [entry('references', 'REQ-031')] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.entries)
			.toEqual([])
		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-005',
				severity: 'error',
				message: 'Relation target \'REQ-031\' is the same as the source Artifact; self-relations are invalid.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].target',
				related: [],
			}])
	})

	it('reports the duplicate example: same (type, target) with differing extensions is still a duplicate', () => {
		const result = validateRelationEntries(
			{
				id: 'ADR-010',
				relations: [
					entry('references', 'REQ-031'),
					entry('references', 'REQ-031', { 'x-acme-note': 'duplicate' }),
				],
			},
			'.engineering/adr/ADR-010.md',
		)

		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-006',
				severity: 'error',
				message: 'Relation \'(references, REQ-031)\' is a duplicate of an earlier entry.',
				path: '.engineering/adr/ADR-010.md',
				artifactId: 'ADR-010',
				field: 'relations[1]',
				related: [{
					path: '.engineering/adr/ADR-010.md',
					artifactId: 'ADR-010',
					field: 'relations[0]',
					message: 'First occurrence of this relation.',
				}],
			}])
	})

	it('does not report a duplicate for distinct targets of the same type', () => {
		const result = validateRelationEntries(
			{
				id: 'ADR-010',
				relations: [entry('addresses', 'REQ-031'), entry('addresses', 'REQ-044')],
			},
			'.engineering/adr/ADR-010.md',
		)

		expect(result.diagnostics)
			.toEqual([])
	})

	it('reports EF-REL-006 even when the duplicated type is unknown', () => {
		const result = validateRelationEntries(
			{
				id: 'ADR-010',
				relations: [entry('related-to', 'REQ-031'), entry('related-to', 'REQ-031')],
			},
			'.engineering/adr/ADR-010.md',
		)

		const codes = result.diagnostics.map(d => d.code)
			.sort()
		expect(codes)
			.toEqual(['EF-REL-001', 'EF-REL-001', 'EF-REL-006'])
	})

	it('accepts the canonically ordered relations example with no EF-REL-007', () => {
		const result = validateRelationEntries(
			{
				id: 'PRD-012',
				relations: [
					entry('addresses', 'REQ-031'),
					entry('addresses', 'REQ-044'),
					entry('governed-by', 'POL-006'),
					entry('references', 'ADR-010'),
				],
			},
			'.engineering/prd/PRD-012.md',
		)

		expect(result.diagnostics)
			.toEqual([])
	})

	it('reports EF-REL-007 when the relations array is not sorted by (type, target)', () => {
		const result = validateRelationEntries(
			{
				id: 'PRD-012',
				relations: [
					entry('governed-by', 'POL-006'),
					entry('addresses', 'REQ-031'),
				],
			},
			'.engineering/prd/PRD-012.md',
		)

		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-007',
				severity: 'warning',
				message: 'Relation entries are not sorted by canonical (type, target) bytewise order.',
				path: '.engineering/prd/PRD-012.md',
				artifactId: 'PRD-012',
				field: 'relations[1]',
				related: [],
			}])
	})

	it('reports EF-REL-007 when the second entry ties on type but sorts before on target', () => {
		const result = validateRelationEntries(
			{
				id: 'ADR-010',
				relations: [
					entry('addresses', 'REQ-044'),
					entry('addresses', 'REQ-031'),
				],
			},
			'.engineering/adr/ADR-010.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-007', field: 'relations[1]' })])
	})

	it('reports EF-REL-007 when entry fields are reversed (target before type)', () => {
		const result = validateRelationEntries(
			{ id: 'REQ-031', relations: [{ target: 'PRD-012', type: 'derived-from' }] },
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([{
				code: 'EF-REL-007',
				severity: 'warning',
				message: 'Relation entry fields are not in canonical \'type\', \'target\', \'x-*\' order.',
				path: '.engineering/req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0]',
				related: [],
			}])
	})

	it('reports EF-REL-007 when extension fields are not in bytewise order', () => {
		const result = validateRelationEntries(
			{
				id: 'REQ-031',
				relations: [{ 'type': 'governed-by', 'target': 'POL-006', 'x-acme-b': 1, 'x-acme-a': 2 }],
			},
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-007', field: 'relations[0]' })])
	})

	it('does not report EF-REL-007 when extension fields are already in bytewise order', () => {
		const result = validateRelationEntries(
			{
				id: 'REQ-031',
				relations: [{ 'type': 'governed-by', 'target': 'POL-006', 'x-acme-a': 2, 'x-acme-b': 1 }],
			},
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([])
	})

	it('excludes shape-invalid entries from downstream duplicate and ordering checks', () => {
		const result = validateRelationEntries(
			{
				id: 'REQ-031',
				relations: [
					{ type: 'governed-by' }, // shape-invalid, missing target
					entry('addresses', 'REQ-044'),
				],
			},
			'.engineering/req/REQ-031.md',
		)

		expect(result.diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-002' })])
		expect(result.entries)
			.toEqual<RelationEntry[]>([{ type: 'addresses', target: 'REQ-044', extensions: {} }])
	})
})

describe('validateRelationGraph', () => {
	function artifact(id: string, type: RelationGraphArtifact['type'], relations: RelationEntry[] = []): RelationGraphArtifact {
		return { path: `${id}.md`, id, type, relations }
	}

	function relation(type: RelationEntry['type'], target: string): RelationEntry {
		return { type, target, extensions: {} }
	}

	function graph(artifacts: RelationGraphArtifact[]): { artifacts: RelationGraphArtifact[], byId: Map<string, RelationGraphArtifact> } {
		return { artifacts, byId: new Map(artifacts.map(a => [a.id, a])) }
	}

	it('reports no diagnostics for every valid compatibility-matrix combination', () => {
		const { artifacts, byId } = graph([
			artifact('PRD-001', 'prd'),
			artifact('PRD-002', 'prd', [relation('derived-from', 'PRD-001')]),
			artifact('REQ-001', 'requirement', [relation('derived-from', 'PRD-001')]),
			artifact('REQ-002', 'requirement', [relation('derived-from', 'REQ-001')]),
			artifact('POL-001', 'policy'),
			artifact('POL-002', 'policy', [relation('derived-from', 'REQ-001'), relation('derived-from', 'POL-001')]),
			artifact('ADR-001', 'decision', [relation('addresses', 'REQ-001'), relation('governed-by', 'POL-001')]),
			artifact('CHG-001', 'change', [relation('governed-by', 'POL-001'), relation('introduces', 'REQ-002')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([])
	})

	it('reports EF-REL-003 for the unknown-target example', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-031', 'requirement', [relation('derived-from', 'PRD-999')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([{
				code: 'EF-REL-003',
				severity: 'error',
				message: 'Relation target \'PRD-999\' does not exist in the project graph.',
				path: 'REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].target',
				related: [],
			}])
	})

	it('reports EF-REL-004 for the invalid-compatibility example (REQ addressing an ADR)', () => {
		const { artifacts, byId } = graph([
			artifact('ADR-022', 'decision'),
			artifact('REQ-031', 'requirement', [relation('addresses', 'ADR-022')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([{
				code: 'EF-REL-004',
				severity: 'error',
				message: 'Relation type \'addresses\' does not allow source type \'requirement\' with target type \'decision\'.',
				path: 'REQ-031.md',
				artifactId: 'REQ-031',
				field: 'relations[0].type',
				related: [],
			}])
	})

	it('suppresses EF-REL-004 when the target does not exist (EF-REL-003 owns that entry)', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-031', 'requirement', [relation('addresses', 'PRD-999')]),
		])

		const diagnostics = validateRelationGraph(artifacts, byId)
		expect(diagnostics)
			.toHaveLength(1)
		expect(diagnostics[0]!.code)
			.toBe('EF-REL-003')
	})

	it('reports EF-REL-004 via the DERIVED_FROM_TARGETS refinement even though the base matrix would allow it', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-001', 'requirement'),
			artifact('PRD-002', 'prd', [relation('derived-from', 'REQ-001')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([{
				code: 'EF-REL-004',
				severity: 'error',
				message: 'Relation type \'derived-from\' does not allow source type \'prd\' with target type \'requirement\'.',
				path: 'PRD-002.md',
				artifactId: 'PRD-002',
				field: 'relations[0].type',
				related: [],
			}])
	})

	it('reports EF-REL-004 for a governed-by edge targeting a non-POL', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-001', 'requirement'),
			artifact('ADR-001', 'decision', [relation('governed-by', 'REQ-001')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([expect.objectContaining({ code: 'EF-REL-004' })])
	})

	it('does not report EF-REL-004 for a superseded-by source/target type mismatch (owned by EF-SUP-003)', () => {
		const { artifacts, byId } = graph([
			artifact('ADR-005', 'decision'),
			artifact('REQ-031', 'requirement', [relation('superseded-by', 'ADR-005')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([])
	})

	it('reports EF-REL-004 for a superseded-by edge from a source type outside the allowed set', () => {
		const { artifacts, byId } = graph([
			artifact('CHG-002', 'change'),
			artifact('CHG-001', 'change', [relation('superseded-by', 'CHG-002')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([expect.objectContaining({ code: 'EF-REL-004' })])
	})

	it('does not report EF-REL-004 for a CHG effect relation targeting another CHG (owned by EF-CHG-017)', () => {
		const { artifacts, byId } = graph([
			artifact('CHG-002', 'change'),
			artifact('CHG-001', 'change', [relation('introduces', 'CHG-002')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([])
	})

	it('reports EF-REL-004 for a CHG effect relation targeting a disallowed non-CHG type', () => {
		const { artifacts, byId } = graph([
			artifact('PROJECT', 'project'),
			artifact('CHG-001', 'change', [relation('introduces', 'PROJECT')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([expect.objectContaining({ code: 'EF-REL-004' })])
	})

	it('reports EF-REL-008 for a direct two-node derived-from cycle', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-001', 'requirement', [relation('derived-from', 'REQ-002')]),
			artifact('REQ-002', 'requirement', [relation('derived-from', 'REQ-001')]),
		])

		const diagnostics = validateRelationGraph(artifacts, byId)
		expect(diagnostics)
			.toHaveLength(2)
		expect(diagnostics.every(d => d.code === 'EF-REL-008'))
			.toBe(true)
		expect(diagnostics.map(d => d.artifactId)
			.sort())
			.toEqual(['REQ-001', 'REQ-002'])
	})

	it('reports EF-REL-008 for every edge in a three-node derived-from cycle', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-001', 'requirement', [relation('derived-from', 'REQ-002')]),
			artifact('REQ-002', 'requirement', [relation('derived-from', 'REQ-003')]),
			artifact('REQ-003', 'requirement', [relation('derived-from', 'REQ-001')]),
		])

		const diagnostics = validateRelationGraph(artifacts, byId)
		expect(diagnostics)
			.toHaveLength(3)
		expect(diagnostics.map(d => d.artifactId)
			.sort())
			.toEqual(['REQ-001', 'REQ-002', 'REQ-003'])
	})

	it('does not report EF-REL-008 for a derived-from chain with no cycle', () => {
		const { artifacts, byId } = graph([
			artifact('PRD-001', 'prd'),
			artifact('REQ-001', 'requirement', [relation('derived-from', 'PRD-001')]),
			artifact('REQ-002', 'requirement', [relation('derived-from', 'REQ-001')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([])
	})

	it('allows references cycles without reporting EF-REL-008', () => {
		const { artifacts, byId } = graph([
			artifact('REQ-001', 'requirement', [relation('references', 'REQ-002')]),
			artifact('REQ-002', 'requirement', [relation('references', 'REQ-001')]),
		])

		expect(validateRelationGraph(artifacts, byId))
			.toEqual([])
	})
})

describe('validateNewRelationEdgeTargetStatus', () => {
	function edge(type: NewRelationEdge['type'], target: string, sourceId = 'ADR-001'): NewRelationEdge {
		return { path: `${sourceId}.md`, sourceId, type, target, index: 0 }
	}

	it('allows a new addresses edge targeting an active REQ', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('addresses', 'REQ-031')],
			() => 'active',
		)

		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-REL-017 for a new addresses edge targeting a draft REQ', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('addresses', 'REQ-031')],
			() => 'draft',
		)

		expect(diagnostics)
			.toEqual([{
				code: 'EF-REL-017',
				severity: 'error',
				message: 'New \'addresses\' relation must target an active REQ; \'REQ-031\' has status \'draft\'.',
				path: 'ADR-001.md',
				artifactId: 'ADR-001',
				field: 'relations[0].target',
				related: [],
			}])
	})

	it('reports EF-REL-017 for a new addresses edge targeting a superseded REQ', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('addresses', 'REQ-031')],
			() => 'superseded',
		)

		expect(diagnostics)
			.toEqual([expect.objectContaining({ code: 'EF-REL-017' })])
	})

	it('allows a new governed-by edge targeting an active POL', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('governed-by', 'POL-006')],
			() => 'active',
		)

		expect(diagnostics)
			.toEqual([])
	})

	it('reports EF-REL-018 for a new governed-by edge targeting a retired POL', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('governed-by', 'POL-006')],
			() => 'retired',
		)

		expect(diagnostics)
			.toEqual([{
				code: 'EF-REL-018',
				severity: 'error',
				message: 'New \'governed-by\' relation must target an active POL; \'POL-006\' has status \'retired\'.',
				path: 'ADR-001.md',
				artifactId: 'ADR-001',
				field: 'relations[0].target',
				related: [],
			}])
	})

	it('suppresses the finding when the target does not exist (EF-REL-003 owns that case)', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('addresses', 'REQ-999')],
			() => undefined,
		)

		expect(diagnostics)
			.toEqual([])
	})

	it('ignores relation types other than addresses and governed-by', () => {
		const diagnostics = validateNewRelationEdgeTargetStatus(
			[edge('derived-from', 'REQ-999'), edge('references', 'REQ-999')],
			() => 'draft',
		)

		expect(diagnostics)
			.toEqual([])
	})
})
