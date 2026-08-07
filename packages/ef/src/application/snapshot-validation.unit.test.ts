import type { ProjectSnapshot, SnapshotArtifactFile, SnapshotEntryKind } from './snapshot'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeEnvelope } from '../domain/envelope'
import { createGitExecutor } from '../git/executor'
import { createGitRepository } from '../git/repository'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { parseBody } from '../parsing/markdown'
import { loadSnapshotFromCommit, loadSnapshotFromWorkingTree } from './snapshot'
import { summarizeValidation, validateSnapshot } from './snapshot-validation'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const GITIGNORE = `.cache/
.generated/
.tmp/
.lock
`

const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for validation pipeline tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering specification workflow for this repository.

## Scope

This project covers specification-driven engineering artifacts under .engineering.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

The project operates as a single-repository workspace with no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
`

interface RequirementOptions {
	id: string
	status?: string
	relations?: string
	resources?: string
	acceptanceCriteria?: string
}

function requirementMd(options: RequirementOptions): string {
	const status = options.status ?? 'active'
	const relations = options.relations ?? '[]'
	const resources = options.resources ?? '[]'
	const acceptanceCriteria = options.acceptanceCriteria ?? '- The system behaves as specified.'
	return `---
schema: ef/requirement@1
type: requirement
id: ${options.id}
title: Example Requirement
status: ${status}
summary: A minimal example requirement used for validation pipeline tests.
tags: []
relations: ${relations}
resources: ${resources}
---

## Requirement

The system must behave as specified by this requirement.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

