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

## Scope

This project covers the Artifacts and query behavior exercised by these tests.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

The project operates as a single-repository workspace with no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
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

## Problem

Users cannot find relevant results quickly.

## User Need

Users need fast, relevant search results.

## Desired Outcome

Provide best-in-class search.

## Success Criteria

- Improve findability.

## Non-goals

This PRD does not cover unrelated administrative tooling.
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

const REQ_MISPLACED_DIRECTORY = `---
schema: ef/requirement@1
type: requirement
id: REQ-778
title: Misplaced Requirement
status: active
summary: A well-formed, unambiguous requirement declared inside the wrong canonical directory.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-ID-014-only (wrong canonical directory) staying ungated for graphTrustworthy but path-trust-gated for a result that projects it.

## Rationale

Confirms EF-ID-014 alone does not flip graphTrustworthy.

## Acceptance Criteria

- N/A.
`

/** References `target` from a well-formed, unambiguous requirement, for path-trust node-set regressions (Finding 6, seventh-round). */
function requirementReferencing(id: string, target: string): string {
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Title of ${id}
status: active
summary: References ${target} for a path-trust node-set regression.
tags: []
relations:
  - type: references
    target: ${target}
resources: []
---

## Requirement

References ${target}.

## Rationale

Exercises Finding 6's path-trust node gate on a graph traversal's node set.

## Acceptance Criteria

- N/A.
`
}

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

## Rationale

Rationale text for ${id}.

## Acceptance Criteria

- Acceptance criterion for ${id}.
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

## Alternatives

We considered not filtering at all.

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

## Policy

Handle data responsibly.

## Scope

Applies to all search data processing.

## Rationale

Protects user data.

## Compliance

- Data must be encrypted at rest.
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

/**
 * An edge-lossy Artifact (EF-REL-002, via an unrelated discarded entry) whose
 * one VALID relation targets REQ-001 directly -- i.e. the root of the
 * `max_depth: 0` regression below -- so the pre-Finding-8 "adjacent via a
 * known-valid edge into the visited set" bug would have falsely gated even
 * the strictest possible case: max_depth 0, where no Artifact's outgoing
 * array (not even the root's own) is ever read at all.
 */
const REQ_951_TARGETS_ROOT = `---
schema: ef/requirement@1
type: requirement
id: REQ-951
title: Bad Relation Requirement Targeting The Trace Root
status: active
summary: A requirement whose relations array contains a shape-invalid entry, and whose one valid relation targets REQ-001 (the trace root in the max_depth zero regression), for Finding 8's lossy-incoming-neighbor and max-depth-zero regressions.
tags: []
relations:
  - type: derived-from
    target: REQ-001
  - not-a-mapping
resources: []
---

## Requirement

Exercises Finding 8: an edge-lossy Artifact whose valid edge targets the exact node a max_depth:0 outgoing trace roots at must not falsely gate that trace, since max_depth:0 reads no Artifact's outgoing array at all.

## Rationale

Finding 8 regression fixture.

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

/** A superseded requirement with NO direct replacement (`EF-SUP-001`), for sixth-round Finding 6's zero-edge resolve-current regression. */
const REQ_SUP_NO_REPLACEMENT = `---
schema: ef/requirement@1
type: requirement
id: REQ-960
title: Superseded With No Replacement
status: superseded
summary: A superseded requirement with no direct replacement, for Finding 6's EF-SUP-001 zero-edge regression.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-SUP-001: a superseded Artifact with no direct replacement.

## Rationale

Finding 6 regression fixture.

## Acceptance Criteria

- N/A.
`

/** An ACTIVE requirement illegally declaring 'superseded-by' (\`EF-SUP-002\`), for sixth-round Finding 6's zero-edge resolve-current regression. */
const REQ_SUP_ILLEGAL_DECLARE = `---
schema: ef/requirement@1
type: requirement
id: REQ-961
title: Active Illegally Declaring Superseded-By
status: active
summary: An active requirement that illegally declares a 'superseded-by' relation, for Finding 6's EF-SUP-002 zero-edge regression.
tags: []
relations:
  - type: superseded-by
    target: REQ-001
resources: []
---

## Requirement

Exercises EF-SUP-002: a non-superseded Artifact declaring 'superseded-by'.

## Rationale

Finding 6 regression fixture.

## Acceptance Criteria

- N/A.
`

/** A superseded requirement whose replacement set duplicates the same target twice (\`EF-REL-006\` on a 'superseded-by' entry), for seventh-round Finding 7's resolve-current regression. */
const REQ_SUP_DUP_REPLACEMENT = `---
schema: ef/requirement@1
type: requirement
id: REQ-962
title: Superseded With Duplicate Replacement Edge
status: superseded
summary: A superseded requirement whose replacement set duplicates the same target twice, for Finding 7's EF-REL-006 resolve-current regression.
tags: []
relations:
  - type: superseded-by
    target: REQ-001
  - type: superseded-by
    target: REQ-001
resources: []
---

## Requirement

Exercises EF-REL-006 (duplicate relation) on a 'superseded-by' entry.

## Rationale

Finding 7 regression fixture.

## Acceptance Criteria

- N/A.
`

/** A requirement whose relations array declares the same ('derived-from', PRD-001) pair twice (\`EF-REL-006\`), for Finding 7's direct-relations/trace/impact regressions. */
const REQ_DUP_RELATION = `---
schema: ef/requirement@1
type: requirement
id: REQ-963
title: Duplicate Relation Entry
status: active
summary: A requirement whose relations array declares the same (type, target) pair twice, for Finding 7's EF-REL-006 regression.
tags: []
relations:
  - type: derived-from
    target: PRD-001
  - type: derived-from
    target: PRD-001
resources: []
---

## Requirement

Exercises EF-REL-006 (duplicate relation).

## Rationale

Finding 7 regression fixture.

## Acceptance Criteria

- N/A.
`

/**
 * A requirement with a clean 'derived-from' edge and a semantically invalid
 * 'governed-by' edge (\`EF-REL-004\`: a 'governed-by' target must be a policy,
 * not another requirement), for Finding 9's per-(source,type) edge-loss
 * regression: a traversal restricted to 'derived-from' must be unaffected by
 * loss confined to 'governed-by'. Deliberately semantic (not shape/vocabulary)
 * loss: \`semanticEdgeLossArtifactIds\` is NOT folded into
 * \`projectionLossArtifactIds\` (unlike \`edgeLossArtifactIds\`), so embedding
 * REQ-964 itself as an output node does not ALSO trigger the separate,
 * type-agnostic Finding 4 projection gate -- isolating this round's per-type
 * edge-TRUST narrowing from that orthogonal concern.
 */
const REQ_MIXED_TYPE_LOSS = `---
schema: ef/requirement@1
type: requirement
id: REQ-964
title: Mixed Type Relation Loss
status: active
summary: A requirement with a clean 'derived-from' edge and a semantically invalid 'governed-by' edge, for Finding 9's per-type edge-loss regression.
tags: []
relations:
  - type: derived-from
    target: PRD-001
  - type: governed-by
    target: REQ-001
resources: []
---

## Requirement

Exercises Finding 9: an EF-REL-004 (semantically invalid 'governed-by' target) confined to 'governed-by' must not gate an outgoing traversal restricted to 'derived-from'.

## Rationale

Finding 9 regression fixture.

## Acceptance Criteria

- N/A.
`

/**
 * A requirement whose relations array declares the same
 * ('references', REQ-002) pair twice (\`EF-REL-006\`), for the GLOBAL edge-trust
 * gate's typed narrowing (Finding 9, seventh-round): 'references' is only
 * ever part of `impact`'s type set when `include_references` is requested, so
 * this loss must not gate `impact` by default but must gate it once
 * `include_references: true` is requested.
 */
const REQ_DUP_REFERENCES = `---
schema: ef/requirement@1
type: requirement
id: REQ-965
title: Duplicate References Entry
status: active
summary: A requirement whose relations array declares the same ('references', REQ-002) pair twice, for the global edge-trust gate's typed narrowing.
tags: []
relations:
  - type: references
    target: REQ-002
  - type: references
    target: REQ-002
resources: []
---

## Requirement

Exercises EF-REL-006 (duplicate relation) confined to 'references', for Finding 9's global-gate typed narrowing.

## Rationale

Finding 9 (seventh-round) regression fixture.

## Acceptance Criteria

- N/A.
`

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

/** Writes raw bytes verbatim, for fixtures that need genuinely invalid UTF-8 (Finding 7) rather than a well-formed string. */
async function writeFileBytes(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, bytes)
}

