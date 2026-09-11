import type { Diagnostic } from './diagnostics'
import { describe, expect, it } from 'vitest'
import {
	nextId,
	validateFilename,
	validateGraphIdentity,
	validateIdSyntax,
} from './identity'

function diag(partial: Partial<Diagnostic> & Pick<Diagnostic, 'code' | 'severity' | 'message'>): Diagnostic {
	return { path: undefined, artifactId: undefined, location: undefined, field: undefined, section: undefined, related: [], ...partial }
}

describe('validateIdSyntax', () => {
	describe('valid identities', () => {
		it('accepts the PROJECT Artifact using the exact ID PROJECT', () => {
			expect(validateIdSyntax({ type: 'project', id: 'PROJECT' }, '.engineering/PROJECT.md'))
				.toEqual([])
		})

		it.each([
			['prd', 'PRD-001'],
			['requirement', 'REQ-031'],
			['decision', 'ADR-001'],
			['policy', 'POL-001'],
			['change', 'CHG-001'],
		] as const)('accepts a canonical %s ID %s', (type, id) => {
			expect(validateIdSyntax({ type, id }, 'irrelevant.md'))
				.toEqual([])
		})

		it.each([
			['1', '001'],
			['42', '042'],
			['999', '999'],
			['1000', '1000'],
			['1001', '1001'],
		])('accepts canonical numeric suffix %s -> REQ-%s', (_value, suffix) => {
			expect(validateIdSyntax({ type: 'requirement', id: `REQ-${suffix}` }, 'x.md'))
				.toEqual([])
		})
	})

	describe('eF-ID-008: PROJECT uses an ID other than PROJECT', () => {
		it.each(['PROJECT-001', 'project', '', 'PROJEC', 'PROJECTX'])('rejects PROJECT id %s', (id) => {
			const result = validateIdSyntax({ type: 'project', id }, '.engineering/PROJECT.md')
			expect(result)
				.toEqual([
					diag({
						code: 'EF-ID-008',
						severity: 'error',
						message: `PROJECT Artifact must use the exact ID 'PROJECT'; found '${id}'.`,
						path: '.engineering/PROJECT.md',
						artifactId: id,
						field: 'id',
					}),
				])
		})

		it('does not also report EF-ID-001, EF-ID-002, EF-ID-003, or EF-ID-011 for a wrong PROJECT id', () => {
			const result = validateIdSyntax({ type: 'project', id: 'REQ-001' }, 'p.md')
			expect(result)
				.toHaveLength(1)
			expect(result[0]!.code)
				.toBe('EF-ID-008')
		})
	})

	describe('eF-ID-001: missing or malformed Artifact ID', () => {
		it.each([
			'',
			'REQ031',
			'REQ-',
			'-031',
			'REQ-03a',
			'REQ--031',
			'REQ-03-1',
			'PROJECT',
			'just text',
			'REQ 031',
		])('rejects malformed id %s for a requirement', (id) => {
			const result = validateIdSyntax({ type: 'requirement', id }, 'x.md')
			expect(result)
				.toEqual([
					diag({
						code: 'EF-ID-001',
						severity: 'error',
						message: `Artifact ID '${id}' is missing or malformed.`,
						path: 'x.md',
						artifactId: id,
						field: 'id',
					}),
				])
		})
	})

	describe('eF-ID-002: ID prefix does not match Artifact type', () => {
		it('rejects ADR-031 for a requirement (spec example)', () => {
			const result = validateIdSyntax({ type: 'requirement', id: 'ADR-031' }, 'x.md')
			expect(result)
				.toEqual([
					diag({
						code: 'EF-ID-002',
						severity: 'error',
						message: `ID prefix 'ADR' does not match Artifact type 'requirement' (expected 'REQ').`,
						path: 'x.md',
						artifactId: 'ADR-031',
						field: 'id',
					}),
				])
		})

		it.each([
			['prd', 'REQ-001'],
			['decision', 'PRD-001'],
			['policy', 'CHG-001'],
			['change', 'POL-001'],
		] as const)('rejects a valid-but-wrong known prefix for %s', (type, id) => {
			const result = validateIdSyntax({ type, id }, 'x.md')
			expect(result)
				.toHaveLength(1)
			expect(result[0]!.code)
				.toBe('EF-ID-002')
		})
	})

	describe('eF-ID-003: non-canonical or zero numeric component', () => {
		it.each([
			'REQ-1',
			'REQ-01',
			'REQ-000',
			'REQ-0001',
			'REQ-01000',
			'REQ-00999',
		])('rejects non-canonical numeric id %s', (id) => {
			const result = validateIdSyntax({ type: 'requirement', id }, 'x.md')
			expect(result)
				.toHaveLength(1)
			expect(result[0]!.code)
				.toBe('EF-ID-003')
			expect(result[0]!.severity)
				.toBe('error')
			expect(result[0]!.artifactId)
				.toBe(id)
		})

		it('reports the zero-specific message for REQ-000', () => {
			const result = validateIdSyntax({ type: 'requirement', id: 'REQ-000' }, 'x.md')
			expect(result[0]!.message)
				.toBe(`ID numeric component '000' is zero, which is not a valid sequence number.`)
		})

		it('reports the canonical-form message for REQ-01', () => {
			const result = validateIdSyntax({ type: 'requirement', id: 'REQ-01' }, 'x.md')
			expect(result[0]!.message)
				.toBe(`ID numeric component '01' is not the canonical decimal representation of 1.`)
		})

		it('combines EF-ID-002 and EF-ID-003 when both the prefix and the numeric form are wrong', () => {
			const result = validateIdSyntax({ type: 'requirement', id: 'ADR-01' }, 'x.md')
			expect(result)
				.toEqual([
					diag({
						code: 'EF-ID-002',
						severity: 'error',
						message: `ID prefix 'ADR' does not match Artifact type 'requirement' (expected 'REQ').`,
						path: 'x.md',
						artifactId: 'ADR-01',
						field: 'id',
					}),
					diag({
						code: 'EF-ID-003',
						severity: 'error',
						message: `ID numeric component '01' is not the canonical decimal representation of 1.`,
						path: 'x.md',
						artifactId: 'ADR-01',
						field: 'id',
					}),
				])
		})
	})

	describe('eF-ID-011: unsupported or customized core prefix', () => {
		it.each([
			'XYZ-001',
			'req-031',
			'R-001',
			'DEC-005',
			'REQS-001',
			'Req-031',
		])('rejects unsupported prefix %s', (id) => {
			const result = validateIdSyntax({ type: 'requirement', id }, 'x.md')
			expect(result)
				.toHaveLength(1)
			expect(result[0]!.code)
				.toBe('EF-ID-011')
			expect(result[0]!.artifactId)
				.toBe(id)
		})

		it('does not also report EF-ID-002 or EF-ID-003 for an unsupported prefix', () => {
			const result = validateIdSyntax({ type: 'requirement', id: 'XREQ-01' }, 'x.md')
			expect(result)
				.toHaveLength(1)
			expect(result[0]!.code)
				.toBe('EF-ID-011')
		})
	})
})

