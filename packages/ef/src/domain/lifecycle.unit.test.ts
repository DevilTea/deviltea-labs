import type { ArtifactType, Status } from './model'
import { describe, expect, it } from 'vitest'
import { validateStatus, validateTransition } from './lifecycle'
import { ALLOWED_STATUSES, ALLOWED_TRANSITIONS } from './model'

describe('validateStatus', () => {
	it('accepts every status allowed for its Artifact type', () => {
		for (const type of Object.keys(ALLOWED_STATUSES) as ArtifactType[]) {
			for (const status of ALLOWED_STATUSES[type]) {
				expect(validateStatus({ type, status, id: 'X-1' }, 'x.md'))
					.toEqual([])
			}
		}
	})

	it('reports EF-LIFE-001 for a status outside the five-value vocabulary', () => {
		const result = validateStatus({ type: 'decision', status: 'accepted', id: 'ADR-022' }, 'adr/ADR-022.md')
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-001',
				severity: 'error',
				message: 'Unknown lifecycle status "accepted".',
				path: 'adr/ADR-022.md',
				artifactId: 'ADR-022',
				field: 'status',
				related: [],
			}])
	})

	it('rejects case variants as unknown status, not an alias', () => {
		const result = validateStatus({ type: 'requirement', status: 'Draft', id: 'REQ-031' }, 'req/REQ-031.md')
		expect(result)
			.toHaveLength(1)
		expect(result[0]!.code)
			.toBe('EF-LIFE-001')
	})

	it('reports EF-LIFE-001 for an empty status', () => {
		const result = validateStatus({ type: 'requirement', status: '' }, 'req/REQ-031.md')
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-001',
				severity: 'error',
				message: 'Unknown lifecycle status "".',
				path: 'req/REQ-031.md',
				artifactId: undefined,
				field: 'status',
				related: [],
			}])
	})

	it('reports EF-LIFE-002 when a CHG uses active, a known status not allowed for CHG', () => {
		const result = validateStatus({ type: 'change', status: 'active', id: 'CHG-182' }, 'chg/CHG-182.md')
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-002',
				severity: 'error',
				message: 'Status "active" is not allowed for Artifact type "change". Allowed: draft, completed, retired.',
				path: 'chg/CHG-182.md',
				artifactId: 'CHG-182',
				field: 'status',
				related: [],
			}])
	})

	it('reports EF-LIFE-002 when PROJECT uses draft, a known status not allowed for project', () => {
		const result = validateStatus({ type: 'project', status: 'draft', id: 'PROJECT' }, 'PROJECT.md')
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-002',
				severity: 'error',
				message: 'Status "draft" is not allowed for Artifact type "project". Allowed: active.',
				path: 'PROJECT.md',
				artifactId: 'PROJECT',
				field: 'status',
				related: [],
			}])
	})

	it('reports EF-LIFE-002 when a REQ uses completed, a status only CHG allows', () => {
		const result = validateStatus({ type: 'requirement', status: 'completed', id: 'REQ-031' }, 'req/REQ-031.md')
		expect(result[0]!.code)
			.toBe('EF-LIFE-002')
	})
})