${acceptanceCriteria}
`
}

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

async function writeMinimalProject(root: string): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/.gitignore', GITIGNORE)
	await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
}

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

function codesOf(diagnostics: readonly { code: string }[]): string[] {
	return diagnostics.map(d => d.code)
		.sort()
}

describe('validateSnapshot', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-validate-')))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function load(): Promise<ReturnType<typeof validateSnapshot>> {
		const result = await loadSnapshotFromWorkingTree(tempDir)
		if (!result.ok)
			throw new Error(`failed to load snapshot: ${result.reason}`)
		return validateSnapshot(result.snapshot)
	}

	it('is valid with zero diagnostics for a minimal valid project', async () => {
		await writeMinimalProject(tempDir)
		const result = await load()
		expect(result.diagnostics)
			.toEqual([])
		expect(result.complete)
			.toBe(true)
		expect([...result.byId.keys()])
			.toEqual(['PROJECT'])
	})

	it('accepts a valid active REQ artifact and links it in byId', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
		const result = await load()
		expect(result.diagnostics)
			.toEqual([])
		expect([...result.byId.keys()].sort())
			.toEqual(['PROJECT', 'REQ-001'])
	})

	describe('config phase', () => {
		it('reports EF-FS-001 for a config missing a required field', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/ef.yaml', 'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/main\nlinked_repositories: []\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-001')
			expect(result.complete)
				.toBe(true)
		})

		it('reports EF-VAL-007 and complete: false when ef.yaml is entirely absent', async () => {
			await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
			const result = await load()
			expect(result.complete)
				.toBe(false)
			expect(codesOf(result.diagnostics))
				.toContain('EF-VAL-007')
		})
	})

	// Seventh-round Finding 8: `.engineering/.gitignore` is a tracked
	// PROJECT-owned control file (11-filesystem-and-config.md) that MUST exist
	// with exactly the four canonical entries; absence or divergence was
	// previously silently accepted.
	describe('gitignore control file (EF-FS-009, seventh-round Finding 8)', () => {
		it('reports EF-FS-009 (and stays complete: true) when .engineering/.gitignore is entirely absent', async () => {
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-009')
			expect(result.complete)
				.toBe(true)
		})

		it('reports EF-FS-009 when .engineering/.gitignore content does not exactly match the four canonical entries', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/.gitignore', '.cache/\n.generated/\n.tmp/\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-009')
		})

		it('reports EF-FS-009 when the four entries are present but out of the canonical order', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/.gitignore', '.lock\n.tmp/\n.generated/\n.cache/\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-009')
		})

		it('does not report EF-FS-009 for the exact canonical content', async () => {
			await writeMinimalProject(tempDir)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-FS-009')
		})

		it('does not report EF-FS-009 when EF-FS-005 already fired for the same file (encoding-level violation keeps precedence)', async () => {
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
			// A UTF-8 BOM makes the file's raw bytes diverge from the canonical
			// bytes (so EF-FS-009's byte-equality check would also fail), but the
			// encoding-level EF-FS-005 finding must be the only one reported for
			// this file.
			await writeFileBytes(tempDir, '.engineering/.gitignore', new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder()
				.encode(GITIGNORE)]))
			const result = await load()
			const gitignoreDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/.gitignore')
			expect(codesOf(gitignoreDiagnostics))
				.toEqual(['EF-FS-005'])
		})
	})

	describe('layout phase', () => {
		it('reports EF-FS-003 for an entry that violates the canonical layout', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/stray.txt', 'not a control file\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-003')
		})
	})

	describe('parse phase cascading suppression', () => {
		it('reports only EF-ENV-001 for a file with unterminated frontmatter, and validates the PROJECT independently', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nschema: ef/requirement@1\ntype: requirement\n')
			const result = await load()

			const brokenFileDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/req/REQ-001.md')
			expect(codesOf(brokenFileDiagnostics))
				.toEqual(['EF-ENV-001'])
			expect(result.byId.has('REQ-001'))
				.toBe(false)

			const projectDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/PROJECT.md')
			expect(projectDiagnostics)
				.toEqual([])
		})
	})

	describe('envelope phase cascading suppression', () => {
		it('suppresses identity/status/relation/body findings when the envelope fails to decode', async () => {
			await writeMinimalProject(tempDir)
			// Missing 'id', 'title', 'status', 'summary', 'tags', 'relations', 'resources'.
			await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nschema: ef/requirement@1\ntype: requirement\n---\n\nbody\n')
			const result = await load()

			const fileDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/req/REQ-001.md')
			expect(fileDiagnostics.length)
				.toBeGreaterThan(0)
			expect(fileDiagnostics.every(d => d.code === 'EF-ENV-003'))
				.toBe(true)
			expect(result.byId.has('REQ-001'))
				.toBe(false)
		})
	})

	describe('array entry shape suppression', () => {
		it('suppresses the redundant EF-ENV-004 finding for a non-mapping relation entry, keeping only EF-REL-002', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - not-a-mapping\n',
			}))
			const result = await load()
			const reqDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/req/REQ-001.md')
			expect(codesOf(reqDiagnostics))
				.toEqual(['EF-REL-002'])
		})

		it('suppresses the redundant EF-ENV-004 finding for a non-mapping resource entry, keeping only EF-RES-001', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - not-a-mapping\n',
			}))
			const result = await load()
			const reqDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/req/REQ-001.md')
			expect(codesOf(reqDiagnostics))
				.toEqual(['EF-RES-001'])
		})
	})

	describe('identity graph integrity', () => {
		it('reports EF-ID-004 for a duplicated Artifact ID and does not crash relation-graph resolution', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-004')
			// EF-ID-005 (filename must match ID) also fires for the second file.
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-005')
		})

		it('excludes a duplicated ID from byId/relationById/currentIds entirely, blocks relations targeting it without a speculative EF-REL-003, and marks the graph untrustworthy', async () => {
			// Two files declare the same ID (REQ-001); a third, unambiguous
			// Artifact (REQ-003) declares a relation TARGETING that ambiguous ID.
			// 02-identity.md "Duplicate handling": "graph validation MUST NOT
			// resolve the ID to either file"; 09-validation.md "Cascading
			// Diagnostics": the resulting relation-target check must not report
			// a second, speculative "does not exist" finding once EF-ID-004
			// already reports the collision.
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/req/REQ-003.md', requirementMd({
				id: 'REQ-003',
				relations: '\n  - type: references\n    target: REQ-001\n',
			}))
			const result = await load()

			// Excluded from every dependent index -- not resolved to either file.
			expect(result.byId.has('REQ-001'))
				.toBe(false)
			expect(result.incomingRelations.get('REQ-001'))
				.toBeUndefined()
			expect(result.currentIds.has('REQ-001'))
				.toBe(false)

			// The unambiguous Artifact is unaffected.
			expect(result.byId.has('REQ-003'))
				.toBe(true)

			// No speculative EF-REL-003 for the blocked (not "nonexistent")
			// target; EF-ID-004 (plus the unrelated EF-ID-005 filename mismatch)
			// remain the only identity/relation findings.
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-ID-004', 'EF-ID-005'])

			// A query over this snapshot cannot be trusted while the ID stays
			// ambiguous (10-query-and-trace.md "Invalid Graph and Partial
			// Results").
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('resolve-current for a duplicated ID has no entry in currentIds (resolution fails rather than picking either file)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'superseded', relations: '\n  - type: superseded-by\n    target: REQ-900\n' }))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-001', status: 'superseded', relations: '\n  - type: superseded-by\n    target: REQ-900\n' }))
			await writeFile(tempDir, '.engineering/req/REQ-900.md', requirementMd({ id: 'REQ-900' }))
			const result = await load()

			expect(result.byId.has('REQ-001'))
				.toBe(false)
			expect(result.currentIds.has('REQ-001'))
				.toBe(false)
			expect(result.graphTrustworthy)
				.toBe(false)
		})
	})

	describe('graph trustworthiness (10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
		it('is trustworthy for a minimal valid project', async () => {
			await writeMinimalProject(tempDir)
			const result = await load()
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		it('is untrustworthy when an Artifact file fails to decode (unterminated frontmatter)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nschema: ef/requirement@1\ntype: requirement\n')
			const result = await load()
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy when an Artifact envelope fails to decode', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', '---\nschema: ef/requirement@1\ntype: requirement\n---\n\nbody\n')
			const result = await load()
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy when a layout entry could itself be an unparsed Artifact (EF-FS-003)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/stray.txt', 'not a control file\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-003')
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('stays trustworthy for a body-schema-only error that does not exclude the Artifact from the graph', async () => {
			await writeMinimalProject(tempDir)
			// A required section left in placeholder form is a body-schema
			// finding, not a decode/identity/layout one; the Artifact still
			// decodes into byId.
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', acceptanceCriteria: '- TODO' }))
			const result = await load()
			expect(result.byId.has('REQ-001'))
				.toBe(true)
			expect(result.diagnostics.length)
				.toBeGreaterThan(0)
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		// Adjudicated ruling (Finding C): the gate must also include EF-ID-001,
		// 002, 003, 007, 008 -- every identity finding that invalidates
		// graph-membership trust, not just EF-ID-004/006/FS-003. EF-ID-005/014
		// (filename/path convention violations where the ID itself is unique
		// and decoded) must NOT gate.

		it('is untrustworthy when no PROJECT Artifact exists (EF-ID-007)', async () => {
			// Deliberately omit PROJECT.md; a required-PROJECT-context query
			// (e.g. lookup PROJECT) must not be able to return an ordinary
			// complete: true/found: false result over this snapshot.
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-007')
			expect(result.byId.has('PROJECT'))
				.toBe(false)
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy when the PROJECT Artifact declares an ID other than PROJECT (EF-ID-008)', async () => {
			await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
			await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD.replace('id: PROJECT', 'id: NOTPROJECT'))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-008')
			expect(result.byId.has('PROJECT'))
				.toBe(false)
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy for a malformed Artifact ID (EF-ID-001)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ_001.md', requirementMd({ id: 'REQ_001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-ID-001'])
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy for an ID prefix that does not match the Artifact type (EF-ID-002)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/ADR-001.md', requirementMd({ id: 'ADR-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-ID-002'])
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('is untrustworthy for a non-canonical numeric ID component (EF-ID-003)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-01.md', requirementMd({ id: 'REQ-01' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-ID-003'])
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('stays trustworthy for an EF-ID-005-only filename mismatch (the declared ID itself is unique and decoded)', async () => {
			await writeMinimalProject(tempDir)
			// REQ-001 is well-formed and unambiguous; only the filename fails
			// to match it.
			await writeFile(tempDir, '.engineering/req/REQ-999.md', requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toEqual(['EF-ID-005'])
			expect(result.byId.has('REQ-001'))
				.toBe(true)
			expect(result.graphTrustworthy)
				.toBe(true)
		})
	})

	// Seventh-round Finding 6: a projected Artifact's `path` is spec-fixed as
	// its canonical, project-relative path (10-query-and-trace.md), but
	// `buildArtifactSummary` projects the actual discovered path verbatim. An
	// Artifact whose filename mismatches its ID (EF-ID-005), sits outside its
	// canonical directory (EF-ID-014), or whose discovered path is not itself
	// Unicode-NFC-normalized (EF-FS-006, for the Artifact's own path only) has
	// an explicitly non-canonical projected `path`, tracked here separately
	// from `graphTrustworthy` (which these findings deliberately do NOT flip).
	describe('path-trust loss tracking (Finding 6, seventh-round)', () => {
		it('is empty for a minimal valid project with no findings', async () => {
			await writeMinimalProject(tempDir)
			const result = await load()
			expect(result.pathTrustLossArtifactIds.size)
				.toBe(0)
		})

		it('tracks only the affected Artifact for an EF-ID-005 filename mismatch, without flipping graphTrustworthy', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002' }))
			await writeFile(tempDir, '.engineering/req/REQ-999.md', requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-005')
			expect([...result.pathTrustLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		it('tracks only the affected Artifact for an EF-ID-014 wrong-canonical-directory finding, without flipping graphTrustworthy', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002' }))
			// Basename matches its declared ID exactly; only the directory is
			// wrong (adr instead of req).
			await writeFile(tempDir, '.engineering/adr/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-014')
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-ID-005')
			expect([...result.pathTrustLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		it('also folds in an artifact-path EF-FS-006 (non-NFC-normalized discovered path)', async () => {
			await writeMinimalProject(tempDir)
			// A non-ASCII, NFD-decomposed filename cannot simultaneously equal
			// the (always-ASCII) expected `<id>.md` basename, so EF-ID-005 fires
			// alongside EF-FS-006 here -- there is no filesystem-realizable
			// Artifact path that is both non-NFC-normalized AND otherwise fully
			// canonical. This still confirms the EF-FS-006 signal is folded into
			// `pathTrustLossArtifactIds` for the Artifact it affects.
			const nfd = 'café'.normalize('NFD')
			await writeFile(tempDir, `.engineering/req/REQ-001-${nfd}.md`, requirementMd({ id: 'REQ-001' }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-006')
			expect(codesOf(result.diagnostics))
				.toContain('EF-ID-005')
			expect([...result.pathTrustLossArtifactIds])
				.toEqual(['REQ-001'])
		})
	})

	describe('relation graph integrity', () => {
		it('reports EF-REL-003 for a relation targeting a nonexistent Artifact', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: REQ-999\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-003')
		})

		it('does not report EF-REL-003 for a relation targeting a genuinely present Artifact', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({
				id: 'REQ-002',
				relations: '\n  - type: references\n    target: REQ-001\n',
			}))
			const result = await load()
			expect(result.diagnostics)
				.toEqual([])
			expect(result.incomingRelations.get('REQ-001'))
				.toEqual([{ from: 'REQ-002', type: 'references' }])
		})
	})

	describe('structured data loss tracking (Finding A/C: 10-query-and-trace.md "Invalid Graph and Partial Results")', () => {
		it('is empty for a minimal valid project with no findings', async () => {
			await writeMinimalProject(tempDir)
			const result = await load()
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})

		it('tracks edge loss (and projection loss) for a shape-invalid relation entry (EF-REL-002)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: PROJECT\n  - not-a-mapping\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-002')
			expect([...result.edgeLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('tracks edge loss (and projection loss) for an unknown relation type (EF-REL-001)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: not-a-known-type\n    target: PROJECT\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-001')
			expect([...result.edgeLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('tracks edge loss (and projection loss) for a self-relation (EF-REL-005)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: REQ-001\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-005')
			expect([...result.edgeLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('finding C: tracks an invalid extension field (EF-REL-015) as projection loss only, NEVER as edge loss -- a graph query\'s edges are (source, type, target), unaffected by lost extension metadata', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: PROJECT\n    foo: bar\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-015')
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect([...result.relationExtensionLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('tracks only the specific artifact with the discarded entry, not an unrelated artifact with clean relations', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: PROJECT\n  - not-a-mapping\n',
			}))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({
				id: 'REQ-002',
				relations: '\n  - type: references\n    target: PROJECT\n',
			}))
			const result = await load()
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('eF-REL-003 (dangling relation target) does not set edge/projection loss: a present-but-unresolvable target is a graph-integrity finding, not a sanitization discard', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: REQ-999\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-003')
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})

		it('finding A: tracks resource loss (and projection loss) for a scalar (non-mapping) Resource entry, entirely omitted from the decoded envelope', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: false\n    description: Notes.\n  - not-a-mapping\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-001')
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect([...result.resourceLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('finding A: tracks envelope-wide loss (and projection loss) for a duplicate core key (EF-ENV-005), where the parser silently keeps only one of the conflicting values', async () => {
			await writeMinimalProject(tempDir)
			// A second 'title:' key duplicates the frontmatter's core field;
			// `collectFields` (envelope.ts) keeps only the FIRST value (matching
			// `rawArrayField`'s own first-match selection -- fifth-round Finding
			// 5), discarding the second without any other trace of it in the
			// decoded envelope.
			const duplicateTitleMd = requirementMd({ id: 'REQ-001' })
				.replace('title: Example Requirement\n', 'title: Example Requirement\ntitle: Duplicated Title\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateTitleMd)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-005')
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect([...result.envelopeWideLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
			// 'title' is not a graph-relevant field (Finding 5): the graph facts
			// this Artifact contributes stay trustworthy even though its
			// projection does not.
			expect(result.envelopeStructuralLossArtifactIds.size)
				.toBe(0)
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		describe('finding 5 (duplicate-key trust-scope adjudication): EF-ENV-005 field classification', () => {
			it('a duplicate top-level \'id\' key excludes graph trust: the file\'s own declared identity is uncertain, same bucket as EF-ID-001/002/003', async () => {
				await writeMinimalProject(tempDir)
				const duplicateIdMd = requirementMd({ id: 'REQ-001' })
					.replace('id: REQ-001\n', 'id: REQ-001\nid: REQ-002\n')
				await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateIdMd)
				const result = await load()

				expect(codesOf(result.diagnostics))
					.toContain('EF-ENV-005')
				// `collectFields` keeps the FIRST 'id' value (REQ-001).
				expect([...result.envelopeStructuralLossArtifactIds])
					.toEqual(['REQ-001'])
				// Graph-fact-invalid, not merely projection loss: EVERY query kind
				// is blocked, mirroring EF-ID-001/002/003's precedent.
				expect(result.graphTrustworthy)
					.toBe(false)
			})

			it('a duplicate top-level \'type\' key excludes graph trust the same way as \'id\'', async () => {
				await writeMinimalProject(tempDir)
				const duplicateTypeMd = requirementMd({ id: 'REQ-001' })
					.replace('type: requirement\n', 'type: requirement\ntype: decision\n')
				await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateTypeMd)
				const result = await load()

				expect(codesOf(result.diagnostics))
					.toContain('EF-ENV-005')
				expect([...result.envelopeStructuralLossArtifactIds])
					.toEqual(['REQ-001'])
				expect(result.graphTrustworthy)
					.toBe(false)
			})

			it('a duplicate top-level \'relations\' key does NOT flip graphTrustworthy: it is scoped to edgeLossArtifactIds (this Artifact\'s own outgoing edge set only), not this file\'s identity', async () => {
				await writeMinimalProject(tempDir)
				// Two distinct 'relations:' arrays under the same key. `decodeEnvelope`
				// and `rawArrayField` both deterministically pick the FIRST occurrence
				// (fifth-round Finding 5's own fix), but the file itself remains
				// invalid regardless of which array wins -- its outgoing edge set is
				// genuinely unknown, not its own id/type identity, so this is folded
				// into `edgeLossArtifactIds` (gated direction-aware by the query
				// layer) instead of blocking every query project-wide.
				const duplicateRelationsMd = requirementMd({ id: 'REQ-001' })
					.replace(
						'relations: []\n',
						'relations:\n  - type: references\n    target: PROJECT\nrelations:\n  - type: references\n    target: PROJECT\n',
					)
				await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateRelationsMd)
				const result = await load()

				expect(codesOf(result.diagnostics))
					.toContain('EF-ENV-005')
				expect(result.envelopeStructuralLossArtifactIds.size)
					.toBe(0)
				expect([...result.edgeLossArtifactIds])
					.toEqual(['REQ-001'])
				// The file's own projection is still untrustworthy (envelope-wide
				// loss fires unconditionally for any EF-ENV-005), just not its
				// graph-membership identity.
				expect([...result.projectionLossArtifactIds])
					.toEqual(['REQ-001'])
				expect(result.graphTrustworthy)
					.toBe(true)
			})

			it('a duplicate top-level \'status\' key does NOT flip graphTrustworthy: it is scoped to statusInvalidArtifactIds (consumed only by impact/resolve-current), not this file\'s identity', async () => {
				await writeMinimalProject(tempDir)
				const duplicateStatusMd = requirementMd({ id: 'REQ-001' })
					.replace('status: active\n', 'status: active\nstatus: draft\n')
				await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateStatusMd)
				const result = await load()

				expect(codesOf(result.diagnostics))
					.toContain('EF-ENV-005')
				expect(result.envelopeStructuralLossArtifactIds.size)
					.toBe(0)
				expect([...result.statusInvalidArtifactIds])
					.toEqual(['REQ-001'])
				expect([...result.projectionLossArtifactIds])
					.toEqual(['REQ-001'])
				expect(result.graphTrustworthy)
					.toBe(true)
			})

			it('parser-recovery: the YAML library recovers a full, usable mapping from a duplicate-key document (EF-ENV-005 is an error, not a structural parse failure), but a duplicate on a non-identity field (\'summary\') must not invalidate graph facts at all', async () => {
				await writeMinimalProject(tempDir)
				// `uniqueKeys: true` makes the underlying YAML library record a
				// DUPLICATE_KEY error internally, yet it still recovers a usable
				// document (both pairs remain in the parsed mapping -- this
				// recovery is the entire reason the first/last inconsistency this
				// round's Finding 5 fixes was possible at all). Duplicating
				// 'summary' (read only by lookup/list/search projections, never by
				// graph construction) proves the recovered document does not
				// blanket-invalidate every graph-relevant fact.
				const duplicateSummaryMd = requirementMd({ id: 'REQ-001' })
					.replace(
						'summary: A minimal example requirement used for validation pipeline tests.\n',
						'summary: A minimal example requirement used for validation pipeline tests.\nsummary: Duplicated summary.\n',
					)
				await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateSummaryMd)
				const result = await load()

				expect(codesOf(result.diagnostics))
					.toContain('EF-ENV-005')
				expect(result.envelopeStructuralLossArtifactIds.size)
					.toBe(0)
				expect(result.edgeLossArtifactIds.size)
					.toBe(0)
				expect(result.statusInvalidArtifactIds.size)
					.toBe(0)
				expect([...result.envelopeWideLossArtifactIds])
					.toEqual(['REQ-001'])
				expect(result.graphTrustworthy)
					.toBe(true)
				expect(result.byId.has('REQ-001'))
					.toBe(true)
			})
		})

		it('tracks tag loss for a non-string tag entry, silently dropped from the decoded envelope (distinct from an invalid-pattern or duplicate tag, both of which are kept)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '[]',
			})
				.replace('tags: []', 'tags:\n  - alpha\n  - 123\n'))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-012')
			expect([...result.tagLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('does NOT track tag loss for a merely invalid-pattern tag: the string entry itself is kept, unlike a dropped non-string entry', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' })
				.replace('tags: []', 'tags:\n  - Not_Valid_Pattern\n'))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-012')
			expect(result.tagLossArtifactIds.size)
				.toBe(0)
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})
	})

	describe('finding 6: per-fact graph trust (semantic edge / status / cross-type supersession)', () => {
		function decisionMd(options: { id: string, status?: string, relations?: string }): string {
			const status = options.status ?? 'active'
			const relations = options.relations ?? '[]'
			return `---