describe('validateFilename', () => {
	it('accepts PROJECT.md at the canonical project path', () => {
		expect(validateFilename({ type: 'project', id: 'PROJECT' }, '.engineering/PROJECT.md'))
			.toEqual([])
	})

	it('accepts a canonical requirement path', () => {
		expect(validateFilename({ type: 'requirement', id: 'REQ-031' }, '.engineering/req/REQ-031.md'))
			.toEqual([])
	})

	it.each([
		['search-result-filtering.md'],
		['REQ-031-search-result-filtering.md'],
		['req-031.md'],
		['REQ-031.MD'],
	])('rejects invalid filename %s for id REQ-031 (spec examples)', (basename) => {
		const path = `.engineering/req/${basename}`
		const result = validateFilename({ type: 'requirement', id: 'REQ-031' }, path)
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-005',
					severity: 'error',
					message: `Filename '${basename}' does not match Artifact ID 'REQ-031'; expected 'REQ-031.md'.`,
					path,
					artifactId: 'REQ-031',
				}),
			])
	})

	it('rejects a bare filename with no directory at all', () => {
		const result = validateFilename({ type: 'requirement', id: 'REQ-031' }, 'REQ-031.md')
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-014',
					severity: 'error',
					message: `Artifact file is outside its canonical directory; expected it directly inside '.engineering/req'.`,
					path: 'REQ-031.md',
					artifactId: 'REQ-031',
				}),
			])
	})

	it('reports EF-ID-014 when the basename is correct but the directory is wrong', () => {
		const result = validateFilename({ type: 'requirement', id: 'REQ-031' }, '.engineering/prd/REQ-031.md')
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-014',
					severity: 'error',
					message: `Artifact file is outside its canonical directory; expected it directly inside '.engineering/req'.`,
					path: '.engineering/prd/REQ-031.md',
					artifactId: 'REQ-031',
				}),
			])
	})

	it('reports EF-ID-014 for a requirement nested one level too deep', () => {
		const result = validateFilename({ type: 'requirement', id: 'REQ-031' }, '.engineering/req/nested/REQ-031.md')
		expect(result.map(d => d.code))
			.toEqual(['EF-ID-014'])
	})

	it('reports EF-ID-014 for PROJECT placed in a type directory', () => {
		const result = validateFilename({ type: 'project', id: 'PROJECT' }, '.engineering/prd/PROJECT.md')
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-014',
					severity: 'error',
					message: `Artifact file is outside its canonical directory; expected it directly inside '.engineering'.`,
					path: '.engineering/prd/PROJECT.md',
					artifactId: 'PROJECT',
				}),
			])
	})

	it('reports both EF-ID-005 and EF-ID-014 when both the basename and the directory are wrong', () => {
		const result = validateFilename({ type: 'requirement', id: 'REQ-031' }, 'req-031.md')
		expect(result.map(d => d.code))
			.toEqual(['EF-ID-005', 'EF-ID-014'])
	})
})