describe('validateTransition — first authoritative appearance', () => {
	it('allows a knowledge Artifact to first appear as draft', () => {
		expect(validateTransition({ type: 'requirement', before: undefined, after: 'draft' }))
			.toEqual([])
	})

	it('allows a knowledge Artifact to first appear as active when a completed CHG introduces effect exists', () => {
		expect(validateTransition({ type: 'requirement', before: undefined, after: 'active', introducedByCompletedChg: true }))
			.toEqual([])
	})

	it('allows a knowledge Artifact to first appear as active during EF project bootstrap', () => {
		expect(validateTransition({ type: 'policy', before: undefined, after: 'active', isProjectBootstrap: true }))
			.toEqual([])
	})

	it('rejects a knowledge Artifact first appearing as active without an introduces effect or bootstrap', () => {
		const result = validateTransition({ type: 'requirement', before: undefined, after: 'active', id: 'REQ-031', path: 'req/REQ-031.md' })
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-003',
				severity: 'error',
				message: 'Artifact type "requirement" first appearing as "active" requires a completed CHG "introduces" effect, except during EF project bootstrap.',
				path: 'req/REQ-031.md',
				artifactId: 'REQ-031',
				field: 'status',
				related: [],
			}])
	})

	it('rejects a knowledge Artifact first appearing as superseded', () => {
		const result = validateTransition({ type: 'decision', before: undefined, after: 'superseded' })
		expect(result[0]!.code)
			.toBe('EF-LIFE-003')
	})

	it('rejects a knowledge Artifact first appearing as retired', () => {
		const result = validateTransition({ type: 'policy', before: undefined, after: 'retired' })
		expect(result[0]!.code)
			.toBe('EF-LIFE-003')
	})

	it.each(['draft', 'completed', 'retired'] as const)('allows a CHG to first appear as %s', (after) => {
		expect(validateTransition({ type: 'change', before: undefined, after }))
			.toEqual([])
	})

	it('rejects a CHG first appearing as active, a status CHG never carries', () => {
		const result = validateTransition({ type: 'change', before: undefined, after: 'active' as Status })
		expect(result[0]!.code)
			.toBe('EF-LIFE-003')
	})

	it('allows PROJECT to first appear as active (bootstrap)', () => {
		expect(validateTransition({ type: 'project', before: undefined, after: 'active' }))
			.toEqual([])
	})
})

describe('validateTransition — same status is not a transition', () => {
	it.each(['draft', 'active', 'superseded', 'retired', 'completed'] as const)('returns no diagnostics when before equals after (%s)', (status) => {
		expect(validateTransition({ type: 'requirement', before: status, after: status }))
			.toEqual([])
	})

	it('returns no diagnostics for PROJECT active -> active', () => {
		expect(validateTransition({ type: 'project', before: 'active', after: 'active' }))
			.toEqual([])
	})
})

describe('validateTransition — legal transitions', () => {
	it('allows every transition in ALLOWED_TRANSITIONS for each Artifact type', () => {
		for (const type of Object.keys(ALLOWED_TRANSITIONS) as ArtifactType[]) {
			for (const [before, after] of ALLOWED_TRANSITIONS[type]) {
				expect(validateTransition({ type, before, after }))
					.toEqual([])
			}
		}
	})
})

describe('validateTransition — illegal transitions (03-lifecycle "Invalid transitions")', () => {
	it.each([
		['prd', 'active', 'draft'],
		['requirement', 'active', 'draft'],
		['decision', 'active', 'draft'],
		['policy', 'active', 'draft'],
		['requirement', 'retired', 'active'],
		['requirement', 'superseded', 'active'],
		['change', 'completed', 'draft'],
		['change', 'draft', 'active'],
		['requirement', 'active', 'completed'],
	] satisfies [ArtifactType, Status, Status][])('rejects %s %s -> %s', (type, before, after) => {
		const result = validateTransition({ type, before, after, id: 'X-1' })
		expect(result)
			.toEqual([{
				code: 'EF-LIFE-003',
				severity: 'error',
				message: `Illegal lifecycle transition for Artifact type "${type}": "${before}" -> "${after}".`,
				path: undefined,
				artifactId: 'X-1',
				field: 'status',
				related: [],
			}])
	})

	it('rejects a terminal PROJECT-shaped transition since PROJECT has no legal transitions', () => {
		const result = validateTransition({ type: 'project', before: 'active', after: 'retired' as Status })
		expect(result[0]!.code)
			.toBe('EF-LIFE-003')
	})

	it('rejects draft -> superseded for a knowledge Artifact (not in the transition table)', () => {
		const result = validateTransition({ type: 'policy', before: 'draft', after: 'superseded' })
		expect(result[0]!.code)
			.toBe('EF-LIFE-003')
	})
})