schema: ef/decision@1
type: decision
id: ${options.id}
title: Title of ${options.id}
status: ${status}
summary: Summary of ${options.id}.
tags: []
relations: ${relations}
resources: []
---

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequence text.
`
		}

		function policyMd(options: { id: string, status?: string, relations?: string }): string {
			const status = options.status ?? 'active'
			const relations = options.relations ?? '[]'
			return `---
schema: ef/policy@1
type: policy
id: ${options.id}
title: Title of ${options.id}
status: ${status}
summary: Summary of ${options.id}.
tags: []
relations: ${relations}
resources: []
---

## Policy Statement

Statement text.

## Rationale

Rationale text.
`
		}

		it('incompatible-edge: EF-REL-004 (a decision cannot be a derived-from source) tracks the SOURCE Artifact in semanticEdgeLossArtifactIds, not edgeLossArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/adr/ADR-001.md', decisionMd({
				id: 'ADR-001',
				// 'derived-from' sources are restricted to prd/requirement/policy;
				// a decision source is incompatible.
				relations: '\n  - type: derived-from\n    target: REQ-001\n',
			}))
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-004')
			expect([...result.semanticEdgeLossArtifactIds])
				.toEqual(['ADR-001'])
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			// The edge is fully present and faithfully reflects the declared
			// (type, target) pair -- nothing is dropped or coerced -- so this is
			// a graph-TRUST fact, not a projection-loss fact.
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		it('derived-cycle: EF-REL-008 tracks every cycle participant in semanticEdgeLossArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/prd/PRD-100.md', `---
schema: ef/prd@1
type: prd
id: PRD-100
title: PRD One
status: active
summary: First half of a derived-from cycle.
tags: []
relations:
  - type: derived-from
    target: PRD-200
