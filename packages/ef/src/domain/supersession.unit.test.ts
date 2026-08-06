import type { SupersessionGraphFact } from './supersession'
import { describe, expect, it } from 'vitest'
import { resolveCurrent, validateSupersessionGraph, validateSupersessionTransition } from './supersession'

function fact(id: string, type: SupersessionGraphFact['type'], status: SupersessionGraphFact['status'], supersededBy: readonly string[] = []): SupersessionGraphFact {
	return { id, type, status, supersededBy }
}

describe('validateSupersessionGraph', () => {
	it('accepts a valid one-to-one replacement', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('accepts a valid one-to-many replacement', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-071', 'REQ-072']),
			fact('REQ-071', 'requirement', 'active'),
			fact('REQ-072', 'requirement', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('accepts a valid many-to-one replacement', () => {
		const graph = [
			fact('REQ-014', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-022', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-041', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('accepts a valid many-to-many replacement', () => {
		const graph = [
			fact('REQ-014', 'requirement', 'superseded', ['REQ-070', 'REQ-071']),
			fact('REQ-022', 'requirement', 'superseded', ['REQ-070', 'REQ-072']),
			fact('REQ-070', 'requirement', 'active'),
			fact('REQ-071', 'requirement', 'active'),
			fact('REQ-072', 'requirement', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('accepts a retired replacement leaf as a valid, non-erroneous graph', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'retired'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('does not flag a dangling superseded-by target (relations-layer concern)', () => {
		const graph = [fact('REQ-031', 'requirement', 'superseded', ['REQ-999'])]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})

	it('reports EF-SUP-001 when a superseded Artifact has no direct replacement', () => {
		const graph = [fact('REQ-031', 'requirement', 'superseded', [])]
		expect(validateSupersessionGraph(graph))
			.toEqual([{
				code: 'EF-SUP-001',
				severity: 'error',
				message: 'Superseded Artifact "REQ-031" has no direct replacement.',
				artifactId: 'REQ-031',
				related: [],
			}])
	})

	it.each(['active', 'draft', 'retired'] as const)('reports EF-SUP-002 when a %s Artifact declares superseded-by', (status) => {
		const graph = [
			fact('REQ-031', 'requirement', status, ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		const result = validateSupersessionGraph(graph)
		expect(result)
			.toContainEqual({
				code: 'EF-SUP-002',
				severity: 'error',
				message: `Non-superseded Artifact "REQ-031" (status: "${status}") declares a "superseded-by" relation.`,
				artifactId: 'REQ-031',
				related: [],
			})
	})

	it('reports EF-SUP-003 when a source and its replacement have different types', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['ADR-022']),
			fact('ADR-022', 'decision', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([{
				code: 'EF-SUP-003',
				severity: 'error',
				message: 'Source "REQ-031" (requirement) and replacement "ADR-022" (decision) have different Artifact types.',
				artifactId: 'REQ-031',
				related: [{ artifactId: 'ADR-022', message: 'Replacement type: "decision".' }],
			}])
	})

	it('reports EF-SUP-005 for self-replacement', () => {
		const graph = [fact('REQ-031', 'requirement', 'superseded', ['REQ-031'])]
		expect(validateSupersessionGraph(graph))
			.toEqual([{
				code: 'EF-SUP-005',
				severity: 'error',
				message: 'Supersession cycle detected: REQ-031 -> REQ-031.',
				artifactId: 'REQ-031',
				related: [],
			}])
	})

	it('reports EF-SUP-005 once for an indirect two-node cycle', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'superseded', ['REQ-031']),
		]
		const result = validateSupersessionGraph(graph)
		expect(result)
			.toHaveLength(1)
		expect(result[0])
			.toEqual({
				code: 'EF-SUP-005',
				severity: 'error',
				message: 'Supersession cycle detected: REQ-031 -> REQ-070 -> REQ-031.',
				artifactId: 'REQ-031',
				related: [{ artifactId: 'REQ-070', message: 'Participates in the cycle.' }],
			})
	})

	it('reports EF-SUP-005 for an indirect three-node cycle', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-091', 'requirement', 'superseded', ['REQ-031']),
		]
		const result = validateSupersessionGraph(graph)
		expect(result)
			.toHaveLength(1)
		expect(result[0]!.code)
			.toBe('EF-SUP-005')
		expect(result[0]!.message)
			.toBe('Supersession cycle detected: REQ-031 -> REQ-070 -> REQ-091 -> REQ-031.')
	})

	it('does not report a cycle for converging (non-cyclic) paths', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-071', 'REQ-072']),
			fact('REQ-071', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-072', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-091', 'requirement', 'active'),
		]
		expect(validateSupersessionGraph(graph))
			.toEqual([])
	})
})

describe('validateSupersessionTransition', () => {
	it('accepts a newly created one-to-one replacement whose target is active at completion', () => {
		const before = [
			fact('REQ-031', 'requirement', 'active'),
		]
		const after = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([])
	})

	it('accepts the "existing active consolidation target" example (05-supersession)', () => {
		const before = [
			fact('REQ-031', 'requirement', 'active'),
			fact('REQ-070', 'requirement', 'active'),
		]
		const after = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([])
	})

	it('reports EF-SUP-004 when a direct replacement is not active at completion', () => {
		const before = [
			fact('REQ-031', 'requirement', 'active'),
			fact('REQ-070', 'requirement', 'draft'),
		]
		const after = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'draft'),
		]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([{
				code: 'EF-SUP-004',
				severity: 'error',
				message: 'Direct replacement "REQ-070" for source "REQ-031" is not active when the transition completes.',
				artifactId: 'REQ-031',
				related: [{ artifactId: 'REQ-070', message: 'Status at completion: "draft".' }],
			}])
	})

	it('reports EF-SUP-004 when a direct replacement does not exist in the resulting graph', () => {
		const before = [fact('REQ-031', 'requirement', 'active')]
		const after = [fact('REQ-031', 'requirement', 'superseded', ['REQ-999'])]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([{
				code: 'EF-SUP-004',
				severity: 'error',
				message: 'Direct replacement "REQ-999" for source "REQ-031" is not active when the transition completes.',
				artifactId: 'REQ-031',
				related: [{ artifactId: 'REQ-999', message: 'Not found in the resulting graph.' }],
			}])
	})

	it('reports EF-SUP-004 only for the not-yet-active member of a partial collective replacement set', () => {
		const before = [
			fact('REQ-014', 'requirement', 'active'),
			fact('REQ-070', 'requirement', 'active'),
			fact('REQ-071', 'requirement', 'draft'),
		]
		const after = [
			fact('REQ-014', 'requirement', 'superseded', ['REQ-070', 'REQ-071']),
			fact('REQ-070', 'requirement', 'active'),
			fact('REQ-071', 'requirement', 'draft'),
		]
		const result = validateSupersessionTransition({ before, after })
		expect(result)
			.toEqual([{
				code: 'EF-SUP-004',
				severity: 'error',
				message: 'Direct replacement "REQ-071" for source "REQ-014" is not active when the transition completes.',
				artifactId: 'REQ-014',
				related: [{ artifactId: 'REQ-071', message: 'Status at completion: "draft".' }],
			}])
	})

	it('reports EF-SUP-007 when a frozen replacement set gains a target', () => {
		const before = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		const after = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070', 'REQ-091']),
			fact('REQ-070', 'requirement', 'active'),
			fact('REQ-091', 'requirement', 'active'),
		]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([{
				code: 'EF-SUP-007',
				severity: 'error',
				message: 'Frozen replacement set for "REQ-031" was modified after its terminal transition.',
				artifactId: 'REQ-031',
				related: [],
			}])
	})

	it('reports EF-SUP-007 when a frozen replacement set loses a target', () => {
		const before = [fact('REQ-031', 'requirement', 'superseded', ['REQ-070', 'REQ-091'])]
		const after = [fact('REQ-031', 'requirement', 'superseded', ['REQ-070'])]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([{
				code: 'EF-SUP-007',
				severity: 'error',
				message: 'Frozen replacement set for "REQ-031" was modified after its terminal transition.',
				artifactId: 'REQ-031',
				related: [],
			}])
	})

	it('reports EF-SUP-007 when a frozen replacement set is merely reordered', () => {
		const before = [fact('REQ-031', 'requirement', 'superseded', ['REQ-070', 'REQ-091'])]
		const after = [fact('REQ-031', 'requirement', 'superseded', ['REQ-091', 'REQ-070'])]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([{
				code: 'EF-SUP-007',
				severity: 'error',
				message: 'Frozen replacement set for "REQ-031" was modified after its terminal transition.',
				artifactId: 'REQ-031',
				related: [],
			}])
	})

	it('accepts an unchanged frozen replacement set', () => {
		const before = [fact('REQ-031', 'requirement', 'superseded', ['REQ-070'])]
		const after = [fact('REQ-031', 'requirement', 'superseded', ['REQ-070'])]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([])
	})

	it('does not retroactively flag an earlier supersession when its replacement later retires (05-supersession "Retired replacement leaves")', () => {
		const before = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		const after = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'retired'),
		]
		expect(validateSupersessionTransition({ before, after }))
			.toEqual([])
	})
})

describe('resolveCurrent', () => {
	it('resolves active PRD/REQ/ADR/POL to itself', () => {
		const graph = [fact('REQ-070', 'requirement', 'active')]
		expect(resolveCurrent('REQ-070', graph))
			.toEqual({
				ok: true,
				inputId: 'REQ-070',
				currentIds: ['REQ-070'],
				nodes: [fact('REQ-070', 'requirement', 'active')],
				edges: [],
			})
	})

	it('resolves PROJECT to itself', () => {
		const graph = [fact('PROJECT', 'project', 'active')]
		expect(resolveCurrent('PROJECT', graph))
			.toEqual({
				ok: true,
				inputId: 'PROJECT',
				currentIds: ['PROJECT'],
				nodes: [fact('PROJECT', 'project', 'active')],
				edges: [],
			})
	})

	it('resolves draft to the empty set', () => {
		const graph = [fact('REQ-031', 'requirement', 'draft')]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: true,
				inputId: 'REQ-031',
				currentIds: [],
				nodes: [fact('REQ-031', 'requirement', 'draft')],
				edges: [],
			})
	})

	it('resolves retired to the empty set', () => {
		const graph = [fact('REQ-031', 'requirement', 'retired')]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: true,
				inputId: 'REQ-031',
				currentIds: [],
				nodes: [fact('REQ-031', 'requirement', 'retired')],
				edges: [],
			})
	})

	it('resolves one-to-one replacement (05-supersession "One-to-one replacement")', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result)
			.toEqual({
				ok: true,
				inputId: 'REQ-031',
				currentIds: ['REQ-070'],
				nodes: [
					fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
					fact('REQ-070', 'requirement', 'active'),
				],
				edges: [{ from: 'REQ-031', to: 'REQ-070' }],
			})
	})

	it('resolves one-to-many replacement, returning both replacements (05-supersession "One-to-many replacement")', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-071', 'REQ-072']),
			fact('REQ-071', 'requirement', 'active'),
			fact('REQ-072', 'requirement', 'active'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result.ok)
			.toBe(true)
		if (result.ok) {
			expect(result.currentIds)
				.toEqual(['REQ-071', 'REQ-072'])
			expect(result.edges)
				.toEqual([
					{ from: 'REQ-031', to: 'REQ-071' },
					{ from: 'REQ-031', to: 'REQ-072' },
				])
		}
	})

	it('resolves many-to-one replacement for any given source (05-supersession "Many-to-one replacement")', () => {
		const graph = [
			fact('REQ-014', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-022', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'active'),
		]
		expect(resolveCurrent('REQ-022', graph))
			.toEqual({
				ok: true,
				inputId: 'REQ-022',
				currentIds: ['REQ-070'],
				nodes: [
					fact('REQ-022', 'requirement', 'superseded', ['REQ-070']),
					fact('REQ-070', 'requirement', 'active'),
				],
				edges: [{ from: 'REQ-022', to: 'REQ-070' }],
			})
	})

	it('follows a complete replacement chain (05-supersession "Replacement chains")', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-091', 'requirement', 'active'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result.ok)
			.toBe(true)
		if (result.ok) {
			expect(result.currentIds)
				.toEqual(['REQ-091'])
			expect(result.edges)
				.toEqual([
					{ from: 'REQ-031', to: 'REQ-070' },
					{ from: 'REQ-070', to: 'REQ-091' },
				])
			expect(result.nodes.map(n => n.id))
				.toEqual(['REQ-031', 'REQ-070', 'REQ-091'])
		}
	})

	it('deduplicates converging paths to the same active leaf (05-supersession "Converging paths")', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-071', 'REQ-072']),
			fact('REQ-071', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-072', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-091', 'requirement', 'active'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result.ok)
			.toBe(true)
		if (result.ok) {
			expect(result.currentIds)
				.toEqual(['REQ-091'])
			expect(result.nodes.map(n => n.id))
				.toEqual(['REQ-031', 'REQ-071', 'REQ-072', 'REQ-091'])
			expect(result.edges)
				.toEqual([
					{ from: 'REQ-031', to: 'REQ-071' },
					{ from: 'REQ-071', to: 'REQ-091' },
					{ from: 'REQ-031', to: 'REQ-072' },
					{ from: 'REQ-072', to: 'REQ-091' },
				])
		}
	})

	it('returns the empty set when a retired replacement leaf has no current replacement (05-supersession "No current replacement")', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'retired'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result)
			.toEqual({
				ok: true,
				inputId: 'REQ-031',
				currentIds: [],
				nodes: [
					fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
					fact('REQ-070', 'requirement', 'retired'),
				],
				edges: [{ from: 'REQ-031', to: 'REQ-070' }],
			})
	})

	it('resolves a split with later independent evolution (05-supersession Examples)', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-071', 'REQ-072']),
			fact('REQ-071', 'requirement', 'superseded', ['REQ-091']),
			fact('REQ-072', 'requirement', 'active'),
			fact('REQ-091', 'requirement', 'active'),
		]
		const result = resolveCurrent('REQ-031', graph)
		expect(result.ok)
			.toBe(true)
		if (result.ok) {
			expect(result.currentIds)
				.toEqual(['REQ-072', 'REQ-091'])
		}
	})

	it('fails with reason "unknown-root" when the input ID is absent from the graph', () => {
		expect(resolveCurrent('REQ-999', []))
			.toEqual({
				ok: false,
				reason: 'unknown-root',
				message: 'Artifact "REQ-999" was not found in the supplied graph.',
			})
	})

	it('fails with reason "unsupported-type" for a CHG root', () => {
		const graph = [fact('CHG-182', 'change', 'completed')]
		expect(resolveCurrent('CHG-182', graph))
			.toEqual({
				ok: false,
				reason: 'unsupported-type',
				message: 'Current resolution of a CHG ("CHG-182") is an unsupported operation.',
			})
	})

	it('fails with reason "invalid-graph" when a superseded-by target is missing from the graph', () => {
		const graph = [fact('REQ-031', 'requirement', 'superseded', ['REQ-999'])]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: false,
				reason: 'invalid-graph',
				message: 'Artifact "REQ-999" referenced by "superseded-by" was not found in the supplied graph.',
			})
	})

	it('fails with reason "invalid-graph" for an unrecognized status reached during traversal', () => {
		const graph: SupersessionGraphFact[] = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			{ id: 'REQ-070', type: 'requirement', status: 'archived' as SupersessionGraphFact['status'], supersededBy: [] },
		]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: false,
				reason: 'invalid-graph',
				message: 'Artifact "REQ-070" has an unrecognized lifecycle status.',
			})
	})

	it('fails with reason "cycle" for self-replacement', () => {
		const graph = [fact('REQ-031', 'requirement', 'superseded', ['REQ-031'])]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: false,
				reason: 'cycle',
				message: 'Supersession cycle detected while resolving "REQ-031": "REQ-031" -> "REQ-031" closes the cycle.',
			})
	})

	it('fails with reason "cycle" for an indirect cycle', () => {
		const graph = [
			fact('REQ-031', 'requirement', 'superseded', ['REQ-070']),
			fact('REQ-070', 'requirement', 'superseded', ['REQ-031']),
		]
		expect(resolveCurrent('REQ-031', graph))
			.toEqual({
				ok: false,
				reason: 'cycle',
				message: 'Supersession cycle detected while resolving "REQ-031": "REQ-070" -> "REQ-031" closes the cycle.',
			})
	})
})
