import type { QueryContext } from './query'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { executeQuery, incompleteInitializationQueryResult } from './query'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A rich example project used for query engine tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering workflow.
`

const PRD_001 = `---
schema: ef/prd@1
type: prd
id: PRD-001
title: Search Platform
status: active
summary: Product requirements for the search platform.
tags: []
relations: []
resources: []
---

## Vision

Provide best-in-class search.

## Objectives

Improve findability.
`

const REQ_001 = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Search Result Filtering
status: active
summary: Search results must support filtering.
tags:
  - alpha
relations:
  - type: derived-from
    target: PRD-001
  - type: governed-by
    target: POL-001
resources:
  - type: reference
    location: .engineering/resources/REQ-001/notes.md
    role: reference
    media_type: text/markdown
    normative: false
    description: Supplementary notes.
---

## Requirement

The system must support filtering.

## Rationale

Because users need it.

## Acceptance Criteria

- Filtering works.
`

const REQ_002 = `---
schema: ef/requirement@1
type: requirement
id: REQ-002
title: Search Ranking
status: active
summary: Search results must be ranked by relevance.
tags: []
relations:
  - type: derived-from
    target: PRD-001
resources: []
---

## Requirement

The system must rank results.

## Rationale

Because relevance matters.

## Acceptance Criteria

- Ranking works.
`