resources: []
---

## Vision

Vision text.

## Objectives

Objective text.
`)
			await writeFile(tempDir, '.engineering/prd/PRD-200.md', `---
schema: ef/prd@1
type: prd
id: PRD-200
title: PRD Two
status: active
summary: Second half of a derived-from cycle.
tags: []
relations:
  - type: derived-from
    target: PRD-100
resources: []
---

## Vision

Vision text.

## Objectives

Objective text.
`)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-008')
			expect([...result.semanticEdgeLossArtifactIds].sort())
				.toEqual(['PRD-100', 'PRD-200'])
			expect(result.edgeLossArtifactIds.size)
				.toBe(0)
			expect(result.graphTrustworthy)
				.toBe(true)
		})

		it('invalid-status: EF-LIFE-001 (unrecognized status) and EF-LIFE-002 (status not allowed for type) both track the Artifact in statusInvalidArtifactIds, without corrupting its raw projection', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'bogus-status' }))
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-LIFE-001')
			expect([...result.statusInvalidArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.byId.get('REQ-001')?.envelope.status)
				.toBe('bogus-status')
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})

		it('cross-type-supersession: EF-SUP-003 (a requirement superseded by a policy) tracks the SOURCE Artifact in supersessionCrossTypeArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: POL-001\n',
			}))
			await writeFile(tempDir, '.engineering/pol/POL-001.md', policyMd({ id: 'POL-001' }))
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-003')
			expect([...result.supersessionCrossTypeArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})
	})

	describe('finding 7: byte-decoding loss (invalid UTF-8)', () => {
		function corruptByteAtMarker(text: string, marker: string): Uint8Array {
			const bytes = new TextEncoder()
				.encode(text)
			const markerBytes = new TextEncoder()
				.encode(marker)
			const markerIndex = text.indexOf(marker)
			if (markerIndex === -1)
				throw new Error(`marker '${marker}' not found in fixture text`)
			// `text` is pure ASCII up to and including the marker in every fixture
			// below, so the Unicode-scalar index equals the byte offset.
			const corrupted = new Uint8Array(bytes)
			corrupted[markerIndex] = 0xFF // 0xFF is never a valid UTF-8 leading byte.
			void markerBytes
			return corrupted
		}

		it('invalid UTF-8 inside the frontmatter title tracks byteDecodingLossArtifactIds AND envelopeStructuralLossArtifactIds (identity/relations could be corrupted)', async () => {
			await writeMinimalProject(tempDir)
			const md = requirementMd({ id: 'REQ-001' })
				.replace('Example Requirement', 'MARKERTITLEXX')
			const corrupted = corruptByteAtMarker(md, 'MARKERTITLEXX')
			await writeFileBytes(tempDir, '.engineering/req/REQ-001.md', corrupted)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-005')
			expect([...result.byteDecodingLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.envelopeStructuralLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.graphTrustworthy)
				.toBe(false)
		})

		it('invalid UTF-8 confined to the Markdown body tracks byteDecodingLossArtifactIds (and projection loss) only -- graph facts stay trustworthy', async () => {
			await writeMinimalProject(tempDir)
			const md = requirementMd({ id: 'REQ-001', acceptanceCriteria: '- MARKERBODYXX behaves as specified.' })
			const corrupted = corruptByteAtMarker(md, 'MARKERBODYXX')
			await writeFileBytes(tempDir, '.engineering/req/REQ-001.md', corrupted)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-005')
			expect([...result.byteDecodingLossArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.envelopeStructuralLossArtifactIds.size)
				.toBe(0)
			expect(result.graphTrustworthy)
				.toBe(true)
			expect(result.byId.has('REQ-001'))
				.toBe(true)
		})
	})

	describe('finding 9: per-named-field Resource loss (resourceFieldLossById)', () => {
		it('an EF-RES-001 confined to \'normative\' only records \'normative\' (not \'location\'/\'description\') for that Artifact', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				// 'normative' is present but the wrong type (string, not boolean);
				// every other core Resource field is well-formed.
				resources: '\n  - type: reference\n    location: .engineering/resources/REQ-001/notes.md\n    role: reference\n    media_type: text/markdown\n    normative: "yes"\n    description: Notes.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/notes.md', '# Notes\n')
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-001')
			expect([...(result.resourceFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['normative'])
			expect([...result.resourceLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('an entirely non-mapping Resource entry records EVERY named field as lost', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - not-a-mapping\n',
			}))
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-001')
			expect([...(result.resourceFieldLossById.get('REQ-001') ?? [])].sort())
				.toEqual(['description', 'location', 'media_type', 'normative', 'role', 'type'])
		})
	})

	describe('finding 8 (eighth-round): per-core-field envelope loss (envelopeFieldLossById)', () => {
		it('a duplicate top-level \'title\' key records only \'title\'', async () => {
			await writeMinimalProject(tempDir)
			const duplicateTitleMd = requirementMd({ id: 'REQ-001' })
				.replace('title: Example Requirement\n', 'title: Example Requirement\ntitle: Duplicated Title\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateTitleMd)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-005')
			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['title'])
			// Still folded into the coarser, field-unscoped bucket for
			// `lookup`/a returned-page projection's own completeness gate.
			expect([...result.envelopeWideLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('a duplicate top-level \'schema\' key records only \'schema\'', async () => {
			await writeMinimalProject(tempDir)
			const duplicateSchemaMd = requirementMd({ id: 'REQ-001' })
				.replace('schema: ef/requirement@1\n', 'schema: ef/requirement@1\nschema: ef/requirement@1\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateSchemaMd)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-005')
			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['schema'])
		})

		it('a duplicate top-level \'summary\' key records only \'summary\'', async () => {
			await writeMinimalProject(tempDir)
			const duplicateSummaryMd = requirementMd({ id: 'REQ-001' })
				.replace(
					'summary: A minimal example requirement used for validation pipeline tests.\n',
					'summary: A minimal example requirement used for validation pipeline tests.\nsummary: Duplicated summary.\n',
				)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateSummaryMd)
			const result = await load()

			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['summary'])
		})

		it('a duplicate top-level \'tags\' key records \'tags\', distinct from a dropped non-string tag entry', async () => {
			await writeMinimalProject(tempDir)
			const duplicateTagsMd = requirementMd({ id: 'REQ-001' })
				.replace('tags: []\n', 'tags: []\ntags: []\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateTagsMd)
			const result = await load()

			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['tags'])
			// This is a whole-array duplicate key, not a dropped non-string
			// entry -- `tagLossArtifactIds` stays empty (its own, narrower
			// mechanism, `tagLossArtifactIds`'s doc).
			expect(result.tagLossArtifactIds.size)
				.toBe(0)
		})

		it('a duplicate top-level \'resources\' key records \'resources\'', async () => {
			await writeMinimalProject(tempDir)
			const duplicateResourcesMd = requirementMd({ id: 'REQ-001' })
				.replace('resources: []\n', 'resources: []\nresources: []\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateResourcesMd)
			const result = await load()

			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['resources'])
		})

		it('a duplicate key nested within one relations[i] entry is attributed to the enclosing \'relations\' field', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: PROJECT\n    type: references\n',
			}))
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-005')
			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])])
				.toEqual(['relations'])
		})

		it('an EF-ENV-006 unknown top-level field is NOT recorded here (it never corrupts a core field), even though it still sets envelopeWideLossArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			const unknownFieldMd = requirementMd({ id: 'REQ-001' })
				.replace('tags: []\n', 'tags: []\nunknown_field: some value\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', unknownFieldMd)
			const result = await load()

			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-006')
			expect(result.envelopeFieldLossById.has('REQ-001'))
				.toBe(false)
			expect([...result.envelopeWideLossArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('two distinct duplicate keys on the same file record both fields', async () => {
			await writeMinimalProject(tempDir)
			const duplicateTitleAndTagsMd = requirementMd({ id: 'REQ-001' })
				.replace('title: Example Requirement\n', 'title: Example Requirement\ntitle: Duplicated Title\n')
				.replace('tags: []\n', 'tags: []\ntags: []\n')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateTitleAndTagsMd)
			const result = await load()

			expect([...(result.envelopeFieldLossById.get('REQ-001') ?? [])].sort())
				.toEqual(['tags', 'title'])
		})
	})

	describe('supersession graph integrity', () => {
		it('reports EF-SUP-005 for a two-node supersession cycle', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: REQ-002\n',
			}))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({
				id: 'REQ-002',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: REQ-001\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-005')
		})
	})

	describe('sixth-round Finding 6: supersessionFactInvalidArtifactIds (per-artifact supersession-fact validity)', () => {
		it('eF-SUP-001 (superseded with no direct replacement) tracks the Artifact in supersessionFactInvalidArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'superseded',
				relations: '[]',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-001')
			expect([...result.supersessionFactInvalidArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.projectionLossArtifactIds.size)
				.toBe(0)
		})

		it('eF-SUP-002 (non-superseded Artifact illegally declares superseded-by) tracks the Artifact in supersessionFactInvalidArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002' }))
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'active',
				relations: '\n  - type: superseded-by\n    target: REQ-002\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-002')
			expect([...result.supersessionFactInvalidArtifactIds])
				.toEqual(['REQ-001'])
		})

		it('eF-SUP-005 (supersession cycle) tracks EVERY cycle participant in supersessionFactInvalidArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: REQ-002\n',
			}))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({
				id: 'REQ-002',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: REQ-001\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-005')
			expect([...result.supersessionFactInvalidArtifactIds].sort())
				.toEqual(['REQ-001', 'REQ-002'])
		})

		it('eF-SUP-003 (cross-type replacement) ALSO tracks the SOURCE Artifact in the broader supersessionFactInvalidArtifactIds, alongside the existing narrower supersessionCrossTypeArtifactIds', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/pol/POL-001.md', `---