describe('validateGraphIdentity', () => {
	it('accepts a graph with a single PROJECT and distinct IDs', () => {
		const result = validateGraphIdentity([
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/REQ-001.md' },
			{ id: 'PRD-001', type: 'prd', path: '.engineering/prd/PRD-001.md' },
		])
		expect(result)
			.toEqual([])
	})

	it('treats REQ-001 and ADR-001 as distinct, not duplicate, IDs', () => {
		const result = validateGraphIdentity([
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/REQ-001.md' },
			{ id: 'ADR-001', type: 'decision', path: '.engineering/adr/ADR-001.md' },
		])
		expect(result)
			.toEqual([])
	})

	it('reports EF-ID-004 with the bytewise-smallest path as primary, matching the spec example', () => {
		// Deliberately supplied out of bytewise order to prove the primary
		// selection does not depend on input order.
		const result = validateGraphIdentity([
			{ id: 'REQ-031', type: 'requirement', path: '.engineering/req/REQ-044.md' },
			{ id: 'REQ-031', type: 'requirement', path: '.engineering/req/REQ-031.md' },
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
		])
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-004',
					severity: 'error',
					message: `Artifact ID 'REQ-031' is duplicated.`,
					path: '.engineering/req/REQ-031.md',
					artifactId: 'REQ-031',
					related: [
						{ path: '.engineering/req/REQ-044.md', message: 'Duplicate identity is also declared here.' },
					],
				}),
			])
	})

	it('reports every participating file for a three-way duplicate', () => {
		const result = validateGraphIdentity([
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/c.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/a.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/b.md' },
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
		])
		expect(result)
			.toHaveLength(1)
		expect(result[0]!.path)
			.toBe('.engineering/req/a.md')
		expect(result[0]!.related)
			.toEqual([
				{ path: '.engineering/req/b.md', message: 'Duplicate identity is also declared here.' },
				{ path: '.engineering/req/c.md', message: 'Duplicate identity is also declared here.' },
			])
	})

	it('reports EF-ID-007 when no PROJECT Artifact is present', () => {
		const result = validateGraphIdentity([
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/REQ-001.md' },
		])
		expect(result)
			.toEqual([
				diag({
					code: 'EF-ID-007',
					severity: 'error',
					message: 'The project is missing a required PROJECT Artifact.',
				}),
			])
	})

	it('reports EF-ID-007 for a completely empty graph', () => {
		expect(validateGraphIdentity([]))
			.toEqual([
				diag({
					code: 'EF-ID-007',
					severity: 'error',
					message: 'The project is missing a required PROJECT Artifact.',
				}),
			])
	})

	it('reports EF-ID-006 when more than one PROJECT Artifact exists, even with different filenames', () => {
		const result = validateGraphIdentity([
			{ id: 'PROJECT', type: 'project', path: '.engineering/other/PROJECT.md' },
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
		])
		// Same id 'PROJECT' on both files is also a duplicate identity.
		expect(result.map(d => d.code))
			.toEqual(['EF-ID-004', 'EF-ID-006'])
		const singleton = result.find(d => d.code === 'EF-ID-006')!
		expect(singleton)
			.toEqual(diag({
				code: 'EF-ID-006',
				severity: 'error',
				message: 'More than one PROJECT Artifact exists.',
				path: '.engineering/PROJECT.md',
				artifactId: 'PROJECT',
				related: [
					{ path: '.engineering/other/PROJECT.md', message: 'Another PROJECT Artifact is declared here.' },
				],
			}))
	})

	it('does not report EF-ID-006 or EF-ID-004 when exactly one PROJECT exists alongside an unrelated duplicate', () => {
		const result = validateGraphIdentity([
			{ id: 'PROJECT', type: 'project', path: '.engineering/PROJECT.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/a.md' },
			{ id: 'REQ-001', type: 'requirement', path: '.engineering/req/b.md' },
		])
		expect(result.map(d => d.code))
			.toEqual(['EF-ID-004'])
	})
})

