import type { ArtifactType, Envelope, RelationEntry, Status } from '../domain/model'
import type { GitRepository } from '../git/repository'
import type { QueryContext } from './query'
import type { ProjectSnapshot } from './snapshot'
import type { IncomingRelationEdge, SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
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

const REQ_777_MISFILED = `---
schema: ef/requirement@1
type: requirement
id: REQ-777
title: Misfiled Requirement
status: active
summary: A well-formed, unambiguous requirement declared under the wrong filename.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-ID-005-only (filename does not match ID) staying ungated.

## Rationale

Confirms EF-ID-005 alone does not flip graphTrustworthy.

## Acceptance Criteria

- N/A.
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

const REQ_GHOST_SRC = `---
schema: ef/requirement@1
type: requirement
id: REQ-901
title: Ghost Source
status: active
summary: A requirement with a dangling relation target, for graph-invalid tests.
tags: []
relations:
  - type: derived-from
    target: PRD-GHOST
resources: []
---

## Requirement

Exercises a dangling relation target reached during traversal.

## Rationale

Exercises EF-QRY-007.

## Acceptance Criteria

- N/A.
`

const REQ_GHOST_SUP = `---
schema: ef/requirement@1
type: requirement
id: REQ-902
title: Ghost Superseded
status: superseded
summary: A superseded requirement whose replacement does not exist, for invalid-graph tests.
tags: []
relations:
  - type: superseded-by
    target: REQ-GHOST-REPLACEMENT
resources: []
---

## Requirement

Exercises a dangling supersession target.

## Rationale

Exercises EF-QRY-008 (invalid-graph).

## Acceptance Criteria

- N/A.
`

const REQ_BAD_RELATION = `---
schema: ef/requirement@1
type: requirement
id: REQ-950
title: Bad Relation Requirement
status: active
summary: A requirement whose relations array contains a shape-invalid entry, for Finding A discarded-relation-data regressions.
tags: []
relations:
  - type: derived-from
    target: PRD-001
  - not-a-mapping
resources: []
---

## Requirement

Exercises EF-REL-002 discarding a relation entry from both the sanitized graph indexes and the raw projection alike.

## Rationale

Exercises Finding A's discarded-relation-data gate.

## Acceptance Criteria

- N/A.
`

const ADR_REFERENCES_POL = `---
schema: ef/decision@1
type: decision
id: ADR-901
title: References Policy
status: active
summary: A decision that references POL-001, for include_references tests.
tags: []
relations:
  - type: references
    target: POL-001
resources: []
---

## Context

References fixture context.

## Decision

N/A.

## Consequences

N/A.
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

/** Builds a minimal, self-consistent {@link SnapshotArtifactRecord} without going through frontmatter/envelope decoding, for hand-built graph fixtures. */
function fabricatedRecord(id: string, type: ArtifactType, status: Status, relations: RelationEntry[] = []): SnapshotArtifactRecord {
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
 * Builds a minimal, type-correct {@link QueryContext} directly from hand-built
 * `byId`/`incomingRelations` indexes, bypassing snapshot loading and
 * validation entirely. `impactGraph`'s "dangling incoming reference"
 * graph-invalid case (an incoming edge whose `from` Artifact ID is absent
 * from `byId`) cannot arise from a real, self-consistent
 * `validateSnapshot` result -- `incomingRelations` is always indexed from
 * the same file outcomes that populate `byId` -- so exercising it precisely
 * requires constructing the two indexes independently, the same technique
 * `query-graph.unit.test.ts` already uses for this exact scenario.
 */
function fabricatedContext(byId: Map<string, SnapshotArtifactRecord>, incomingRelations: Map<string, IncomingRelationEdge[]>): QueryContext {
	const snapshot: ProjectSnapshot = {
		source: { kind: 'working-tree', projectRoot: '/fabricated' },
		configBytes: undefined,
		config: { config: null, diagnostics: [] },
		gitignoreBytes: undefined,
		artifacts: [],
		resourceFiles: [],
		entryKinds: new Map(),
		layoutDiagnostics: [],
	}
	const validation: SnapshotValidationResult = {
		diagnostics: [],
		complete: true,
		byId,
		incomingRelations,
		resourceOwnership: new Map(),
		currentIds: new Map(),
		chgEffects: [],
		graphTrustworthy: true,
		edgeLossArtifactIds: new Set(),
		relationExtensionLossArtifactIds: new Set(),
		resourceLossArtifactIds: new Set(),
		tagLossArtifactIds: new Set(),
		envelopeWideLossArtifactIds: new Set(),
		projectionLossArtifactIds: new Set(),
	}
	return { snapshot, validation }
}

/**
 * Delegates every {@link GitRepository} method to `real` except the ones
 * named in `overrides`, so a single low-level Git outcome can be forced
 * without spawning a real Git failure.
 */
function wrapGitRepository(real: GitRepository, overrides: Partial<GitRepository>): GitRepository {
	return {
		root: real.root,
		findWorktreeRoot: overrides.findWorktreeRoot ?? real.findWorktreeRoot.bind(real),
		getObjectFormat: overrides.getObjectFormat ?? real.getObjectFormat.bind(real),
		resolveCommit: overrides.resolveCommit ?? real.resolveCommit.bind(real),
		resolveRef: overrides.resolveRef ?? real.resolveRef.bind(real),
		getFirstParent: overrides.getFirstParent ?? real.getFirstParent.bind(real),
		readTree: overrides.readTree ?? real.readTree.bind(real),
		readBlob: overrides.readBlob ?? real.readBlob.bind(real),
		listFirstParentHistory: overrides.listFirstParentHistory ?? real.listFirstParentHistory.bind(real),
		pathExistsInFirstParentHistory: overrides.pathExistsInFirstParentHistory ?? real.pathExistsInFirstParentHistory.bind(real),
		diffTrees: overrides.diffTrees ?? real.diffTrees.bind(real),
	}
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

	/** Reloads `context` from `tempDir`'s current contents, for tests that add extra fixture files after `beforeEach`. */
	async function reloadContext(): Promise<QueryContext> {
		const result = await loadSnapshotFromWorkingTree(tempDir)
		if (!result.ok)
			throw new Error(`failed to load snapshot: ${result.reason}`)
		return { snapshot: result.snapshot, validation: validateSnapshot(result.snapshot) }
	}

	describe('envelope shape', () => {
		it('always uses the fixed ef/query-result@1 schema and echoes the requested kind', async () => {
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-001' })
			expect(result.schema)
				.toBe('ef/query-result@1')
			expect(result.kind)
				.toBe('lookup')
		})
	})

	describe('graph trustworthiness gate (10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
		/** Makes REQ-001's ID ambiguous (a second file also declares `id: REQ-001`), which flips `context.validation.graphTrustworthy` to `false` project-wide. */
		async function untrustworthyContext(): Promise<QueryContext> {
			await writeFile(tempDir, '.engineering/req/REQ-050.md', REQ_001)
			return reloadContext()
		}

		it('every query kind returns complete: false, data: null, EF-QRY-013 once an ID is ambiguous -- including exact lookup for an untouched, existing Artifact', async () => {
			const bad = await untrustworthyContext()

			const lookupFound = await executeQuery(bad, { kind: 'lookup', id: 'REQ-002' })
			expect(lookupFound.complete)
				.toBe(false)
			expect(lookupFound.data)
				.toBeNull()
			expect(lookupFound.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates exact lookup not-found too, instead of the normal complete: true / found: false result', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'lookup', id: 'REQ-999' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates list', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'list' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates search', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'search', terms: ['filtering'] })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates relations', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'relations', id: 'REQ-002' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates trace', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'trace', roots: ['REQ-002'], types: ['derived-from'], direction: 'outgoing', maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates impact', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'impact', roots: ['REQ-002'], maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates resolve-current', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'resolve-current', id: 'REQ-002' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates history', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'history', id: 'REQ-002' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('does not gate a body-schema-only warning/error that leaves every Artifact decoded in byId', async () => {
			// A sanity check that the gate is specific to decode/identity/layout
			// conditions: the untouched, valid rich-project fixture itself must
			// stay ungated.
			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-002' })
			expect(result.complete)
				.toBe(true)
		})

		it('still lets request-shape validation (EF-QRY-001) take precedence over the trustworthiness gate', async () => {
			const bad = await untrustworthyContext()
			const result = await executeQuery(bad, { kind: 'lookup', id: '' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		// Finding C (adjudicated ruling): the gate must also cover mandatory
		// PROJECT identity failures (EF-ID-007/008), not just duplicate-ID/
		// PROJECT-singleton/undecoded-file/layout conditions. Without this,
		// `lookup PROJECT` returned the ordinary `complete: true, found: false`
		// result, and `list`/`search` returned an otherwise-"complete"
		// collection, even with no trustworthy PROJECT context loaded.

		it('gates lookup PROJECT, list, and search when the required PROJECT Artifact is missing (EF-ID-007)', async () => {
			await fs.rm(path.join(tempDir, '.engineering/PROJECT.md'))
			const bad = await reloadContext()
			expect(bad.validation.graphTrustworthy)
				.toBe(false)

			const lookup = await executeQuery(bad, { kind: 'lookup', id: 'PROJECT' })
			expect(lookup.complete)
				.toBe(false)
			expect(lookup.data)
				.toBeNull()
			expect(lookup.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const list = await executeQuery(bad, { kind: 'list' })
			expect(list.complete)
				.toBe(false)
			expect(list.data)
				.toBeNull()
			expect(list.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const search = await executeQuery(bad, { kind: 'search', terms: ['filtering'] })
			expect(search.complete)
				.toBe(false)
			expect(search.data)
				.toBeNull()
			expect(search.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates lookup PROJECT, list, and search when PROJECT declares an ID other than PROJECT (EF-ID-008)', async () => {
			await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD.replace('id: PROJECT', 'id: NOTPROJECT'))
			const bad = await reloadContext()
			expect(bad.validation.graphTrustworthy)
				.toBe(false)

			const lookup = await executeQuery(bad, { kind: 'lookup', id: 'PROJECT' })
			expect(lookup.complete)
				.toBe(false)
			expect(lookup.data)
				.toBeNull()
			expect(lookup.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const list = await executeQuery(bad, { kind: 'list' })
			expect(list.complete)
				.toBe(false)
			expect(list.data)
				.toBeNull()
			expect(list.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const search = await executeQuery(bad, { kind: 'search', terms: ['filtering'] })
			expect(search.complete)
				.toBe(false)
			expect(search.data)
				.toBeNull()
			expect(search.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('stays ungated for an EF-ID-005-only filename mismatch: the declared ID is unique and decoded, so queries still succeed', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			const ok = await reloadContext()
			expect(ok.validation.graphTrustworthy)
				.toBe(true)

			const lookup = await executeQuery(ok, { kind: 'lookup', id: 'REQ-777' })
			expect(lookup.complete)
				.toBe(true)
			expect(lookup.data?.found)
				.toBe(true)

			const list = await executeQuery(ok, { kind: 'list' })
			expect(list.complete)
				.toBe(true)

			const search = await executeQuery(ok, { kind: 'search', terms: ['misfiled'] })
			expect(search.complete)
				.toBe(true)
		})
	})

	describe('structured data loss gate (Finding A: 10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
		/** Adds REQ-950 (a shape-invalid relation entry, EF-REL-002) to the rich project fixture. */
		async function contextWithDiscardedRelationData(): Promise<QueryContext> {
			await writeFile(tempDir, '.engineering/req/REQ-950.md', REQ_BAD_RELATION)
			return reloadContext()
		}

		it('sets validation.edgeLossArtifactIds/projectionLossArtifactIds and tracks only the affected artifact', async () => {
			const bad = await contextWithDiscardedRelationData()
			expect([...bad.validation.edgeLossArtifactIds])
				.toEqual(['REQ-950'])
			expect([...bad.validation.projectionLossArtifactIds])
				.toEqual(['REQ-950'])
		})

		it('gates lookup (full projection) with EF-QRY-013 for the specific affected Artifact', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'lookup', id: 'REQ-950' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates lookup (summary projection) with EF-QRY-013 for the specific affected Artifact too', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'lookup', id: 'REQ-950', projection: 'summary' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('does NOT gate lookup for an untouched Artifact: the projection gate is per-artifact, not project-wide', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'lookup', id: 'REQ-001' })
			expect(result.complete)
				.toBe(true)
			expect(result.data?.found)
				.toBe(true)
		})

		it('gates list with EF-QRY-013 when the affected Artifact is included in the returned page', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'list' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('does NOT gate list when a type filter excludes the affected Artifact from the returned page', async () => {
			const bad = await contextWithDiscardedRelationData()
			// REQ-950 is a 'requirement'; excluding that type leaves it out of
			// this result entirely, so the result can honestly report complete.
			const result = await executeQuery(bad, { kind: 'list', type: ['prd'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.some(a => a.id === 'REQ-950'))
				.toBe(false)
		})

		it('gates search with EF-QRY-013 when a matching result includes the affected Artifact', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'search', terms: ['discarding'] })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('does NOT gate search when no returned match includes the affected Artifact', async () => {
			const bad = await contextWithDiscardedRelationData()
			const result = await executeQuery(bad, { kind: 'search', terms: ['filtering'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.results.some(r => r.artifact.id === 'REQ-950'))
				.toBe(false)
		})

		it('gates relations (default direction "both")/trace ("both")/impact project-wide (EF-QRY-013), even when querying an untouched Artifact: these all depend on incoming edges, derived from every Artifact\'s outgoing array project-wide (Finding C)', async () => {
			const bad = await contextWithDiscardedRelationData()

			const relations = await executeQuery(bad, { kind: 'relations', id: 'REQ-001' })
			expect(relations.complete)
				.toBe(false)
			expect(relations.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const trace = await executeQuery(bad, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from'], direction: 'both', maxDepth: 1 })
			expect(trace.complete)
				.toBe(false)
			expect(trace.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const impact = await executeQuery(bad, { kind: 'impact', roots: ['REQ-001'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(false)
			expect(impact.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('finding C: does NOT gate resolve-current for a root whose current-resolution result never reaches the affected, disconnected Artifact: resolve-current is outgoing-only, so it is scoped to its own result', async () => {
			const bad = await contextWithDiscardedRelationData()

			// REQ-950 (the affected Artifact) only relates to PRD-001; REQ-001 has
			// no 'superseded-by' relation at all, so resolving its current form
			// never visits anything REQ-950 touches.
			const resolveCurrent = await executeQuery(bad, { kind: 'resolve-current', id: 'REQ-001' })
			expect(resolveCurrent.complete)
				.toBe(true)
			expect(resolveCurrent.data!.current_ids)
				.toEqual(['REQ-001'])
		})

		it('eF-REL-003 (dangling relation target) does not set edge/projection loss; only a traversal that actually reaches the dangling edge fails, via the existing EF-QRY-007 path', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-901.md', REQ_GHOST_SRC)
			const ghostContext = await reloadContext()
			expect(ghostContext.validation.edgeLossArtifactIds.size)
				.toBe(0)
			expect(ghostContext.validation.projectionLossArtifactIds.size)
				.toBe(0)

			// An unrelated relations query elsewhere in the graph is unaffected.
			const unrelated = await executeQuery(ghostContext, { kind: 'relations', id: 'REQ-001' })
			expect(unrelated.complete)
				.toBe(true)

			// Traversal that actually reaches the dangling target still fails,
			// via the pre-existing, unchanged EF-QRY-007 path.
			const result = await executeQuery(ghostContext, { kind: 'relations', id: 'REQ-901', types: ['derived-from'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-007')
		})
	})

	describe('graph query edge-loss scoping (Finding C: 10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
		const REQ_EXT_ONLY_LOSS = `---
schema: ef/requirement@1
type: requirement
id: REQ-700
title: Extension Only Loss
status: active
summary: A requirement whose only relation-data loss is an invalid extension field (EF-REL-015), for Finding C's not-blocking regression.
tags: []
relations:
  - type: derived-from
    target: PRD-001
    foo: bar
resources: []
---

## Requirement

Exercises EF-REL-015 (invalid extension field) not blocking any graph query kind.

## Rationale

Finding C: extension-only loss can never hide a graph edge, since graph edges are (source, type, target) only.

## Acceptance Criteria

- N/A.
`

		const PRD_ISLAND = `---
schema: ef/prd@1
type: prd
id: PRD-800
title: Isolated Island PRD
status: active
summary: A PRD with no relation to any other fixture Artifact, for Finding C's disconnected-component regression.
tags: []
relations: []
resources: []
---

## Vision

N/A.

## Objectives

N/A.
`

		const REQ_ISLAND_LOSSY = `---
schema: ef/requirement@1
type: requirement
id: REQ-800
title: Island Requirement With Discarded Relation Data
status: active
summary: A requirement in its own disconnected component whose relations array contains a shape-invalid entry, for Finding C's disconnected-component regression.
tags: []
relations:
  - type: derived-from
    target: PRD-800
  - not-a-mapping
resources: []
---

## Requirement

Exercises EF-REL-002 in a component entirely disconnected from the rest of the fixture graph.

## Rationale

Finding C: an edge-lossy Artifact outside a traversal's reachable component must not block that traversal.

## Acceptance Criteria

- N/A.
`

		it('eF-REL-015-only loss (invalid extension field) does not block relations (any direction), trace, impact, or resolve-current -- even when the affected Artifact is the traversal root', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-700.md', REQ_EXT_ONLY_LOSS)
			const context = await reloadContext()
			expect(context.validation.edgeLossArtifactIds.size)
				.toBe(0)
			expect([...context.validation.relationExtensionLossArtifactIds])
				.toEqual(['REQ-700'])

			const relationsBoth = await executeQuery(context, { kind: 'relations', id: 'REQ-700' })
			expect(relationsBoth.complete)
				.toBe(true)

			const relationsOutgoing = await executeQuery(context, { kind: 'relations', id: 'REQ-700', direction: 'outgoing' })
			expect(relationsOutgoing.complete)
				.toBe(true)

			const trace = await executeQuery(context, { kind: 'trace', roots: ['REQ-700'], types: ['derived-from'], direction: 'both', maxDepth: 1 })
			expect(trace.complete)
				.toBe(true)

			const impact = await executeQuery(context, { kind: 'impact', roots: ['PRD-001'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(true)

			const resolveCurrent = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-700' })
			expect(resolveCurrent.complete)
				.toBe(true)
		})

		it('an edge-lossy Artifact in a disconnected component does not block an outgoing-only relations/trace/resolve-current reachable only from a clean root', async () => {
			await writeFile(tempDir, '.engineering/prd/PRD-800.md', PRD_ISLAND)
			await writeFile(tempDir, '.engineering/req/REQ-800.md', REQ_ISLAND_LOSSY)
			const context = await reloadContext()
			expect([...context.validation.edgeLossArtifactIds])
				.toEqual(['REQ-800'])

			const relationsOutgoing = await executeQuery(context, { kind: 'relations', id: 'REQ-001', direction: 'outgoing' })
			expect(relationsOutgoing.complete)
				.toBe(true)

			const traceOutgoing = await executeQuery(context, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from', 'governed-by'], direction: 'outgoing', maxDepth: 5 })
			expect(traceOutgoing.complete)
				.toBe(true)

			const resolveCurrent = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-001' })
			expect(resolveCurrent.complete)
				.toBe(true)
		})

		it('the SAME disconnected edge-lossy Artifact still gates relations (direction "incoming"), trace ("incoming"), and impact project-wide: those depend on incoming edges derived from every Artifact\'s outgoing array', async () => {
			await writeFile(tempDir, '.engineering/prd/PRD-800.md', PRD_ISLAND)
			await writeFile(tempDir, '.engineering/req/REQ-800.md', REQ_ISLAND_LOSSY)
			const context = await reloadContext()

			const relationsIncoming = await executeQuery(context, { kind: 'relations', id: 'REQ-001', direction: 'incoming' })
			expect(relationsIncoming.complete)
				.toBe(false)
			expect(relationsIncoming.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const traceIncoming = await executeQuery(context, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from'], direction: 'incoming', maxDepth: 1 })
			expect(traceIncoming.complete)
				.toBe(false)
			expect(traceIncoming.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const impact = await executeQuery(context, { kind: 'impact', roots: ['REQ-001'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(false)
			expect(impact.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('an outgoing-only traversal IS blocked when the edge-lossy Artifact\'s own known-valid edge touches the traversal\'s visited set (not a no-op scoping)', async () => {
			// REQ-950's one valid relation (derived-from -> PRD-001) targets the
			// same PRD-001 that REQ-001's own outgoing traversal reaches.
			await writeFile(tempDir, '.engineering/req/REQ-950.md', REQ_BAD_RELATION)
			const context = await reloadContext()

			const relationsOutgoing = await executeQuery(context, { kind: 'relations', id: 'REQ-001', direction: 'outgoing' })
			expect(relationsOutgoing.complete)
				.toBe(false)
			expect(relationsOutgoing.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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

		it('a full projection reports an empty body when the record\'s file is not in the snapshot', async () => {
			// `QueryContext` does not itself enforce that `snapshot` and
			// `validation` were produced from the same load: `bodyTextFor` (query.ts)
			// falls back to an empty string when the record's path has no matching
			// snapshot file entry (or that file's frontmatter isn't ok), a real
			// branch this defensive fallback covers. Under a real,
			// self-consistent `validateSnapshot` result this cannot happen (every
			// `byId` record's path always has a matching, frontmatter-ok
			// `snapshot.artifacts` entry), so it is only exercisable by
			// deliberately mismatching the two, as here.
			const mismatchedContext: QueryContext = {
				...context,
				snapshot: { ...context.snapshot, artifacts: context.snapshot.artifacts.filter(a => a.path !== '.engineering/req/REQ-001.md') },
			}
			const result = await executeQuery(mismatchedContext, { kind: 'lookup', id: 'REQ-001' })
			const artifact = result.data!.artifact as Record<string, unknown>
			expect(artifact.id)
				.toBe('REQ-001')
			expect(artifact.body)
				.toBe('')
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

		it('status filter narrows to matching records and excludes the rest', async () => {
			const result = await executeQuery(context, { kind: 'list', status: ['completed'] })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['CHG-001'])
		})

		it('eF-QRY-002 for an unknown status value', async () => {
			const result = await executeQuery(context, { kind: 'list', status: ['not-a-status'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
			expect(result.diagnostics[0]!.message)
				.toContain('Unknown status')
		})

		it('eF-QRY-002 for an unknown relation type filter', async () => {
			const result = await executeQuery(context, { kind: 'list', relationType: 'not-a-type' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
		})

		it('eF-QRY-002 for a negative offset', async () => {
			const result = await executeQuery(context, { kind: 'list', offset: -1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
			expect(result.diagnostics[0]!.message)
				.toContain('\'offset\' must be a non-negative integer')
		})

		it('eF-QRY-002 for a zero limit', async () => {
			const result = await executeQuery(context, { kind: 'list', limit: 0 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
			expect(result.diagnostics[0]!.message)
				.toContain('\'limit\' must be a positive integer or null')
		})

		it('schema filter narrows to records declaring exactly that schema', async () => {
			const result = await executeQuery(context, { kind: 'list', schema: 'ef/requirement@1' })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001', 'REQ-002', 'REQ-010', 'REQ-011', 'REQ-012'])
		})

		it('tags_any uses OR semantics', async () => {
			const result = await executeQuery(context, { kind: 'list', tagsAny: ['alpha'] })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001'])
		})

		it('resource_role filters on the resource\'s role field', async () => {
			const result = await executeQuery(context, { kind: 'list', resourceRole: 'reference' })
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001'])
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

		it('eF-QRY-002 for a negative offset', async () => {
			const result = await executeQuery(context, { kind: 'search', terms: ['filtering'], offset: -1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
			expect(result.diagnostics[0]!.message)
				.toContain('\'offset\' must be a non-negative integer')
		})

		it('eF-QRY-002 for a zero limit', async () => {
			const result = await executeQuery(context, { kind: 'search', terms: ['filtering'], limit: 0 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
			expect(result.diagnostics[0]!.message)
				.toContain('\'limit\' must be a positive integer or null')
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

		it('deduplicates a repeated relation type in both the echoed types and the traversal type set', async () => {
			const result = await executeQuery(context, { kind: 'relations', id: 'REQ-001', types: ['derived-from', 'derived-from'] })
			expect(result.data!.types)
				.toEqual(['derived-from'])
			expect(result.data!.edges)
				.toEqual([{ source: 'REQ-001', type: 'derived-from', target: 'PRD-001' }])
		})

		it('eF-QRY-007 when a returned edge references a dangling (non-existent) target', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-901.md', REQ_GHOST_SRC)
			const ghostContext = await reloadContext()

			const result = await executeQuery(ghostContext, { kind: 'relations', id: 'REQ-901', types: ['derived-from'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-007')
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

		it('eF-QRY-006 for an invalid direction', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: ['PRD-001'], types: ['derived-from'], direction: 'sideways', maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-006')
		})

		it('eF-QRY-002 for an unknown relation type in the type set', async () => {
			const result = await executeQuery(context, { kind: 'trace', roots: ['PRD-001'], types: ['not-a-type'], direction: 'both', maxDepth: 1 })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-002')
		})

		it('eF-QRY-007 when traversal reaches a dangling (non-existent) target', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-901.md', REQ_GHOST_SRC)
			const ghostContext = await reloadContext()

			const result = await executeQuery(ghostContext, { kind: 'trace', roots: ['REQ-901'], types: ['derived-from'], direction: 'outgoing', maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-007')
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

		it('include_references adds references edges to the impact traversal only when requested', async () => {
			await writeFile(tempDir, '.engineering/adr/ADR-901.md', ADR_REFERENCES_POL)
			const referencesContext = await reloadContext()

			const withoutReferences = await executeQuery(referencesContext, { kind: 'impact', roots: ['POL-001'], maxDepth: 1 })
			expect(withoutReferences.data!.impact.nodes.map(n => n.artifact.id))
				.not.toContain('ADR-901')

			const withReferences = await executeQuery(referencesContext, { kind: 'impact', roots: ['POL-001'], maxDepth: 1, includeReferences: true })
			expect(withReferences.data!.include_references)
				.toBe(true)
			expect(withReferences.data!.impact.nodes.map(n => n.artifact.id))
				.toContain('ADR-901')
		})

		it('eF-QRY-008 when resolve_current reaches an invalid supersession graph (dangling replacement)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-902.md', REQ_GHOST_SUP)
			const ghostContext = await reloadContext()

			const result = await executeQuery(ghostContext, { kind: 'impact', roots: ['REQ-902'], maxDepth: 1, resolveCurrent: true })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-008')
		})

		it('eF-QRY-007 when the impact traversal reaches a dangling incoming reference', async () => {
			// Not reachable through a real, self-consistent `validateSnapshot`
			// result: `incomingRelations` is always indexed from the same file
			// outcomes that populate `byId`, so an incoming edge's `from` side is
			// always a real Artifact ID. Constructing the two indexes
			// independently (as `query-graph.unit.test.ts` does for the
			// equivalent `impactGraph` case) is the only way to exercise this
			// defensive branch precisely.
			const byId = new Map([['POL-001', fabricatedRecord('POL-001', 'policy', 'active')]])
			const incomingRelations = new Map<string, IncomingRelationEdge[]>([
				['POL-001', [{ from: 'REQ-GHOST', type: 'governed-by' }]],
			])
			const fabricated = fabricatedContext(byId, incomingRelations)

			const result = await executeQuery(fabricated, { kind: 'impact', roots: ['POL-001'], maxDepth: 4 })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-007')
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

		it('eF-QRY-008 for an invalid supersession graph (dangling replacement)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-902.md', REQ_GHOST_SUP)
			const ghostContext = await reloadContext()

			const result = await executeQuery(ghostContext, { kind: 'resolve-current', id: 'REQ-902' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-008')
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

		it('eF-QRY-001 for an empty Artifact ID', async () => {
			const result = await executeQuery(context, { kind: 'history', id: '' })
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-001')
		})

		it('eF-QRY-010 when the captured integration ref history cannot be completely materialized', async () => {
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

			const realGit = createGitRepository(tempDir, createGitExecutor())
			const brokenGit = wrapGitRepository(realGit, {
				listFirstParentHistory: async () => ({ kind: 'shallow' }),
			})
			const historyContext: QueryContext = {
				...context,
				history: { git: brokenGit, integrationRefOid: tipOid },
			}
			const result = await executeQuery(historyContext, { kind: 'history', id: 'REQ-001' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-010')
			expect(result.diagnostics[0]!.message)
				.toContain('could not be completely materialized')
		})

		// `computeHistory`'s `untrusted-data` outcome (a historical blob the walk
		// needed exists but could not be read/decoded) must map to the more
		// specific `EF-QRY-013`, distinct from `EF-QRY-010`'s "the Git history
		// itself is unavailable" (query-history.ts `ComputeHistoryResult` docs).
		it('eF-QRY-013 (not EF-QRY-010) when a historical blob the walk needs exists but cannot be read', async () => {
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

			const realGit = createGitRepository(tempDir, createGitExecutor())
			// REQ-001.md exists as a real blob at `tipOid`'s tree (proven by the
			// real `readTree` call this override still delegates to); only the
			// content fetch is forced to fail, distinct from a genuine absence.
			const brokenGit = wrapGitRepository(realGit, {
				readBlob: async () => ({ kind: 'missing' }),
			})
			const historyContext: QueryContext = {
				...context,
				history: { git: brokenGit, integrationRefOid: tipOid },
			}
			const result = await executeQuery(historyContext, { kind: 'history', id: 'REQ-001' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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