schema: ef/policy@1
type: policy
id: POL-001
title: Policy One
status: active
summary: An active policy used as an illegal cross-type replacement target.
tags: []
relations: []
resources: []
---

## Policy Statement

Statement text.

## Rationale

Rationale text.
`)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'superseded',
				relations: '\n  - type: superseded-by\n    target: POL-001\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-SUP-003')
			expect([...result.supersessionCrossTypeArtifactIds])
				.toEqual(['REQ-001'])
			expect([...result.supersessionFactInvalidArtifactIds])
				.toEqual(['REQ-001'])
		})
	})

	describe('sixth-round Finding 7/9: EF-REL-006 (duplicate relation) edge-trust tracking', () => {
		it('eF-REL-006 (duplicate relation entry) tracks the Artifact in edgeLossArtifactIds, typed to the duplicated relation type, without corrupting its raw projection', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: derived-from\n    target: PROJECT\n  - type: derived-from\n    target: PROJECT\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-006')
			expect([...result.edgeLossArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.edgeLossUntypedArtifactIds.size)
				.toBe(0)
			expect([...(result.edgeLossRelationTypesBySourceId.get('REQ-001') ?? [])])
				.toEqual(['derived-from'])
			// Folded into `projectionLossArtifactIds` too, consistent with every
			// other `edgeLossArtifactIds` cause (`EF-REL-001`/`002`/`005`
			// already do the same, per this file's earlier tests).
			expect([...result.projectionLossArtifactIds])
				.toEqual(['REQ-001'])
		})
	})

	describe('sixth-round Finding 9: per-source, per-type edge-loss attribution', () => {
		it('eF-REL-001 (unknown relation type) is always untyped (edgeLossUntypedArtifactIds), never attributed a specific RelationType', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: not-a-known-type\n    target: PROJECT\n',
			}))
			const result = await load()
			expect([...result.edgeLossUntypedArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.edgeLossRelationTypesBySourceId.has('REQ-001'))
				.toBe(false)
		})

		it('eF-REL-002 (shape-invalid entry) is always untyped (edgeLossUntypedArtifactIds), never attributed a specific RelationType', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - not-a-mapping\n',
			}))
			const result = await load()
			expect([...result.edgeLossUntypedArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.edgeLossRelationTypesBySourceId.has('REQ-001'))
				.toBe(false)
		})

		it('eF-REL-005 (self-relation) is typed to the exact relation type declared, not untyped', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				relations: '\n  - type: references\n    target: REQ-001\n',
			}))
			const result = await load()
			expect(result.edgeLossUntypedArtifactIds.size)
				.toBe(0)
			expect([...(result.edgeLossRelationTypesBySourceId.get('REQ-001') ?? [])])
				.toEqual(['references'])
		})

		it('a duplicate top-level \'relations\' key (EF-ENV-005) is always untyped: no single entry index identifies which type is uncertain', async () => {
			await writeMinimalProject(tempDir)
			const duplicateRelationsMd = requirementMd({ id: 'REQ-001' })
				.replace(
					'relations: []\n',
					'relations:\n  - type: references\n    target: PROJECT\nrelations:\n  - type: references\n    target: PROJECT\n',
				)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', duplicateRelationsMd)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-ENV-005')
			expect([...result.edgeLossUntypedArtifactIds])
				.toEqual(['REQ-001'])
			expect(result.edgeLossRelationTypesBySourceId.has('REQ-001'))
				.toBe(false)
		})

		it('eF-REL-004 (semantic incompatibility) records the specific relation type in semanticEdgeLossRelationTypesBySourceId', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
			await writeFile(tempDir, '.engineering/adr/ADR-001.md', `---