describe('nextId', () => {
	it('allocates 001 for an empty existing set', () => {
		expect(nextId('REQ', []))
			.toBe('REQ-001')
	})

	it('allocates the next id after the greatest existing canonical number (spec example)', () => {
		expect(nextId('REQ', ['REQ-041', 'REQ-042', 'REQ-044']))
			.toBe('REQ-045')
	})

	it('does not fill gaps', () => {
		expect(nextId('REQ', ['REQ-001', 'REQ-999']))
			.not
			.toBe('REQ-002')
	})

	it('rolls over the three-to-four-digit boundary (REQ-999 -> REQ-1000)', () => {
		expect(nextId('REQ', ['REQ-999']))
			.toBe('REQ-1000')
	})

	it('continues without padding above 1000', () => {
		expect(nextId('REQ', ['REQ-1000']))
			.toBe('REQ-1001')
	})

	it('ignores IDs with a different prefix', () => {
		expect(nextId('REQ', ['ADR-999', 'PRD-500']))
			.toBe('REQ-001')
	})

	it('ignores malformed suffixes that are not purely numeric', () => {
		expect(nextId('REQ', ['REQ-abc', 'REQ-12a']))
			.toBe('REQ-001')
	})

	it('compares numerically rather than lexicographically', () => {
		// String comparison would rank 'REQ-9' above 'REQ-10'.
		expect(nextId('REQ', ['REQ-9', 'REQ-10']))
			.toBe('REQ-011')
	})

	it('uses arbitrary-precision arithmetic beyond Number.MAX_SAFE_INTEGER', () => {
		const huge = (BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString()
		const result = nextId('REQ', [`REQ-${huge}`])
		const expected = `REQ-${(BigInt(huge) + 1n).toString()}`
		expect(result)
			.toBe(expected)
		// Sanity check that this value is indeed beyond safe integer range.
		expect(BigInt(huge) > BigInt(Number.MAX_SAFE_INTEGER))
			.toBe(true)
	})

	it('allocates independently per prefix from a mixed existing set', () => {
		const existing = ['PRD-005', 'REQ-041', 'REQ-042', 'REQ-044', 'ADR-002', 'POL-010', 'CHG-003']
		expect(nextId('PRD', existing))
			.toBe('PRD-006')
		expect(nextId('REQ', existing))
			.toBe('REQ-045')
		expect(nextId('ADR', existing))
			.toBe('ADR-003')
		expect(nextId('POL', existing))
			.toBe('POL-011')
		expect(nextId('CHG', existing))
			.toBe('CHG-004')
	})
})