/**
 * Corrupts one interior byte of `term`'s first occurrence in a well-formed
 * requirement body with an invalid standalone UTF-8 byte (`0xFF`), for
 * seventh-round Finding 7's search-membership regression: the best-effort
 * decode replaces that byte with U+FFFD, splitting the exact token a search
 * request would otherwise match. The fixture text is ASCII-only, so a
 * character offset is also a byte offset.
 */
function corruptedBodyBytes(id: string, term: string): Uint8Array {
	const text = `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Title of ${id}
status: active
summary: Summary of ${id}.
tags: []
relations: []
resources: []
---

## Requirement

The body contains a ${term} term with a byte corrupted inside it.

## Rationale

Finding 7 (seventh-round) search-membership regression fixture.

## Acceptance Criteria

- N/A.
`
	const charIndex = text.indexOf(term)
	if (charIndex === -1)
		throw new Error(`fixture text does not contain term '${term}'`)
	const bytes = new TextEncoder()
		.encode(text)
	bytes[charIndex + Math.floor(term.length / 2)] = 0xFF
	return bytes
}

const GITIGNORE = `.cache/
.generated/
.tmp/
.lock
`

async function writeRichProject(root: string): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/.gitignore', GITIGNORE)
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
		edgeLossUntypedArtifactIds: new Set(),
		edgeLossRelationTypesBySourceId: new Map(),
		relationExtensionLossArtifactIds: new Set(),
		resourceLossArtifactIds: new Set(),
		tagLossArtifactIds: new Set(),
		envelopeWideLossArtifactIds: new Set(),
		envelopeFieldLossById: new Map(),
		extensionValueLossArtifactIds: new Set(),
		envelopeStructuralLossArtifactIds: new Set(),
		byteDecodingLossArtifactIds: new Set(),
		projectionLossArtifactIds: new Set(),
		semanticEdgeLossArtifactIds: new Set(),
		semanticEdgeLossRelationTypesBySourceId: new Map(),
		statusInvalidArtifactIds: new Set(),
		supersessionCrossTypeArtifactIds: new Set(),
		supersessionFactInvalidArtifactIds: new Set(),
		resourceFieldLossById: new Map(),
		pathTrustLossArtifactIds: new Set(),
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

		it('stays ungated for an EF-ID-005-only filename mismatch: the declared ID is unique and decoded, so unrelated queries still succeed', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			const ok = await reloadContext()
			expect(ok.validation.graphTrustworthy)
				.toBe(true)

			// An unrelated lookup, and a list/search result that never projects
			// REQ-777 itself, are unaffected by its own filename mismatch --
			// Finding 6 (below) gates only the specific result that would
			// project REQ-777's own (non-canonical) path.
			const lookup = await executeQuery(ok, { kind: 'lookup', id: 'REQ-001' })
			expect(lookup.complete)
				.toBe(true)
			expect(lookup.data?.found)
				.toBe(true)

			const list = await executeQuery(ok, { kind: 'list', type: ['prd'] })
			expect(list.complete)
				.toBe(true)

			const search = await executeQuery(ok, { kind: 'search', terms: ['filtering'] })
			expect(search.complete)
				.toBe(true)
		})
	})

	// Seventh-round Finding 6: 10-query-and-trace.md fixes a projected
	// Artifact's `path` as its canonical, project-relative path, but
	// `buildArtifactSummary` projects the actual discovered path verbatim. An
	// Artifact with an EF-ID-005 filename mismatch or an EF-ID-014
	// wrong-canonical-directory finding has an explicitly non-canonical
	// projected `path`, so any result that would project THAT Artifact must
	// gate with EF-QRY-013 -- without blocking an unrelated result.
	describe('path-trust gate (Finding 6, seventh-round: EF-ID-005/EF-ID-014, per-node scoping)', () => {
		it('gates lookup of the misfiled Artifact itself (EF-ID-005) with EF-QRY-013', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			const ctx = await reloadContext()
			expect(ctx.validation.graphTrustworthy)
				.toBe(true)

			const lookup = await executeQuery(ctx, { kind: 'lookup', id: 'REQ-777' })
			expect(lookup.complete)
				.toBe(false)
			expect(lookup.data)
				.toBeNull()
			expect(lookup.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates lookup of an Artifact outside its canonical directory (EF-ID-014) with EF-QRY-013', async () => {
			await writeFile(tempDir, '.engineering/adr/REQ-778.md', REQ_MISPLACED_DIRECTORY)
			const ctx = await reloadContext()
			expect(ctx.validation.graphTrustworthy)
				.toBe(true)

			const lookup = await executeQuery(ctx, { kind: 'lookup', id: 'REQ-778' })
			expect(lookup.complete)
				.toBe(false)
			expect(lookup.data)
				.toBeNull()
			expect(lookup.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates a list result that returns the misfiled Artifact, but not one that excludes it by filter', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			const ctx = await reloadContext()

			const listAll = await executeQuery(ctx, { kind: 'list' })
			expect(listAll.complete)
				.toBe(false)
			expect(listAll.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			// A filter that never returns REQ-777 (a requirement) is unaffected.
			const listPrdOnly = await executeQuery(ctx, { kind: 'list', type: ['prd'] })
			expect(listPrdOnly.complete)
				.toBe(true)
			expect(listPrdOnly.data?.artifacts.map(a => a.id))
				.toEqual(['PRD-001'])
		})

		it('gates a search result that returns the misfiled Artifact, but not one that only matches an unrelated Artifact', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			const ctx = await reloadContext()

			const searchMisfiled = await executeQuery(ctx, { kind: 'search', terms: ['misfiled'] })
			expect(searchMisfiled.complete)
				.toBe(false)
			expect(searchMisfiled.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const searchUnrelated = await executeQuery(ctx, { kind: 'search', terms: ['filtering'] })
			expect(searchUnrelated.complete)
				.toBe(true)
			expect(searchUnrelated.data?.results.map(r => r.artifact.id))
				.not.toContain('REQ-777')
		})

		it('gates a relations result whose node set includes the misfiled Artifact as a neighbor', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-999.md', REQ_777_MISFILED)
			await writeFile(tempDir, '.engineering/req/REQ-800.md', requirementReferencing('REQ-800', 'REQ-777'))
			const ctx = await reloadContext()

			const relationsToMisfiled = await executeQuery(ctx, { kind: 'relations', id: 'REQ-800', direction: 'outgoing' })
			expect(relationsToMisfiled.complete)
				.toBe(false)
			expect(relationsToMisfiled.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			// A relations result whose node set never includes REQ-777 is
			// unaffected by its own path-trust loss.
			const relationsUnrelated = await executeQuery(ctx, { kind: 'relations', id: 'REQ-001', direction: 'outgoing' })
			expect(relationsUnrelated.complete)
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

	describe('duplicate-key trust-scope adjudication (EF-ENV-005 field classification, Finding 5 review)', () => {
		/**
		 * Duplicates REQ-001's own top-level 'relations' key: the FIRST (real)
		 * array -- derived-from PRD-001, governed-by POL-001 -- is still what
		 * `decodeEnvelope`/`rawArrayField` both select (first-occurrence-wins),
		 * but the file itself is invalid regardless (01-artifact-envelope.md),
		 * so REQ-001's own outgoing edge set could not be reliably determined.
		 */
		async function contextWithDuplicateRelationsKey(): Promise<QueryContext> {
			const duplicated = REQ_001.replace(
				'resources:\n  - type: reference',
				'relations:\n  - type: references\n    target: PROJECT\nresources:\n  - type: reference',
			)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicated)
			return reloadContext()
		}

		it('duplicate relations key: sets edgeLossArtifactIds for REQ-001 only, leaves envelopeStructuralLossArtifactIds empty, and does not flip graphTrustworthy', async () => {
			const dup = await contextWithDuplicateRelationsKey()
			expect([...dup.validation.edgeLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(dup.validation.envelopeStructuralLossArtifactIds.size)
				.toBe(0)
			expect(dup.validation.graphTrustworthy)
				.toBe(true)
		})

		it('gates an outgoing relations/trace query that consults REQ-001\'s own (now-uncertain) outgoing array', async () => {
			const dup = await contextWithDuplicateRelationsKey()

			const relations = await executeQuery(dup, { kind: 'relations', id: 'REQ-001', direction: 'outgoing' })
			expect(relations.complete)
				.toBe(false)
			expect(relations.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const trace = await executeQuery(dup, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from'], direction: 'outgoing', maxDepth: 1 })
			expect(trace.complete)
				.toBe(false)
			expect(trace.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('gates lookup REQ-001 itself (own projection loss, via envelopeWideLossArtifactIds), but leaves an unrelated lookup/list untouched', async () => {
			const dup = await contextWithDuplicateRelationsKey()

			const lookupSelf = await executeQuery(dup, { kind: 'lookup', id: 'REQ-001' })
			expect(lookupSelf.complete)
				.toBe(false)
			expect(lookupSelf.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			// An unrelated, clean Artifact's exact lookup must still succeed: the
			// duplicate-relations-key fact is REQ-001's own edge/projection
			// concern, not a project-wide gate (adjudicated ruling).
			const lookupOther = await executeQuery(dup, { kind: 'lookup', id: 'REQ-002' })
			expect(lookupOther.complete)
				.toBe(true)
			expect(lookupOther.data?.found)
				.toBe(true)

			// REQ-001 is a 'requirement', not a 'decision': excluded by this type
			// filter entirely, so the returned collection is untouched by its loss.
			const list = await executeQuery(dup, { kind: 'list', type: ['decision'] })
			expect(list.complete)
				.toBe(true)
			expect(list.data!.artifacts.some(a => a.id === 'REQ-001'))
				.toBe(false)
		})

		it('duplicate id key (EF-ENV-005, single file) blocks graphTrustworthy project-wide, exactly like a cross-file EF-ID-004 collision', async () => {
			const duplicated = REQ_002.replace('id: REQ-002\n', 'id: REQ-002\nid: REQ-777\n')
			await writeFile(tempDir, '.engineering/req/REQ-002.md', duplicated)
			const dup = await reloadContext()
			expect(dup.validation.graphTrustworthy)
				.toBe(false)

			const lookup = await executeQuery(dup, { kind: 'lookup', id: 'REQ-001' })
			expect(lookup.complete)
				.toBe(false)
			expect(lookup.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const list = await executeQuery(dup, { kind: 'list' })
			expect(list.complete)
				.toBe(false)
			expect(list.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('duplicate status key on a supersession-chain member gates resolve-current once its traversal reaches it, but leaves an unrelated lookup untouched', async () => {
			const duplicated = supersessionReq('REQ-011', 'superseded', 'REQ-012')
				.replace('status: superseded\n', 'status: superseded\nstatus: draft\n')
			await writeFile(tempDir, '.engineering/req/REQ-011.md', duplicated)
			const dup = await reloadContext()
			expect([...dup.validation.statusInvalidArtifactIds])
				.toEqual(['REQ-011'])
			expect(dup.validation.graphTrustworthy)
				.toBe(true)

			const resolveCurrent = await executeQuery(dup, { kind: 'resolve-current', id: 'REQ-010' })
			expect(resolveCurrent.complete)
				.toBe(false)
			expect(resolveCurrent.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const lookup = await executeQuery(dup, { kind: 'lookup', id: 'REQ-001' })
			expect(lookup.complete)
				.toBe(true)
		})

		it('duplicate status key on an impact-traversal candidate gates impact once its traversal reaches it (depth > 0), but leaves an unrelated lookup untouched', async () => {
			const duplicated = ADR_001.replace('status: active\n', 'status: active\nstatus: draft\n')
			await writeFile(tempDir, '.engineering/adr/ADR-001.md', duplicated)
			const dup = await reloadContext()
			expect([...dup.validation.statusInvalidArtifactIds])
				.toEqual(['ADR-001'])
			expect(dup.validation.graphTrustworthy)
				.toBe(true)

			// ADR-001 is reached at depth 1 from REQ-001 via its 'addresses' edge.
			const impact = await executeQuery(dup, { kind: 'impact', roots: ['REQ-001'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(false)
			expect(impact.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const lookup = await executeQuery(dup, { kind: 'lookup', id: 'REQ-002' })
			expect(lookup.complete)
				.toBe(true)
		})
	})

	describe('graph query edge-loss scoping (Finding C: 10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
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

		it('eF-REL-015-only loss (invalid extension field) never triggers EDGE-trust gating (any direction) -- an unrelated query that never embeds the affected Artifact as a node stays complete', async () => {
			// Finding 4 (this round) distinguishes EDGE trust from PROJECTION
			// trust: extension-only loss can never hide/alter a graph EDGE
			// (`(source, type, target)` is unaffected), so it must never trigger
			// `edgeTrustGlobalFailure`/`edgeTrustLocalFailure` project-wide --
			// proven here via a query whose result never embeds REQ-700 as a
			// node at all. See the next test for the separate, per-Artifact
			// PROJECTION-trust gate that DOES apply once REQ-700 itself is
			// embedded as a node.
			await writeFile(tempDir, '.engineering/req/REQ-700.md', REQ_EXT_ONLY_LOSS)
			const context = await reloadContext()
			expect(context.validation.edgeLossArtifactIds.size)
				.toBe(0)
			expect(context.validation.semanticEdgeLossArtifactIds.size)
				.toBe(0)
			expect([...context.validation.relationExtensionLossArtifactIds])
				.toEqual(['REQ-700'])

			// ADR-001 (addresses REQ-001) never reaches or embeds REQ-700.
			const relationsBoth = await executeQuery(context, { kind: 'relations', id: 'ADR-001' })
			expect(relationsBoth.complete)
				.toBe(true)
			expect(relationsBoth.data!.nodes.map(n => n.id))
				.not.toContain('REQ-700')

			const relationsOutgoing = await executeQuery(context, { kind: 'relations', id: 'ADR-001', direction: 'outgoing' })
			expect(relationsOutgoing.complete)
				.toBe(true)

			const trace = await executeQuery(context, { kind: 'trace', roots: ['ADR-001'], types: ['addresses'], direction: 'both', maxDepth: 1 })
			expect(trace.complete)
				.toBe(true)

			const impact = await executeQuery(context, { kind: 'impact', roots: ['REQ-002'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(true)
			expect(impact.data!.impact.nodes.map(n => n.artifact.id))
				.not.toContain('REQ-700')

			const resolveCurrent = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-002' })
			expect(resolveCurrent.complete)
				.toBe(true)
		})

		it('finding 4: relations/trace/impact/resolve-current DO gate on PROJECTION loss once the extension-lossy Artifact is itself embedded as an output node, separately from (and even though) edge trust is unaffected', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-700.md', REQ_EXT_ONLY_LOSS)
			const context = await reloadContext()
			expect([...context.validation.projectionLossArtifactIds])
				.toContain('REQ-700')

			const relationsBoth = await executeQuery(context, { kind: 'relations', id: 'REQ-700' })
			expect(relationsBoth.complete)
				.toBe(false)
			expect(relationsBoth.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const trace = await executeQuery(context, { kind: 'trace', roots: ['REQ-700'], types: ['derived-from'], direction: 'both', maxDepth: 1 })
			expect(trace.complete)
				.toBe(false)
			expect(trace.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			// REQ-700 (active, derived-from -> PRD-001) is a depth-1 impact
			// candidate for root PRD-001, so it is embedded as an impact node too.
			const impact = await executeQuery(context, { kind: 'impact', roots: ['PRD-001'], maxDepth: 1 })
			expect(impact.complete)
				.toBe(false)
			expect(impact.diagnostics[0]!.code)
				.toBe('EF-QRY-013')

			const resolveCurrent = await executeQuery(context, { kind: 'resolve-current', id: 'REQ-700' })
			expect(resolveCurrent.complete)
				.toBe(false)
			expect(resolveCurrent.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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

		// Eighth-round Finding 8: an outgoing-only traversal must scope edge
		// trust to exactly the source records whose own outgoing array it
		// actually read -- NOT every Artifact merely adjacent to the result via
		// a known-valid edge in either direction. REQ-950 (edge-lossy elsewhere,
		// via an unrelated discarded entry) also declares one valid, unrelated
		// relation `derived-from -> PRD-001`, the same PRD-001 that REQ-001's
		// own outgoing traversal reaches; a purely outgoing traversal from
		// REQ-001 never reads REQ-950's outgoing array at all (REQ-950 is not
		// one of REQ-001's own targets), so REQ-950's unrelated loss cannot
		// affect this result.
		it('a lossy-incoming-neighbor (an edge-lossy Artifact with a known-valid edge INTO the visited set) does NOT block an outgoing-only traversal that never reads its own outgoing array', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-950.md', REQ_BAD_RELATION)
			const context = await reloadContext()
			expect([...context.validation.edgeLossArtifactIds])
				.toEqual(['REQ-950'])

			const relationsOutgoing = await executeQuery(context, { kind: 'relations', id: 'REQ-001', direction: 'outgoing' })
			expect(relationsOutgoing.complete)
				.toBe(true)
			expect(relationsOutgoing.data!.nodes.map(n => n.id))
				.not.toContain('REQ-950')

			const traceOutgoing = await executeQuery(context, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from', 'governed-by'], direction: 'outgoing', maxDepth: 5 })
			expect(traceOutgoing.complete)
				.toBe(true)
		})

		it('max_depth: 0 is contractually roots-only with no edges, so an outgoing trace never reads ANY Artifact\'s outgoing array -- not even the root\'s own, and not an edge-lossy neighbor\'s whose valid edge targets the root directly', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-951.md', REQ_951_TARGETS_ROOT)
			const context = await reloadContext()
			expect([...context.validation.edgeLossArtifactIds])
				.toEqual(['REQ-951'])

			const traceZero = await executeQuery(context, { kind: 'trace', roots: ['REQ-001'], types: ['derived-from'], direction: 'outgoing', maxDepth: 0 })
			expect(traceZero.complete)
				.toBe(true)
			expect(traceZero.data!.nodes)
				.toEqual([{ artifact: expect.objectContaining({ id: 'REQ-001' }), depth: 0 }])
			expect(traceZero.data!.edges)
				.toEqual([])
		})
	})

	// Seventh-round Finding 9: `edgeTrustGlobalFailure` (incoming/both
	// `relations`/`trace`, and `impact`, which is always incoming) previously
	// gated on ANY typed edge/semantic loss ANYWHERE in the graph, regardless
	// of the traversal's own selected relation type set -- unlike
	// `edgeTrustLocalFailure` (sixth-round Finding 9), which already
	// intersects a purely outgoing traversal's per-(source,type) loss against
	// its requested types. A typed loss confined to a relation type the
	// traversal never reads must not block it either, globally or locally;
	// truly untyped loss stays conservative/global.
	describe('typed edge-loss narrowing for the GLOBAL gate (Finding 9, seventh-round)', () => {
		it('relations (incoming): a semantic edge loss (EF-REL-004) confined to \'governed-by\' elsewhere in the graph does NOT gate a query restricted to \'derived-from\'', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const ctx = await reloadContext()
			expect([...(ctx.validation.semanticEdgeLossRelationTypesBySourceId.get('REQ-964') ?? [])])
				.toEqual(['governed-by'])

			// REQ-964 legitimately appears in the result via its OWN valid,
			// unrelated 'derived-from' edge to PRD-001 -- its 'governed-by'-only
			// loss must not additionally gate this unrelated 'derived-from' read.
			const result = await executeQuery(ctx, { kind: 'relations', id: 'PRD-001', direction: 'incoming', types: ['derived-from'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.nodes.map(n => n.id))
				.toContain('REQ-964')
		})

		it('relations (incoming): the SAME semantic edge loss DOES gate a query whose type set includes \'governed-by\' (the exact affected type)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const ctx = await reloadContext()

			const result = await executeQuery(ctx, { kind: 'relations', id: 'REQ-001', direction: 'incoming', types: ['governed-by'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('trace (incoming): a semantic edge loss confined to \'governed-by\' does NOT gate a trace restricted to \'derived-from\'', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const ctx = await reloadContext()

			// REQ-964 legitimately appears in the result via its OWN valid,
			// unrelated 'derived-from' edge to PRD-001.
			const result = await executeQuery(ctx, { kind: 'trace', roots: ['PRD-001'], types: ['derived-from'], direction: 'incoming', maxDepth: 5 })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.nodes.map(n => n.artifact.id))
				.toContain('REQ-964')
		})

		it('impact (always incoming): a typed edge loss (EF-REL-006) confined to \'references\' does NOT gate impact when include_references is false (the default)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-965.md', REQ_DUP_REFERENCES)
			const ctx = await reloadContext()
			expect([...(ctx.validation.edgeLossRelationTypesBySourceId.get('REQ-965') ?? [])])
				.toEqual(['references'])

			const result = await executeQuery(ctx, { kind: 'impact', roots: ['REQ-001'], maxDepth: 5 })
			expect(result.complete)
				.toBe(true)
		})

		it('impact (always incoming): the SAME typed edge loss DOES gate impact once include_references is true', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-965.md', REQ_DUP_REFERENCES)
			const ctx = await reloadContext()

			const result = await executeQuery(ctx, { kind: 'impact', roots: ['REQ-001'], maxDepth: 5, includeReferences: true })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})
	})

	describe('finding 7: extension-value loss (EF-ENV-007 non-finite numbers) against actual JSON output', () => {
		it('a non-finite (YAML \'.inf\') top-level extension value gates lookup with EF-QRY-013 rather than returning complete: true with a value that would silently JSON.stringify to null', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-960.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-960
title: Non-Finite Extension Value
status: active
summary: A requirement whose top-level extension value is non-finite (EF-ENV-007), for Finding 7's regression against actual JSON output.
tags: []
relations: []
resources: []
x-acme-score: .inf
---

## Requirement

Exercises EF-ENV-007 non-finite extension values.

## Rationale

Finding 7 regression fixture.

## Acceptance Criteria

- N/A.
`)
			const context = await reloadContext()
			expect([...context.validation.extensionValueLossArtifactIds])
				.toEqual(['REQ-960'])
			expect([...context.validation.projectionLossArtifactIds])
				.toContain('REQ-960')

			// The value survives verbatim in memory (`nodeToPlainValue`'s doc) --
			// proving the hazard the gate below prevents from ever reaching a
			// `complete: true` result: `JSON.stringify` (what the CLI's own JSON
			// output ultimately does to every query result) silently launders a
			// non-finite number to `null`, with no diagnostic of its own at that
			// point.
			const record = context.validation.byId.get('REQ-960')!
			expect(record.envelope.extensions['x-acme-score'])
				.toBe(Infinity)
			expect(JSON.parse(JSON.stringify({ score: record.envelope.extensions['x-acme-score'] })))
				.toEqual({ score: null })

			const result = await executeQuery(context, { kind: 'lookup', id: 'REQ-960' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
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

		// Ninth-round Finding 9: field-level loss tracking + "already excluded
		// by a trustworthy predicate" precision.

		it('a tag-loss policy does not gate a type=requirement + tags request: its trusted \'type\' field already excludes it, so its tag loss cannot have changed membership', async () => {
			await writeFile(tempDir, '.engineering/pol/POL-900.md', `---
schema: ef/policy@1
type: policy
id: POL-900
title: Tag Loss Policy
status: active
summary: A policy whose tags array drops a non-string entry, for Finding 9's already-excluded-by-a-trustworthy-predicate regression.
tags:
  - alpha
relations: []
resources: []
---

## Policy Statement

Statement text.

## Rationale

Rationale text.
`.replace('tags:\n  - alpha\n', 'tags:\n  - alpha\n  - 123\n'))
			const withLoss = await reloadContext()
			expect([...withLoss.validation.tagLossArtifactIds])
				.toEqual(['POL-900'])

			const result = await executeQuery(withLoss, { kind: 'list', type: ['requirement'], tagsAny: ['alpha'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.map(a => a.id))
				.not.toContain('POL-900')
		})

		it('relation-extension-only loss (EF-REL-015) never gates a relation_type/relation_target filter: the (type, target) pair is unaffected regardless of match', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-700.md', REQ_EXT_ONLY_LOSS)
			const withLoss = await reloadContext()
			expect(withLoss.validation.edgeLossArtifactIds.size)
				.toBe(0)
			expect([...withLoss.validation.relationExtensionLossArtifactIds])
				.toEqual(['REQ-700'])

			// A filter REQ-700 does not match at all (it only declares
			// 'derived-from -> PRD-001'): before the fix, extension-only loss was
			// unconditionally added to the membership-risk set whenever ANY
			// relation filter was requested, gating this unrelated query too.
			const result = await executeQuery(withLoss, { kind: 'list', relationType: 'governed-by', relationTarget: 'POL-001' })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.map(a => a.id))
				.toEqual(['REQ-001'])
		})

		it('an EF-RES-001 confined to \'normative\' gates a resource_normative filter (the exact lossy field this filter reads)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-970.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-970
title: Malformed Normative Field
status: active
summary: A requirement whose Resource 'normative' field is malformed, for Finding 9's per-field loss regression.
tags: []
relations: []
resources:
  - type: reference
    location: .engineering/resources/REQ-970/notes.md
    role: reference
    media_type: text/markdown
    normative: "yes"
    description: Notes.
---

## Requirement

Exercises EF-RES-001 confined to the 'normative' field.

## Rationale

Finding 9 regression fixture.

## Acceptance Criteria

- N/A.
`)
			await writeFile(tempDir, '.engineering/resources/REQ-970/notes.md', '# Notes\n')
			const withLoss = await reloadContext()
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-970') ?? [])])
				.toEqual(['normative'])

			const result = await executeQuery(withLoss, { kind: 'list', resourceNormative: false })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Sixth-round Finding 8: the consumed-field set a `resourceType`/
		// `resourceRole`/`resourceNormative` filter checks against must be built
		// from the options THIS request actually supplies, not a fixed union of
		// every field `list` could ever filter on -- otherwise a malformed field
		// this request never reads (e.g. `role`/`normative` for a
		// `resource_type`-only request) would falsely gate it. Each fixture
		// below deliberately declares a valid (non-loss-affected), non-matching
		// value for the field the test's own filter actually reads, so the
		// Artifact is never returned on the page at all -- isolating this
		// round's PRE-pagination membership-risk fix (Finding 8) from the
		// separate, legitimate per-RETURNED-Artifact completeness gate (Finding
		// A), which fires for a completely different, orthogonal reason
		// whenever a malformed Artifact IS actually returned.
		async function writeMalformedRoleResource(): Promise<void> {
			await writeFile(tempDir, '.engineering/req/REQ-972.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-972
title: Malformed Role Field
status: active
summary: A requirement whose Resource 'role' field is malformed, for Finding 8's cross-field non-interference regression.
tags: []
relations: []
resources:
  - type: json-schema
    location: .engineering/resources/REQ-972/notes.md
    role: 123
    media_type: text/markdown
    normative: false
    description: Notes.
---

## Requirement

Exercises EF-RES-001 confined to the 'role' field.

## Rationale

Finding 8 regression fixture.

## Acceptance Criteria

- N/A.
`)
			await writeFile(tempDir, '.engineering/resources/REQ-972/notes.md', '# Notes\n')
		}

		async function writeMalformedNormativeResource(): Promise<void> {
			await writeFile(tempDir, '.engineering/req/REQ-970.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-970
title: Malformed Normative Field
status: active
summary: A requirement whose Resource 'normative' field is malformed, for Finding 8's cross-field non-interference regression.
tags: []
relations: []
resources:
  - type: json-schema
    location: .engineering/resources/REQ-970/notes.md
    role: explanation
    media_type: text/markdown
    normative: "yes"
    description: Notes.
---

## Requirement

Exercises EF-RES-001 confined to the 'normative' field.

## Rationale

Finding 8 regression fixture.

## Acceptance Criteria

- N/A.
`)
			await writeFile(tempDir, '.engineering/resources/REQ-970/notes.md', '# Notes\n')
		}

		async function writeMalformedTypeResource(): Promise<void> {
			await writeFile(tempDir, '.engineering/req/REQ-971.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-971
title: Malformed Type Field
status: active
summary: A requirement whose Resource 'type' field is malformed, for Finding 8's cross-field non-interference regression.
tags: []
relations: []
resources:
  - type: 123
    location: .engineering/resources/REQ-971/notes.md
    role: explanation
    media_type: text/markdown
    normative: false
    description: Notes.
---

## Requirement

Exercises EF-RES-001 confined to the 'type' field.

## Rationale

Finding 8 regression fixture.

## Acceptance Criteria

- N/A.
`)
			await writeFile(tempDir, '.engineering/resources/REQ-971/notes.md', '# Notes\n')
		}

		it('a resource_type-only filter is unaffected by EF-RES-001 confined to \'role\'/\'normative\' elsewhere', async () => {
			// REQ-972/REQ-970 both declare a valid, non-matching Resource 'type'
			// (`json-schema`, not the requested `reference`), so neither is ever
			// returned -- isolating the pre-pagination membership-risk check.
			await writeMalformedRoleResource()
			await writeMalformedNormativeResource()
			const withLoss = await reloadContext()
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-972') ?? [])])
				.toEqual(['role'])
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-970') ?? [])])
				.toEqual(['normative'])

			const result = await executeQuery(withLoss, { kind: 'list', resourceType: 'reference' })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.map(a => a.id))
				.not.toEqual(expect.arrayContaining(['REQ-970', 'REQ-972']))
		})

		it('a resource_role-only filter is unaffected by EF-RES-001 confined to \'type\'/\'normative\' elsewhere', async () => {
			// REQ-971/REQ-970 both declare a valid, non-matching Resource 'role'
			// (`explanation`, not the requested `reference`).
			await writeMalformedTypeResource()
			await writeMalformedNormativeResource()
			const withLoss = await reloadContext()
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-971') ?? [])])
				.toEqual(['type'])
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-970') ?? [])])
				.toEqual(['normative'])

			const result = await executeQuery(withLoss, { kind: 'list', resourceRole: 'reference' })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.map(a => a.id))
				.not.toEqual(expect.arrayContaining(['REQ-970', 'REQ-971']))
		})

		it('a resource_normative-only filter is unaffected by EF-RES-001 confined to \'type\'/\'role\' elsewhere', async () => {
			// REQ-971/REQ-972 both declare a valid, non-matching Resource
			// 'normative' (`false`, not the requested `true`).
			await writeMalformedTypeResource()
			await writeMalformedRoleResource()
			const withLoss = await reloadContext()
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-971') ?? [])])
				.toEqual(['type'])
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-972') ?? [])])
				.toEqual(['role'])

			const result = await executeQuery(withLoss, { kind: 'list', resourceNormative: true })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.artifacts.map(a => a.id))
				.not.toEqual(expect.arrayContaining(['REQ-971', 'REQ-972']))
		})

		// Eighth-round Finding 8: envelope loss precision (`envelopeFieldLossById`
		// intersected against exactly the core fields THIS request's
		// filters/pagination consume), replacing the field-unscoped
		// `envelopeWideLossArtifactIds` bucket as a list-membership-risk signal.
		describe('envelope loss precision (Finding 8, eighth-round)', () => {
			it('a duplicate-title requirement outside the returned page does not gate an unrelated --type list filter', async () => {
				await writeFile(tempDir, '.engineering/req/REQ-999.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-999
title: Duplicate Title Requirement
title: Duplicated Title
status: active
summary: A requirement whose title key is duplicated (EF-ENV-005), for Finding 8's list-membership-risk precision regression -- a duplicate-title loss is projection-only and must not gate an unrelated --type filter when this record sits outside the returned page.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-ENV-005 confined to the 'title' field.

## Rationale

Finding 8 (eighth-round) regression fixture.

## Acceptance Criteria

- N/A.
`)
				const withLoss = await reloadContext()
				expect([...(withLoss.validation.envelopeFieldLossById.get('REQ-999') ?? [])])
					.toEqual(['title'])

				// REQ-999 genuinely matches the '--type requirement' filter (its
				// own 'type' field is fully trustworthy) and so counts toward
				// `total`, but its title loss is projection-only, and REQ-999 sorts
				// (bytewise) after every existing requirement, so `limit: 5` keeps
				// it off the returned page entirely. Before the fix, the coarse
				// `envelopeWideLossArtifactIds` bucket added REQ-999 to the
				// membership-risk set unconditionally (any filter, any field),
				// failing this entire unrelated request.
				const result = await executeQuery(withLoss, { kind: 'list', type: ['requirement'], limit: 5 })
				expect(result.complete)
					.toBe(true)
				expect(result.data!.total)
					.toBe(6)
				expect(result.data!.artifacts.map(a => a.id))
					.toEqual(['REQ-001', 'REQ-002', 'REQ-010', 'REQ-011', 'REQ-012'])
			})

			it('positive control: a duplicate-schema requirement gates an unrelated --schema list filter even outside the returned page, since \'schema\' IS the consumed field', async () => {
				await writeFile(tempDir, '.engineering/req/REQ-998.md', `---
schema: ef/requirement@1
schema: ef/requirement@1
type: requirement
id: REQ-998
title: Duplicate Schema Requirement
status: active
summary: A requirement whose schema key is duplicated (EF-ENV-005), for Finding 8's positive control -- unlike the duplicate-title case above, 'schema' IS the field this request's own filter reads, so it must still gate even though REQ-998 sits outside the returned page.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-ENV-005 confined to the 'schema' field.

## Rationale

Finding 8 (eighth-round) positive-control regression fixture.

## Acceptance Criteria

- N/A.
`)
				const withLoss = await reloadContext()
				expect([...(withLoss.validation.envelopeFieldLossById.get('REQ-998') ?? [])])
					.toEqual(['schema'])

				const result = await executeQuery(withLoss, { kind: 'list', schema: 'ef/requirement@1', limit: 1 })
				expect(result.complete)
					.toBe(false)
				expect(result.diagnostics[0]!.code)
					.toBe('EF-QRY-013')
			})
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

		// Ninth-round Finding 9: an EF-RES-001 confined to a field search never
		// reads ('normative'/'type'/'role') must not gate search, unlike an
		// EF-RES-001 that actually touches 'location'/'description'.
		it('an EF-RES-001 confined to \'normative\' (location/description intact) does not gate search', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-970.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-970
title: Malformed Normative Field
status: active
summary: A requirement whose Resource 'normative' field is malformed, for Finding 9's per-field loss regression.
tags: []
relations: []
resources:
  - type: reference
    location: .engineering/resources/REQ-970/notes.md
    role: reference
    media_type: text/markdown
    normative: "yes"
    description: Notes.
---

## Requirement

Exercises EF-RES-001 confined to the 'normative' field.

## Rationale

Finding 9 regression fixture.

## Acceptance Criteria

- N/A.
`)
			await writeFile(tempDir, '.engineering/resources/REQ-970/notes.md', '# Notes\n')
			const withLoss = await reloadContext()
			expect([...(withLoss.validation.resourceFieldLossById.get('REQ-970') ?? [])])
				.toEqual(['normative'])

			const result = await executeQuery(withLoss, { kind: 'search', terms: ['filtering'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.results.some(r => r.artifact.id === 'REQ-970'))
				.toBe(false)
		})

		// Seventh-round Finding 7: search reads every Artifact's best-effort
		// decoded body text (`bodyText`), where an invalid UTF-8 byte becomes
		// U+FFFD (`EF-FS-005`/`byteDecodingLossArtifactIds`). When that
		// replacement falls inside the exact token a search request asks for,
		// the corrupted Artifact never matches and so never reaches
		// `data.results` -- the per-result `projectionLossArtifactIds` check
		// cannot fire for an Artifact that was never returned -- silently
		// yielding an empty/partial `complete: true` result instead of
		// reporting the loss.
		it('gates search with EF-QRY-013 when an invalid UTF-8 byte inside the searched token could have hidden a match, instead of silently returning empty', async () => {
			const corrupted = corruptedBodyBytes('REQ-600', 'zzzcorruptedtoken')
			await writeFileBytes(tempDir, '.engineering/req/REQ-600.md', corrupted)
			const withBodyLoss = await reloadContext()

			// Confirm the fixture produces body-only byte-decoding loss without
			// flipping graphTrustworthy (only the frontmatter/identity facts
			// gate that; the corrupted byte here is confined to the body).
			expect(withBodyLoss.validation.graphTrustworthy)
				.toBe(true)
			expect([...withBodyLoss.validation.byteDecodingLossArtifactIds])
				.toContain('REQ-600')

			const result = await executeQuery(withBodyLoss, { kind: 'search', terms: ['zzzcorruptedtoken'] })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Eighth-round Finding 8: the same envelope-loss precision extended to
		// search's own consumed surfaces (`SEARCH_CONSUMED_CORE_FIELDS`:
		// title/summary/tags/resources).
		describe('envelope loss precision (Finding 8, eighth-round)', () => {
			it('a duplicate top-level \'relations\' key does not gate an unrelated search request: search never reads \'relations\'', async () => {
				await writeFile(tempDir, '.engineering/req/REQ-997.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-997
title: Duplicate Relations Key
status: active
summary: A requirement whose relations key is duplicated (EF-ENV-005), for Finding 8's search-membership precision regression -- search never reads 'relations', so this loss must not gate an unrelated search request.
tags: []
relations:
  - type: references
    target: PROJECT
relations:
  - type: references
    target: PROJECT
resources: []
---

## Requirement

Exercises EF-ENV-005 confined to the 'relations' field.

## Rationale

Finding 8 (eighth-round) search-membership regression fixture.

## Acceptance Criteria

- N/A.
`)
				const withLoss = await reloadContext()
				expect([...(withLoss.validation.envelopeFieldLossById.get('REQ-997') ?? [])])
					.toEqual(['relations'])

				// Before the fix, the field-unscoped `envelopeWideLossArtifactIds`
				// bucket gated EVERY search request while REQ-997 existed anywhere
				// in the project, regardless of what its loss actually touched.
				const result = await executeQuery(withLoss, { kind: 'search', terms: ['filtering'] })
				expect(result.complete)
					.toBe(true)
				expect(result.data!.results.map(r => r.artifact.id))
					.toContain('REQ-001')
			})

			it('positive control: a duplicate-title requirement gates an unrelated search request, since \'title\' IS a surface search reads', async () => {
				await writeFile(tempDir, '.engineering/req/REQ-996.md', `---
schema: ef/requirement@1
type: requirement
id: REQ-996
title: Duplicate Title Requirement
title: Duplicated Title
status: active
summary: A requirement whose title key is duplicated (EF-ENV-005), for Finding 8's positive control -- unlike the duplicate-relations case above, title is a surface buildSurfaces reads for every Artifact, so this loss must still gate search even for an unrelated term.
tags: []
relations: []
resources: []
---

## Requirement

Exercises EF-ENV-005 confined to the 'title' field.

## Rationale

Finding 8 (eighth-round) positive-control regression fixture.

## Acceptance Criteria

- N/A.
`)
				const withLoss = await reloadContext()
				expect([...(withLoss.validation.envelopeFieldLossById.get('REQ-996') ?? [])])
					.toEqual(['title'])

				// 'ranking' only matches REQ-002's own summary, entirely unrelated
				// to REQ-996 -- demonstrating the risk check fires for the whole
				// request, not merely when the lossy record itself would match.
				const result = await executeQuery(withLoss, { kind: 'search', terms: ['ranking'] })
				expect(result.complete)
					.toBe(false)
				expect(result.diagnostics[0]!.code)
					.toBe('EF-QRY-013')
			})
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

		// Seventh-round Finding 7: EF-REL-006 (duplicate relation) is now tracked
		// in `edgeLossArtifactIds`, so an outgoing-only query that consults the
		// affected Artifact's own array is gated the same way any other
		// edge-loss cause already was.
		it('eF-QRY-013 for an outgoing query whose own relations array declares a duplicate (type, target) pair (EF-REL-006)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-963.md', REQ_DUP_RELATION)
			const badContext = await reloadContext()
			expect([...badContext.validation.edgeLossArtifactIds])
				.toContain('REQ-963')

			const result = await executeQuery(badContext, { kind: 'relations', id: 'REQ-963', direction: 'outgoing' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Sixth-round Finding 9: a duplicate-relation loss (EF-REL-006) confined
		// to 'governed-by' must not gate an outgoing query restricted to
		// 'derived-from' -- that semantically invalid edge can never be read or
		// returned by this specific traversal.
		it('a semantic edge loss (EF-REL-004) confined to \'governed-by\' does NOT gate an outgoing query restricted to \'derived-from\'', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const mixedContext = await reloadContext()
			expect([...(mixedContext.validation.semanticEdgeLossRelationTypesBySourceId.get('REQ-964') ?? [])])
				.toEqual(['governed-by'])

			const result = await executeQuery(mixedContext, { kind: 'relations', id: 'REQ-964', direction: 'outgoing', types: ['derived-from'] })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.edges)
				.toEqual([{ source: 'REQ-964', type: 'derived-from', target: 'PRD-001' }])
		})

		it('the SAME semantic edge loss (EF-REL-004) DOES gate an outgoing query restricted to \'governed-by\' (the exact affected type)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const mixedContext = await reloadContext()

			const result = await executeQuery(mixedContext, { kind: 'relations', id: 'REQ-964', direction: 'outgoing', types: ['governed-by'] })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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

		// Seventh-round Finding 7: same EF-REL-006 edge-trust gating as
		// `relations`' outgoing case.
		it('eF-QRY-013 for an outgoing trace whose root declares a duplicate (type, target) pair (EF-REL-006)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-963.md', REQ_DUP_RELATION)
			const badContext = await reloadContext()

			const result = await executeQuery(badContext, { kind: 'trace', roots: ['REQ-963'], types: ['derived-from'], direction: 'outgoing', maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Sixth-round Finding 9: same per-(source,type) narrowing as `relations`.
		it('a semantic edge loss (EF-REL-004) confined to \'governed-by\' does NOT gate an outgoing trace restricted to \'derived-from\'', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const mixedContext = await reloadContext()

			const result = await executeQuery(mixedContext, { kind: 'trace', roots: ['REQ-964'], types: ['derived-from'], direction: 'outgoing', maxDepth: 1 })
			expect(result.complete)
				.toBe(true)
			expect(result.data!.edges)
				.toEqual([{ source: 'REQ-964', type: 'derived-from', target: 'PRD-001' }])
		})

		it('the SAME semantic edge loss (EF-REL-004) DOES gate an outgoing trace restricted to \'governed-by\' (the exact affected type)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-964.md', REQ_MIXED_TYPE_LOSS)
			const mixedContext = await reloadContext()

			const result = await executeQuery(mixedContext, { kind: 'trace', roots: ['REQ-964'], types: ['governed-by'], direction: 'outgoing', maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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

		// Sixth-round Finding 6: `impact`'s `resolve_current` option runs the
		// identical per-root current-resolution algorithm `resolve-current`
		// does, and must gate on the same zero-edge-reachable invalid
		// supersession facts.
		it('eF-QRY-013 when resolve_current reaches a superseded root with no direct replacement (EF-SUP-001), even with zero resolution edges', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-960.md', REQ_SUP_NO_REPLACEMENT)
			const badContext = await reloadContext()

			const result = await executeQuery(badContext, { kind: 'impact', roots: ['REQ-960'], maxDepth: 1, resolveCurrent: true })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		it('eF-QRY-013 when resolve_current reaches an active root illegally declaring \'superseded-by\' (EF-SUP-002), even though it resolves to itself with zero edges', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-961.md', REQ_SUP_ILLEGAL_DECLARE)
			const badContext = await reloadContext()

			const result = await executeQuery(badContext, { kind: 'impact', roots: ['REQ-961'], maxDepth: 1, resolveCurrent: true })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Seventh-round Finding 7: impact's traversal direction is always
		// incoming, so it stays gated by the project-wide `edgeLossArtifactIds`
		// check regardless of where in the project the duplicate relation lives.
		it('eF-QRY-013 project-wide when ANY Artifact has a duplicate relation entry (EF-REL-006), even for an unrelated impact root', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-963.md', REQ_DUP_RELATION)
			const badContext = await reloadContext()
			expect([...badContext.validation.edgeLossArtifactIds])
				.toContain('REQ-963')

			const result = await executeQuery(badContext, { kind: 'impact', roots: ['REQ-001'], maxDepth: 1 })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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

		// Sixth-round Finding 6: a superseded Artifact with NO direct replacement
		// (EF-SUP-001) resolves via `domain/supersession.ts#resolveCurrent` to
		// `currentIds: []` with zero edges -- exactly the same shape as a
		// legitimate "retired replacement leaf" (05-supersession "Retired
		// replacement leaves"). Because the prior gate only inspected
		// `result.edges`' own `source` side, a ZERO-edge resolution never
		// populated `consumedSourceIds` at all, so this invalid supersession
		// fact silently escaped every trust check.
		it('eF-QRY-013 for a superseded input with no direct replacement (EF-SUP-001), even though the resolution itself has zero edges', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-960.md', REQ_SUP_NO_REPLACEMENT)
			const badContext = await reloadContext()
			expect([...badContext.validation.supersessionFactInvalidArtifactIds])
				.toContain('REQ-960')

			const result = await executeQuery(badContext, { kind: 'resolve-current', id: 'REQ-960' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Sixth-round Finding 6: an ACTIVE Artifact illegally declaring
		// 'superseded-by' (EF-SUP-002) resolves to itself: `resolveCurrent`
		// branches on `status === 'active'` and never reads the (illegal)
		// `superseded-by` array at all, so no edge is ever produced and the
		// prior `consumedSourceIds`-only gate could never see this fact either
		// -- even though the INPUT itself is the affected Artifact.
		it('eF-QRY-013 for an active input illegally declaring \'superseded-by\' (EF-SUP-002), even though it resolves to itself with zero edges', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-961.md', REQ_SUP_ILLEGAL_DECLARE)
			const badContext = await reloadContext()
			expect([...badContext.validation.supersessionFactInvalidArtifactIds])
				.toContain('REQ-961')

			const result = await executeQuery(badContext, { kind: 'resolve-current', id: 'REQ-961' })
			expect(result.complete)
				.toBe(false)
			expect(result.data)
				.toBeNull()
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
		})

		// Seventh-round Finding 7: EF-REL-006 (duplicate relation) confined to a
		// 'superseded-by' entry is now tracked in `edgeLossArtifactIds`, so the
		// existing consumed-source edge-trust check gates the source once its
		// outgoing array is actually traversed.
		it('eF-QRY-013 when resolve-current traverses a superseded source whose replacement set duplicates the same target twice (EF-REL-006)', async () => {
			await writeFile(tempDir, '.engineering/req/REQ-962.md', REQ_SUP_DUP_REPLACEMENT)
			const badContext = await reloadContext()
			expect([...badContext.validation.edgeLossArtifactIds])
				.toContain('REQ-962')

			const result = await executeQuery(badContext, { kind: 'resolve-current', id: 'REQ-962' })
			expect(result.complete)
				.toBe(false)
			expect(result.diagnostics[0]!.code)
				.toBe('EF-QRY-013')
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
			// Finding 5 (bootstrap boundary full-snapshot validation): the
			// claimed bootstrap commit must be a genuine, COMPLETE bootstrap --
			// no CHG Artifact, no terminal (superseded/retired) knowledge
			// Artifact. `writeRichProject`'s fixture set (used elsewhere as a
			// plain working-tree snapshot, never itself committed to Git) is not
			// bootstrap-eligible as a whole: `CHG-001` is a completed change,
			// and `REQ-010`/`REQ-011` are superseded requirements. Excluded here
			// so the single commit this test commits qualifies as a valid
			// bootstrap boundary; neither file is needed to walk REQ-001's own
			// history.
			await fs.rm(path.join(tempDir, '.engineering/chg/CHG-001.md'))
			await fs.rm(path.join(tempDir, '.engineering/req/REQ-010.md'))
			await fs.rm(path.join(tempDir, '.engineering/req/REQ-011.md'))
			execFileSync('git', ['-C', tempDir, 'init', '-q', '-b', 'main'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'add', '-A'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'commit', '-q', '-m', 'bootstrap'], { env: { ...process.env, ...GIT_TEST_ENV } })
			const tipOid = execFileSync('git', ['-C', tempDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
				.trim()

			const historyContext: QueryContext = {
				...context,
				history: { git: createGitRepository(tempDir, createGitExecutor()), integrationRefOid: tipOid, integrationRef: 'refs/heads/main' },
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
				history: { git: brokenGit, integrationRefOid: tipOid, integrationRef: 'refs/heads/main' },
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
			// Finding 5 (bootstrap boundary full-snapshot validation): the
			// `readBlob` override below must target REQ-001.md's blob at a
			// commit that is NOT itself the claimed bootstrap boundary --
			// otherwise the failure surfaces one level higher, as the
			// boundary's own full-snapshot materialization failing
			// (`history-unavailable`, EF-QRY-010) rather than the walk's later,
			// more specific untrustworthy-data check (EF-QRY-013). REQ-001.md
			// (and ADR-001.md, which `addresses` it) are therefore committed
			// in a SECOND commit, after a bootstrap commit that excludes them
			// -- along with `CHG-001` (a completed change) and
			// `REQ-010`/`REQ-011` (superseded knowledge Artifacts), neither of
			// which is a valid bootstrap-boundary state at all.
			await fs.rm(path.join(tempDir, '.engineering/chg/CHG-001.md'))
			await fs.rm(path.join(tempDir, '.engineering/req/REQ-010.md'))
			await fs.rm(path.join(tempDir, '.engineering/req/REQ-011.md'))
			await fs.rm(path.join(tempDir, '.engineering/req/REQ-001.md'))
			await fs.rm(path.join(tempDir, '.engineering/adr/ADR-001.md'))
			execFileSync('git', ['-C', tempDir, 'init', '-q', '-b', 'main'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'add', '-A'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'commit', '-q', '-m', 'bootstrap'], { env: { ...process.env, ...GIT_TEST_ENV } })

			await writeFile(tempDir, '.engineering/req/REQ-001.md', REQ_001)
			await writeFile(tempDir, '.engineering/adr/ADR-001.md', ADR_001)
			execFileSync('git', ['-C', tempDir, 'add', '-A'], { env: { ...process.env, ...GIT_TEST_ENV } })
			execFileSync('git', ['-C', tempDir, 'commit', '-q', '-m', 'introduce REQ-001'], { env: { ...process.env, ...GIT_TEST_ENV } })
			const tipOid = execFileSync('git', ['-C', tempDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
				.trim()

			const realGit = createGitRepository(tempDir, createGitExecutor())
			// REQ-001.md exists as a real blob at `tipOid`'s tree (proven by the
			// real `readTree` call this override still delegates to); only that
			// specific blob's content fetch is forced to fail, distinct from a
			// genuine absence. `computeHistory` also reads `.engineering/ef.yaml`'s
			// own blob to validate the bootstrap boundary; that read must still
			// succeed for real or the walk never reaches bootstrap at all, so the
			// override is scoped to the REQ-001.md blob oid specifically rather
			// than failing every `readBlob` call unconditionally.
			const treeResult = await realGit.readTree(tipOid)
			if (treeResult.kind !== 'resolved')
				throw new Error(`expected tree to resolve, got ${treeResult.kind}`)
			const req001Entry = treeResult.entries.find(entry => entry.path === '.engineering/req/REQ-001.md')
			if (!req001Entry)
				throw new Error('expected .engineering/req/REQ-001.md to be present in the tree')
			const brokenGit = wrapGitRepository(realGit, {
				readBlob: async (blobOid: string) => (blobOid === req001Entry.oid ? { kind: 'missing' } : realGit.readBlob(blobOid)),
			})
			const historyContext: QueryContext = {
				...context,
				history: { git: brokenGit, integrationRefOid: tipOid, integrationRef: 'refs/heads/main' },
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