schema: ef/decision@1
type: decision
id: ADR-001
title: Decision One
status: active
summary: A decision, whose 'derived-from' source type is incompatible.
tags: []
relations:
  - type: derived-from
    target: REQ-001
resources: []
---

## Context

Context text.

## Decision

Decision text.

## Consequences

Consequences text.
`)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-004')
			expect([...(result.semanticEdgeLossRelationTypesBySourceId.get('ADR-001') ?? [])])
				.toEqual(['derived-from'])
		})

		it('eF-REL-008 (derived-from cycle) records \'derived-from\' in semanticEdgeLossRelationTypesBySourceId for every cycle participant', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/prd/PRD-100.md', `---
schema: ef/prd@1
type: prd
id: PRD-100
title: PRD One
status: active
summary: First half of a derived-from cycle.
tags: []
relations:
  - type: derived-from
    target: PRD-200
resources: []
---

## Vision

Vision text.

## Objectives

Objective text.
`)
			await writeFile(tempDir, '.engineering/prd/PRD-200.md', `---
schema: ef/prd@1
type: prd
id: PRD-200
title: PRD Two
status: active
summary: Second half of a derived-from cycle.
tags: []
relations:
  - type: derived-from
    target: PRD-100
resources: []
---

## Vision

Vision text.

## Objectives

