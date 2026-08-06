import type { ProjectSnapshot, SnapshotArtifactFile } from './snapshot'
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