function supersessionReq(id: string, status: string, supersededBy?: string): string {
	const relations = supersededBy
		? `relations:\n  - type: superseded-by\n    target: ${supersededBy}\n`
		: `relations: []\n`
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Title of ${id}
status: ${status}
summary: Summary of ${id}.
tags: []
${relations}resources: []
---

## Requirement

Body text for ${id}.
${status === 'superseded' || status === 'retired'
	? '\n## Lifecycle\n\nSuperseded by its replacement.\n'
	: ''}`
}

const ADR_001 = `---
schema: ef/decision@1
type: decision
id: ADR-001
title: Adopt Filtering Approach
status: active
summary: Decision record for the filtering approach.
tags: []
relations:
  - type: addresses
    target: REQ-001
resources: []
---

## Context

Filtering context.

## Decision

We will filter.

## Consequences

Better filtering.
`

const POL_001 = `---
schema: ef/policy@1
type: policy
id: POL-001
title: Data Handling Policy
status: active
summary: Policy governing data handling for search.
tags: []
relations: []
resources: []
---

## Policy Statement

Handle data responsibly.

## Rationale

Compliance.
`

const CHG_001 = `---
schema: ef/change@1
type: change
id: CHG-001
title: Introduce Filtering
status: completed
summary: Change that introduced filtering behavior.
tags: []
relations:
  - type: modifies
    target: REQ-001
resources: []
---

## Rationale

Rationale text.

## Sources

Sources text.

## Changes

- Added filtering.

## Verification

Result: passed

- Verified.
`

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

async function writeRichProject(root: string): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
	await writeFile(root, '.engineering/prd/PRD-001.md', PRD_001)
	await writeFile(root, '.engineering/req/REQ-001.md', REQ_001)
	await writeFile(root, '.engineering/req/REQ-002.md', REQ_002)
	await writeFile(root, '.engineering/req/REQ-010.md', supersessionReq('REQ-010', 'superseded', 'REQ-011'))
	await writeFile(root, '.engineering/req/REQ-011.md', supersessionReq('REQ-011', 'superseded', 'REQ-012'))
	await writeFile(root, '.engineering/req/REQ-012.md', supersessionReq('REQ-012', 'active'))
	await writeFile(root, '.engineering/adr/ADR-001.md', ADR_001)
	await writeFile(root, '.engineering/pol/POL-001.md', POL_001)
	await writeFile(root, '.engineering/chg/CHG-001.md', CHG_001)
	await writeFile(root, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
}

describe('executeQuery', () => {
	let tempDir: string
	let context: QueryContext

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-query-')))
		await writeRichProject(tempDir)
		const result = await loadSnapshotFromWorkingTree(tempDir)
		if (!result.ok)
			throw new Error(`failed to load snapshot: ${result.reason}`)
		context = { snapshot: result.snapshot, validation: validateSnapshot(result.snapshot) }
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	describe('envelope shape', () => {
		it('always uses the fixed ef/query-result@1 schema and echoes the requested kind', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-001' })
			expect(result.schema)
				.toBe('ef/query-result@1')
			expect(result.kind)
				.toBe('lookup')
		})
	})

	describe('lookup', () => {
		it('defaults to full projection and includes body', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-001' })
			expect(result.complete)
				.toBe(true)
			expect(result.data)
				.toMatchObject({ found: true })
			const artifact = result.data!.artifact as Record<string, unknown>
			expect(artifact.id)
				.toBe('REQ-001')
			expect(typeof artifact.body)
				.toBe('string')
			expect((artifact.body as string))
				.toContain('The system must support filtering.')
		})

		it('summary projection omits body', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-001', projection: 'summary' })
			const artifact = result.data!.artifact as Record<string, unknown>
			expect('body' in artifact)
				.toBe(false)
		})

		it('a superseded lookup returns the exact historical Artifact and its outgoing superseded-by relations, not active leaves', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-010', projection: 'summary' })
			const artifact = result.data!.artifact as Record<string, unknown>
			expect(artifact.status)
				.toBe('superseded')
			expect(artifact.relations)
				.toEqual([{ type: 'superseded-by', target: 'REQ-011' }])
		})

		it('found:false is a complete, normal result with an EF-QRY-003 info diagnostic', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-999' })
			expect(result.complete)
				.toBe(true)
			expect(result.data)
				.toEqual({ found: false, artifact: null })
			expect(result.diagnostics)
				.toEqual([expect.objectContaining({ code: 'EF-QRY-003', severity: 'info' })])
		})

		it('eF-QRY-001 for an empty Artifact ID', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: '' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-004 for an unsupported projection', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-001', projection: 'raw' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-004')
		})
	})

	describe('list', () => {
		it('returns Artifact summaries in bytewise Artifact ID order with total before pagination', async () => {
			const result = await executeQuery(context, { kind: 'list', type: ['requirement'] })
			expect(result.data!.total)
				.toBe(5)
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001', 'REQ-002', 'REQ-010', 'REQ-011', 'REQ-012'])
		})

		it('type/status filters use OR semantics across multiple values', async () => {
			const result = await executeQuery(context, { kind: 'list', type: ['prd', 'policy'] })
			expect(result.data!.artifacts.map(a => a.id)
				.sort())
				.toEqual(['POL-001', 'PRD-001'])
		})

		it('tags_all uses AND semantics', async () => {
			const result = await executeQuery(context, { kind: 'list', tagsAll: ['alpha'] })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001'])
		})

		it('relation_type and relation_target combined require one entry to satisfy both', async () => {
			const matching = await executeQuery(context, { kind: 'list', relationType: 'derived-from', relationTarget: 'PRD-001' })
			expect(matching.data!.artifacts.map(a => a.id)
				.sort())
				.toEqual(['REQ-001', 'REQ-002'])

			const nonMatching = await executeQuery(context, { kind: 'list', relationType: 'governed-by', relationTarget: 'PRD-001' })
			expect(nonMatching.data!.artifacts)
				.toEqual([])
		})

		it('resource filters combine on one Resource descriptor', async () => {
			const result = await executeQuery(context, { kind: 'list', resourceType: 'reference', resourceNormative: false })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001'])
		})

		it('offset/limit paginate after sorting, and total reflects the pre-pagination count', async () => {
			const result = await executeQuery(context, { kind: 'list', type: ['requirement'], offset: 1, limit: 2 })
			expect(result.data)
				.toEqual({
					total: 5,
					offset: 1,
					limit: 2,
					artifacts: expect.arrayContaining([expect.objectContaining({ id: 'REQ-002' }), expect.objectContaining({ id: 'REQ-010' })]),
				})
			expect(result.data!.artifacts)
				.toHaveLength(2)
		})

		it('eF-QRY-002 for an unknown type value', async () => {
			const result = await executeQuery(context, { kind: 'list', type: ['not-a-type'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
		})
	})

	describe('search', () => {
		it('returns the fixed search envelope shape', async () => {
			const result = await executeQuery(context, { kind: 'search', terms: ['filtering'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.terms)
				.toEqual(['filtering'])
			expect(result.data!.results.map(r => r.artifact.id))
				.toContain('REQ-001')
		})

		it('eF-QRY-001 when no terms are supplied', async () => {
			const result = await executeQuery(context, { kind: 'search', terms: [] })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-002 for an empty term', async () => {
			const result = await executeQuery(context, { kind: 'search', terms: [''] })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
		})
	})

	describe('relations', () => {
		it('returns outgoing + incoming edges by default (direction: both)', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-001' })
			expect(result.data!.direction)
				.toBe('both')
			expect(result.data!.edges)
				.toEqual(expect.arrayContaining([
					{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' },
					{ source: 'REQ-001', type: 'governed-by', target: 'POL-001' },
					{ source: 'ADR-001', type: 'addresses', target: 'REQ-001' },
					{ source: 'CHG-001', type: 'modifies', target: 'REQ-001' },
				]))
		})

		it('an incoming query does not rename the edge to a different canonical type', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-011', direction: 'incoming' })
			expect(result.data!.edges)
				.toEqual([{ source: 'REQ-010', type: 'superseded-by', target: 'REQ-011' }])
		})

		it('eF-QRY-001 for an empty Artifact ID', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: '' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-006 for an invalid direction', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-001', direction: 'sideways' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-006')
		})

		it('eF-QRY-002 for an unknown relation type filter', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-001', types: ['not-a-type'] })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
		})

		it('eF-QRY-014 when the Artifact ID does not exist', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-999' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-014')
		})
	})

	describe('trace', () => {
		it('returns roots at depth 0 and traverses to the requested depth', async () => {
			const result = await executeQuery(context, {
				kind: 'trace',
				roots: ['PRD-001'],
				types: ['derived-from'],
				direction: 'incoming',
				maxDepth: 4,
			})
			expect(result.data!.nodes)
				.toEqual([
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'PRD-001' }), depth: 0 }),
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'REQ-001' }), depth: 1 }),
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'REQ-002' }), depth: 1 }),
				])
		})

		it('max_depth 0 returns only roots and an empty edges array', async () => {
			const result = await executeQuery(context, {
				kind: 'trace',
				roots: ['PRD-001'],
				types: ['derived-from'],
				direction: 'incoming',
				maxDepth: 0,
			})
			expect(result.data!.nodes)
				.toEqual([expect.objectContaining({ depth: 0 })])
			expect(result.data!.edges)
				.toEqual([])
		})

		it('eF-QRY-001 for zero roots', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: [], types: ['derived-from'], direction: 'both', maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-005 for an empty relation type set', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: ['PRD-001'], types: [], direction: 'both', maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-005')
		})

		it('eF-QRY-006 for an invalid max_depth', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: ['PRD-001'], types: ['derived-from'], direction: 'both', maxDepth: -1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-006')
		})

		it('eF-QRY-014 when a root does not exist', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: ['REQ-999'], types: ['derived-from'], direction: 'both', maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-014')
		})
	})

	describe('impact', () => {
		it('includes the root at depth 0 as context and active dependents as candidates, chaining through further impact edges', async () => {
			// POL-001 <-governed-by- REQ-001 <-addresses- ADR-001: a genuine
			// two-hop impact chain, since both "governed-by" and "addresses"
			// are in the Core v1 impact edge set.
			const result = await executeQuery(context, { kind: 'impact', roots: ['POL-001'], maxDepth: 4 })
			expect(result.data!.impact.nodes)
				.toEqual([
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'POL-001' }), depth: 0 }),
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'REQ-001' }), depth: 1 }),
					expect.objectContaining({ artifact: expect.objectContaining({ id: 'ADR-001' }), depth: 2 }),
				])
			expect(result.data!.resolved_roots)
				.toEqual(['POL-001'])
		})

		it('bounds traversal by max_depth', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: ['POL-001'], maxDepth: 1 })
			expect(result.data!.impact.nodes.map(n => n.artifact.id))
				.toEqual(['POL-001', 'REQ-001'])
		})

		it('resolve_current resolves roots first and retains both subgraphs', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: ['REQ-010'], maxDepth: 2, resolveCurrent: true })
			expect(result.data!.resolve_current)
				.toBe(true)
			expect(result.data!.resolved_roots)
				.toEqual(['REQ-012'])
			expect(result.data!.resolution.nodes.map(n => n.id))
				.toEqual(['REQ-010', 'REQ-011', 'REQ-012'])
			expect(result.data!.impact.nodes)
				.toEqual([expect.objectContaining({ artifact: expect.objectContaining({ id: 'REQ-012' }), depth: 0 })])
		})

		it('eF-QRY-009 when resolve_current is requested for a CHG root', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: ['CHG-001'], maxDepth: 1, resolveCurrent: true })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-009')
		})

		it('eF-QRY-001 for zero roots', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: [], maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-006 for an invalid max_depth', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: ['POL-001'], maxDepth: -1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-006')
		})

		it('eF-QRY-014 when a root does not exist', async () => {
			const result = await executeQuery(context, { kind: 'impact', roots: ['REQ-999'], maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-014')
		})
	})

	describe('resolve-current', () => {
		it('resolves recursively through every replacement in a supersession chain', async () => {
			const result = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-010' })
			expect(result.data!.current_ids)
				.toEqual(['REQ-012'])
			expect(result.data!.nodes.map(n => n.id))
				.toEqual(['REQ-010', 'REQ-011', 'REQ-012'])
			expect(result.data!.edges)
				.toEqual([
					{ source: 'REQ-010', type: 'superseded-by', target: 'REQ-011' },
					{ source: 'REQ-011', type: 'superseded-by', target: 'REQ-012' },
				])
		})

		it('an active input resolves to itself with one node and no edges', async () => {
			const result = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-001' })
			expect(result.data!.current_ids)
				.toEqual(['REQ-001'])
			expect(result.data!.nodes.map(n => n.id))
				.toEqual(['REQ-001'])
			expect(result.data!.edges)
				.toEqual([])
		})

		it('eF-QRY-009 for a CHG Artifact', async () => {
			const result = await executeQuery(context, { kind: 'resolve-current', id: 'CHG-001' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-009')
		})

		it('eF-QRY-014 when the Artifact does not exist', async () => {
			const result = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-999' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-014')
		})

		it('eF-QRY-001 for an empty Artifact ID', async () => {
			const result = await executeQuery(context, { kind: 'resolve-current', id: '' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})
	})

	describe('history', () => {
		it('eF-QRY-010 when no history context is available', async () => {
			const result = await executeQuery(context, { kind: 'history', id: 'REQ-001' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-010')
		})

		it('eF-QRY-014 when the Artifact does not exist, checked before history context', async () => {
			const result = await executeQuery(context, { kind: 'history', id: 'REQ-999' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-014')
		})

		it('succeeds end-to-end with a real Git history context', async () => {
			const GIT_TEST_ENV = {
				GIT_AUTHOR_NAME: 'EF Test',
				GIT_AUTHOR_EMAIL: 'ef-test@example.com',
				GIT_COMMITTER_NAME: 'EF Test',
				GIT_COMMITTER_EMAIL: 'ef-test@example.com',
			}
			execFileSync('git', ['-C', tempDir, 'init', '-q', '-b', 'main'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'add', '-A'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'commit', '-q', '-m', 'bootstrap'], { env: { ...process.env, ...GIT_TEST_ENV } })
			const tipOid = execFileSync('git', ['-C', tempDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
				.trim()

			const historyContext: QueryContext = {
				...context,
				history: { git: createGitRepository(tempDir, createGitExecutor()), integrationRefOid: tipOid },
			}
			const result = await executeQuery(historyContext, { kind: 'history', id: 'REQ-001' })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifact_id)
				.toBe('REQ-001')
			expect(result.data!.commits.map(c => c.oid))
				.toEqual([tipOid])
			expect(result.data!.commits[0]!.changed_paths)
				.toEqual(expect.arrayContaining(['.engineering/req/REQ-001.md']))
		})
	})

	describe('incompleteInitializationQueryResult', () => {
		it('produces the EF-QRY-013 incomplete envelope for the requested kind', () => {
			const result = incompleteInitializationQueryResult('lookup')
			expect(result)
				.toEqual({
					schema: 'ef/query-result@1',
					kind: 'lookup',
					complete: false,
					data: null,
					diagnostics: [expect.objectContaining({ code: 'EF-QRY-013', severity: 'error' })],
				})
		})
	})
})