Objective text.
`)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-REL-008')
			expect([...(result.semanticEdgeLossRelationTypesBySourceId.get('PRD-100') ?? [])])
				.toEqual(['derived-from'])
			expect([...(result.semanticEdgeLossRelationTypesBySourceId.get('PRD-200') ?? [])])
				.toEqual(['derived-from'])
		})
	})

	describe('resource integrity', () => {
		it('reports EF-RES-006 for a declared local Resource file that does not exist', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-006')
		})

		it('accepts a declared local Resource whose file genuinely exists', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/schema.json', '{}\n')
			const result = await load()
			expect(result.diagnostics)
				.toEqual([])
			expect(result.resourceOwnership.get('.engineering/resources/REQ-001/schema.json'))
				.toEqual(['REQ-001'])
		})

		it('reports EF-RES-015 for an unowned file inside the managed Resource root', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/resources/REQ-001/orphan.json', '{}\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-015')
		})

		it('reports EF-RES-006 with a "not a regular file" message for a declared local Resource location that is a directory', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			await fs.mkdir(path.join(tempDir, '.engineering/resources/REQ-001/schema.json'), { recursive: true })
			const result = await load()
			const resDiagnostics = result.diagnostics.filter(d => d.code === 'EF-RES-006')
			expect(resDiagnostics)
				.toHaveLength(1)
			expect(resDiagnostics[0]!.message)
				.toContain('is not a regular file (directory)')
		})

		it('skips a resource descriptor with an empty location (missing \'location\' field) from ownership and file-existence checks', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-001')
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-RES-006')
			expect(result.resourceOwnership.size)
				.toBe(0)
		})

		it('does not report EF-RES-009 when two different Artifacts reference the same external HTTPS URL (06-resources.md: external URLs have no exclusive ownership)', async () => {
			await writeMinimalProject(tempDir)
			const sharedUrlResource = '\n  - type: reference\n    location: https://example.com/shared-spec\n    role: reference\n    media_type: text/html\n    normative: false\n    description: A shared external reference.\n'
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', resources: sharedUrlResource }))
			await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({ id: 'REQ-002', resources: sharedUrlResource }))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-RES-009')
			expect(result.resourceOwnership.get('https://example.com/shared-spec'))
				.toBeUndefined()
		})

		it('deduplicates resourceOwnership when the same Artifact declares two Resource descriptors at the same location', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n  - type: reference\n    location: .engineering/resources/REQ-001/schema.json\n    role: reference\n    media_type: application/json\n    normative: false\n    description: Same file again.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/schema.json', '{}\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-RES-008')
			expect(result.resourceOwnership.get('.engineering/resources/REQ-001/schema.json'))
				.toEqual(['REQ-001'])
		})
	})

	describe('path normalization (11-filesystem-and-config.md "exact filesystem case")', () => {
		it('reports EF-FS-006 for a declared local Resource whose case does not exactly match the walked filesystem entry', async () => {
			await writeMinimalProject(tempDir)
			// The real file on disk is 'foo.json' (lowercase); the descriptor
			// declares a different-case location. Only one real file ever
			// exists at this exact path -- no OS case-folding is involved in
			// creating it -- so this is deterministic on any host filesystem.
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/Foo.JSON\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/foo.json', '{}\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-006')
			const caseFinding = result.diagnostics.find(d => d.code === 'EF-FS-006')
			expect(caseFinding?.message)
				.toContain('foo.json')
		})

		it('does not report EF-FS-006 when the declared local Resource location exactly matches the walked filesystem entry', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/schema.json', '{}\n')
			const result = await load()
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-FS-006')
		})

		// Finding B: on a case-sensitive filesystem, `snapshot.entryKinds` can
		// legitimately contain both `Foo.json` and `foo.json` as distinct
		// discovered entries. A descriptor that exactly names one of them must
		// resolve against that exact entry first, rather than against whichever
		// spelling a case-folded lookup happened to keep.

		it('prefers an exact location match over an arbitrarily discovered case-fold candidate (portable: fabricated entryKinds, independent of host filesystem case sensitivity)', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/foo.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: The lower-case spelling, named exactly.\n',
			}))
			await writeFile(tempDir, '.engineering/resources/REQ-001/foo.json', '{}\n')

			const loaded = await loadSnapshotFromWorkingTree(tempDir)
			if (!loaded.ok)
				throw new Error(`failed to load snapshot: ${loaded.message}`)

			// Simulate a walk that discovered an unrelated 'Foo.json' entry
			// BEFORE the real, exactly-matching 'foo.json' entry -- Map
			// insertion order is what a naive "keep only the first-seen
			// case-folded spelling" implementation depends on, so inserting the
			// wrong-case entry first reproduces the exact ordering the prior
			// (buggy) implementation silently relied on.
			const entryKinds = new Map<string, SnapshotEntryKind>([
				['.engineering/resources/REQ-001/Foo.json', 'file'],
				...loaded.snapshot.entryKinds,
			])
			const snapshot: ProjectSnapshot = { ...loaded.snapshot, entryKinds }

			const result = validateSnapshot(snapshot)
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-FS-006')
		})

		it('does not report EF-FS-006 for either of two case-distinct files when each descriptor exactly names its own file (case-sensitive filesystem only)', async (ctx) => {
			await writeMinimalProject(tempDir)
			const dir = path.join(tempDir, '.engineering/resources/REQ-001')
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, 'Foo.json'), '{"case":"upper"}\n')
			await fs.writeFile(path.join(dir, 'foo.json'), '{"case":"lower"}\n')

			// This regression is only meaningful on a filesystem that keeps
			// 'Foo.json' and 'foo.json' as two distinct directory entries; skip
			// on a case-insensitive (but case-preserving) filesystem -- e.g. the
			// macOS default -- where the second write silently overwrote the
			// first and this fixture cannot be created faithfully.
			const entries = await fs.readdir(dir)
			const bothDistinctEntriesExist = entries.filter(name => name.toLowerCase() === 'foo.json').length === 2
			if (!bothDistinctEntriesExist) {
				ctx.skip()
				return
			}

			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/Foo.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: The upper-case spelling, named exactly.\n  - type: json-schema\n    location: .engineering/resources/REQ-001/foo.json\n    role: reference\n    media_type: application/json\n    normative: false\n    description: The lower-case spelling, named exactly.\n',
			}))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.not.toContain('EF-FS-006')
		})
	})

	describe('symlink policy', () => {
		it('reports EF-FS-004 for a declared local Resource file that is a symlink', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				resources: '\n  - type: json-schema\n    location: .engineering/resources/REQ-001/schema.json\n    role: contract\n    media_type: application/json\n    normative: true\n    description: A schema.\n',
			}))
			await fs.mkdir(path.join(tempDir, '.engineering/resources/REQ-001'), { recursive: true })
			await fs.symlink(path.join(tempDir, '.engineering/PROJECT.md'), path.join(tempDir, '.engineering/resources/REQ-001/schema.json'))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-004')
		})
	})

	describe('text normalization', () => {
		it('reports EF-FS-005 for a CRLF line ending in an Artifact file', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' })
				.replace(/\n/g, '\r\n'))
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-FS-005')
		})
	})

	describe('body schema phase', () => {
		it('reports EF-BODY-001 for an active REQ missing a required heading', async () => {
			await writeMinimalProject(tempDir)
			const broken = `---
schema: ef/requirement@1
type: requirement
id: REQ-001
title: Example Requirement
status: active
summary: A requirement missing its Rationale heading.
tags: []
relations: []
resources: []
---

## Requirement

The system must behave as specified.

## Acceptance Criteria

- The system behaves as specified.
`
			await writeFile(tempDir, '.engineering/req/REQ-001.md', broken)
			const result = await load()
			expect(codesOf(result.diagnostics))
				.toContain('EF-BODY-001')
		})

		it('reports EF-VAL-004 for a draft REQ with incomplete Acceptance Criteria, without EF-BODY-005', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'draft',
				acceptanceCriteria: '_TBD_',
			}))
			const result = await load()
			const reqDiagnostics = result.diagnostics.filter(d => d.artifactId === 'REQ-001' || d.path === '.engineering/req/REQ-001.md')
			expect(codesOf(reqDiagnostics))
				.toEqual(['EF-VAL-004'])
			expect(reqDiagnostics[0]!.severity)
				.toBe('info')
		})

		it('does not report EF-VAL-004 for a genuinely complete draft REQ', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001', status: 'draft' }))
			const result = await load()
			expect(result.diagnostics)
				.toEqual([])
		})

		it('reports EF-BODY-007 for meaningful content before the first H2 section, without a spurious EF-VAL-004', async () => {
			await writeMinimalProject(tempDir)
			const draftWithLeadingContent = requirementMd({ id: 'REQ-001', status: 'draft' })
				.replace('## Requirement', 'Stray content before any heading.\n\n## Requirement')
			await writeFile(tempDir, '.engineering/req/REQ-001.md', draftWithLeadingContent)
			const result = await load()
			const reqDiagnostics = result.diagnostics.filter(d => d.path === '.engineering/req/REQ-001.md')
			expect(codesOf(reqDiagnostics))
				.toEqual(['EF-BODY-007'])
		})
	})

	describe('body parse failure (EF-BODY-015)', () => {
		it('suppresses body-schema validation and reports only EF-BODY-015 when the body cannot be parsed as Markdown', () => {
			const text = PROJECT_MD
			const filePath = '.engineering/PROJECT.md'
			const split = splitFrontmatter(text)
			if (!split.ok)
				throw new Error('unreachable: fixture frontmatter must split cleanly')
			const document = parseFrontmatterDocument(split.frontmatterText, filePath, { startLine: 2 })
			const envelope = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, filePath)
			const brokenBody = parseBody(null as unknown as string, 0)
			if (brokenBody.ok)
				throw new Error('unreachable: forced-null body must fail to parse')

			const artifact: SnapshotArtifactFile = {
				path: filePath,
				bytes: new TextEncoder()
					.encode(text),
				text,
				frontmatter: split,
				document,
				envelope,
				body: brokenBody,
				sections: undefined,
			}
			const snapshot: ProjectSnapshot = {
				source: { kind: 'working-tree', projectRoot: '/fake' },
				configBytes: undefined,
				config: { config: null, diagnostics: [] },
				gitignoreBytes: undefined,
				artifacts: [artifact],
				resourceFiles: [],
				entryKinds: new Map(),
				layoutDiagnostics: [],
			}

			const result = validateSnapshot(snapshot)
			const projectDiagnostics = result.diagnostics.filter(d => d.path === filePath)
			expect(codesOf(projectDiagnostics))
				.toEqual(['EF-BODY-015'])
			expect(result.byId.has('PROJECT'))
				.toBe(true)
		})
	})

	describe('cHG effects index', () => {
		it('collects introduces/modifies/retires edges from a completed CHG', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'active',
			}))
			const chg = `---
schema: ef/change@1
type: change
id: CHG-001
title: Example Change
status: completed
summary: A minimal completed change introducing REQ-001.
tags: []
relations:
  - type: modifies
    target: REQ-001
resources: []
---

## Rationale

This change exists to keep the example fixture meaningful.

## Sources

- Example source material.

## Changes

- Modified REQ-001 to reflect the current example.

## Verification

Result: passed

- Confirmed the example fixture is internally consistent.
`
			await writeFile(tempDir, '.engineering/chg/CHG-001.md', chg)
			const result = await load()
			expect(result.chgEffects)
				.toEqual([{ chgId: 'CHG-001', type: 'modifies', target: 'REQ-001' }])
		})

		it('excludes a non-effect relation (e.g. references) from a completed CHG, even alongside an effect relation', async () => {
			await writeMinimalProject(tempDir)
			await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({
				id: 'REQ-001',
				status: 'active',
			}))
			const chg = `---
schema: ef/change@1
type: change
id: CHG-001
title: Example Change
status: completed
summary: A minimal completed change with a mixed relation set.
tags: []
relations:
  - type: modifies
    target: REQ-001
  - type: references
    target: REQ-001
resources: []
---

## Rationale

This change exists to keep the example fixture meaningful.

## Sources

- Example source material.

## Changes

- Modified REQ-001 to reflect the current example.

## Verification

Result: passed

- Confirmed the example fixture is internally consistent.
`
			await writeFile(tempDir, '.engineering/chg/CHG-001.md', chg)
			const result = await load()
			expect(result.chgEffects)
				.toEqual([{ chgId: 'CHG-001', type: 'modifies', target: 'REQ-001' }])
		})
	})
})

describe('validateSnapshot: loadSnapshotFromCommit equivalence', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-validate-git-')))
		execFileSync('git', ['init', '-q', '-b', 'main', tempDir])
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('produces the same validation result from a committed tree as from the working tree', async () => {
		await writeMinimalProject(tempDir)
		await writeFile(tempDir, '.engineering/req/REQ-001.md', requirementMd({ id: 'REQ-001' }))
		await writeFile(tempDir, '.engineering/req/REQ-002.md', requirementMd({
			id: 'REQ-002',
			relations: '\n  - type: references\n    target: REQ-001\n',
		}))
		const commitOid = commitAll(tempDir, 'initial')

		const workingTreeResult = await loadSnapshotFromWorkingTree(tempDir)
		expect(workingTreeResult.ok)
			.toBe(true)

		const executor = createGitExecutor()
		const repo = createGitRepository(tempDir, executor)
		const commitResult = await loadSnapshotFromCommit(repo, commitOid)
		expect(commitResult.ok)
			.toBe(true)
		if (!workingTreeResult.ok || !commitResult.ok)
			return

		const fromWorkingTree = validateSnapshot(workingTreeResult.snapshot)
		const fromCommit = validateSnapshot(commitResult.snapshot)

		expect(fromCommit.diagnostics)
			.toEqual(fromWorkingTree.diagnostics)
		expect([...fromCommit.byId.keys()].sort())
			.toEqual([...fromWorkingTree.byId.keys()].sort())
		expect(fromCommit.complete)
			.toBe(fromWorkingTree.complete)
	})
})

describe('summarizeValidation', () => {
	function diag(severity: 'error' | 'warning' | 'info'): { code: string, severity: 'error' | 'warning' | 'info', message: string, related: never[] } {
		return { code: `EF-TEST-${severity}`, severity, message: 'x', related: [] }
	}

	it('is valid with exit 0 for a successful default snapshot (warnings and info do not fail)', () => {
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [diag('warning'), diag('warning'), diag('info')],
			complete: true,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(summary.valid)
			.toBe(true)
		expect(summary.exitCode)
			.toBe(0)
		expect(summary.counts)
			.toEqual({ error: 0, warning: 1, info: 1 })
	})

	it('is invalid with exit 1 under warnings-as-errors, retaining warning severity in counts', () => {
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [diag('warning'), diag('warning'), diag('info')],
			complete: true,
			policy: { strict: false, warningsAsErrors: true },
		})
		expect(summary.valid)
			.toBe(false)
		expect(summary.exitCode)
			.toBe(1)
		expect(summary.counts.warning)
			.toBe(1)
	})

	it('is invalid with exit 1 when an error is present under default policy', () => {
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [diag('error')],
			complete: true,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(summary.valid)
			.toBe(false)
		expect(summary.exitCode)
			.toBe(1)
	})

	it('is incomplete with exit 2 and valid: false regardless of diagnostics', () => {
		const summary = summarizeValidation({
			scope: 'transition',
			diagnostics: [],
			complete: false,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(summary.valid)
			.toBe(false)
		expect(summary.complete)
			.toBe(false)
		expect(summary.exitCode)
			.toBe(2)
	})

	it('is an internal failure with exit 3, taking priority over completeness and findings', () => {
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [diag('error')],
			complete: true,
			internalFailure: true,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(summary.valid)
			.toBe(false)
		expect(summary.complete)
			.toBe(false)
		expect(summary.exitCode)
			.toBe(3)
	})

	it('strict mode implies warnings-as-errors even when only strict is set', () => {
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [diag('warning')],
			complete: true,
			policy: { strict: true, warningsAsErrors: false },
		})
		expect(summary.strict)
			.toBe(true)
		expect(summary.warningsAsErrors)
			.toBe(true)
		expect(summary.valid)
			.toBe(false)
		expect(summary.exitCode)
			.toBe(1)
	})

	it('deduplicates diagnostics before counting', () => {
		const duplicate = diag('error')
		const summary = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [duplicate, { ...duplicate }],
			complete: true,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(summary.counts.error)
			.toBe(1)
	})

	it('reports null refs by default and echoes supplied refs', () => {
		const summary = summarizeValidation({
			scope: 'transition',
			diagnostics: [],
			complete: true,
			policy: { strict: true, warningsAsErrors: true },
			refs: { baselineOid: 'a'.repeat(40), proposedOid: 'b'.repeat(40), integrationRef: 'refs/heads/main', expectedRefOid: 'a'.repeat(40) },
		})
		expect(summary.baselineOid)
			.toBe('a'.repeat(40))
		expect(summary.proposedOid)
			.toBe('b'.repeat(40))
		expect(summary.integrationRef)
			.toBe('refs/heads/main')
		expect(summary.expectedRefOid)
			.toBe('a'.repeat(40))

		const withoutRefs = summarizeValidation({
			scope: 'snapshot',
			diagnostics: [],
			complete: true,
			policy: { strict: false, warningsAsErrors: false },
		})
		expect(withoutRefs.baselineOid)
			.toBeNull()
		expect(withoutRefs.proposedOid)
			.toBeNull()
		expect(withoutRefs.integrationRef)
			.toBeNull()
		expect(withoutRefs.expectedRefOid)
			.toBeNull()
	})
})
