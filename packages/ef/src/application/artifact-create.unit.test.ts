import type { ArtifactType, Envelope } from '../domain/model'
import type { FileIdentity } from '../platform/fs-facts'
import type { ArtifactCreatePlan } from './artifact-create'
import type { ProjectSnapshot, SnapshotArtifactFile } from './snapshot'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_BY_TYPE } from '../domain/model'
import { directoryIdentity as realDirectoryIdentity } from '../platform/fs-facts'
import {
	applyCreatePlan,
	computeCreatePlan,
	defaultApplyCreatePlanDeps,
} from './artifact-create'
import { defaultSnapshotFsDeps, loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

/** Opaque, arbitrary identity for the pure `computeCreatePlan` tests below: no filesystem is touched in that describe block, so this value is never compared against anything real -- it merely proves the field is threaded onto the resulting plan unchanged. */
const FAKE_ENGINEERING_IDENTITY: FileIdentity = { dev: 1, ino: 1 }

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
summary: A minimal example project used for artifact-create tests.
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
|---|---|---|
`

function emptySnapshot(): ProjectSnapshot {
	return {
		source: { kind: 'working-tree', projectRoot: '/fake' },
		configBytes: undefined,
		config: { config: null, diagnostics: [] },
		gitignoreBytes: undefined,
		artifacts: [],
		resourceFiles: [],
		entryKinds: new Map(),
		layoutDiagnostics: [],
	}
}

/** A well-formed, fully decoded artifact file declaring `rawId` at `path` (defaults to the canonical REQ path for `rawId`). */
function fakeArtifactWithRawId(rawId: string, path: string = `.engineering/req/${rawId}.md`): SnapshotArtifactFile {
	const envelope: Envelope = {
		schema: SCHEMA_BY_TYPE.requirement,
		type: 'requirement',
		id: rawId,
		title: 'Fake existing artifact',
		status: 'draft',
		summary: 'Used only to seed the visible-ID set for allocation tests.',
		tags: [],
		relations: [],
		resources: [],
		extensions: {},
	}
	return {
		path,
		bytes: new Uint8Array(),
		text: '',
		frontmatter: { ok: true, frontmatterText: '', bodyText: '', bodyStartLine: 2 },
		document: undefined,
		envelope: { envelope, diagnostics: [] },
		body: undefined,
		sections: undefined,
	}
}

function fakeArtifactWithId(id: string): SnapshotArtifactFile {
	return fakeArtifactWithRawId(id)
}

/** A well-formed, fully decoded artifact file of an arbitrary (non-requirement) `type`, declaring `id` at `path`. Its identity is exactly known -- it decodes to completion with a syntactically valid ID -- so it is safely ignorable by an allocator for any OTHER prefix. */
function fakeDecodedArtifactOfType(type: Exclude<ArtifactType, 'project'>, id: string, path: string): SnapshotArtifactFile {
	const envelope: Envelope = {
		schema: SCHEMA_BY_TYPE[type],
		type,
		id,
		title: 'Fake existing artifact of a different, known type',
		status: 'draft',
		summary: 'Used to prove a known, non-matching-prefix envelope does not block allocation.',
		tags: [],
		relations: [],
		resources: [],
		extensions: {},
	}
	return {
		path,
		bytes: new Uint8Array(),
		text: '',
		frontmatter: { ok: true, frontmatterText: '', bodyText: '', bodyStartLine: 2 },
		document: undefined,
		envelope: { envelope, diagnostics: [] },
		body: undefined,
		sections: undefined,
	}
}

/** An artifact file whose frontmatter/envelope never decoded (`envelope` stays `undefined`), as `snapshot.ts` produces for a file that fails the frontmatter split. `path` defaults to the canonical REQ path for `id`. */
function fakeArtifactWithUndecodedEnvelope(id: string, path: string = `.engineering/req/${id}.md`): SnapshotArtifactFile {
	return {
		path,
		bytes: new Uint8Array(),
		text: '',
		frontmatter: { ok: false, diagnostic: { code: 'EF-ENV-001', severity: 'error', message: 'Frontmatter is missing.', location: { line: 1, column: 1 }, related: [] } },
		document: undefined,
		envelope: undefined,
		body: undefined,
		sections: undefined,
	}
}

/**
 * An artifact file whose envelope decoded to completion but whose top-level
 * `id` key was duplicated in the frontmatter (`EF-ENV-005`, `field: 'id'`):
 * the decoded `envelope.id` reflects only the FIRST occurrence, so the
 * file's true declared identity is ambiguous.
 */
function fakeArtifactWithDuplicateIdKey(rawId: string, path: string = `.engineering/req/${rawId}.md`): SnapshotArtifactFile {
	const base = fakeArtifactWithRawId(rawId, path)
	return {
		...base,
		document: {
			document: {} as never,
			mapping: undefined,
			diagnostics: [{ code: 'EF-ENV-005', severity: 'error', message: 'Duplicate mapping key \'id\'.', field: 'id', related: [] }],
			locate: () => undefined,
		},
	}
}

describe('computeCreatePlan', () => {
	it('rejects the "project" type token', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'project', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('invalid-type')
	})

	it('rejects an unknown type token', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'bogus', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('invalid-type')
	})

	it('rejects a blank title', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'req', title: '   ', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('missing-value')
	})

	it('rejects a blank summary', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'req', title: 'Title', summary: '   ', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('missing-value')
	})

	it('allocates REQ-001 for an empty graph', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.plan.id)
			.toBe('REQ-001')
		expect(result.plan.path)
			.toBe('.engineering/req/REQ-001.md')
	})

	it('allocates the next ID without filling numeric gaps', () => {
		const snapshot = emptySnapshot()
		snapshot.artifacts.push(fakeArtifactWithId('REQ-041'), fakeArtifactWithId('REQ-042'), fakeArtifactWithId('REQ-044'))
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.plan.id)
			.toBe('REQ-045')
	})

	// FINDING 3 (P1): the allocator contract requires inspecting every
	// visible Artifact for the requested prefix before selecting a candidate
	// (02-identity.md Allocation). An identity-uncertain file's true numeric
	// component is not actually known, so silently skipping it and issuing an
	// ID anyway could reuse or fall behind a hidden higher reservation.
	// Allocation must instead refuse (typed-incomplete) rather than guess.
	describe('identity-uncertain envelopes block allocation instead of being silently skipped (Finding 3)', () => {
		it('refuses (rather than silently skipping) when a canonical-directory artifact never decoded its envelope', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithUndecodedEnvelope('REQ-999'), fakeArtifactWithId('REQ-005'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
			expect(result.ok === false && result.message)
				.toContain('.engineering/req/REQ-999.md')
		})

		it('refuses REQ allocation for a canonical REQ-999.md with malformed frontmatter even though REQ-001 decodes validly (would otherwise wrongly yield REQ-002)', () => {
			// The exact reproduction from the review finding.
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithUndecodedEnvelope('REQ-999'), fakeArtifactWithId('REQ-001'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
		})

		it('refuses allocation when a canonical-directory envelope decoded but its ID does not parse (EF-ID-001 class)', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithRawId('not-an-id', '.engineering/req/not-an-id.md'), fakeArtifactWithId('REQ-001'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
		})

		it('refuses allocation when a canonical-directory envelope decoded but its numeric component is not canonical (EF-ID-003 class)', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithRawId('REQ-0007', '.engineering/req/REQ-0007.md'), fakeArtifactWithId('REQ-001'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
		})

		it('refuses allocation when a canonical-directory file lost its declared id to a duplicate frontmatter key (EF-ENV-005 on `id`)', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithDuplicateIdKey('REQ-005'), fakeArtifactWithId('REQ-001'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
		})

		// FINDING 4 (P1): a file's directory placement alone can never prove its
		// declared type or ID. `.engineering/adr/junk.md` never decoded at all,
		// so its true identity is unknown -- it might, once decoded, actually
		// have declared `id: REQ-999` in a wrong-directory placement. Scoping the
		// uncertainty scan to the requested prefix's OWN canonical directory
		// (the prior, buggy behavior) would let `req` allocation proceed as if
		// this file did not exist, blind to a possible higher REQ reservation.
		it('blocks REQ allocation when a wrong-directory identity-uncertain file sits under a DIFFERENT type\'s canonical directory (full discovery scope)', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithUndecodedEnvelope('junk', '.engineering/adr/junk.md'), fakeArtifactWithId('REQ-005'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(false)
			expect(result.ok === false && result.reason)
				.toBe('allocation-incomplete')
			expect(result.ok === false && result.message)
				.toContain('.engineering/adr/junk.md')
		})

		// The other half of Finding 4's directive: a file whose envelope DID
		// decode to completion, declaring a KNOWN, different type, remains
		// safely ignorable regardless of its directory -- its true prefix is
		// exactly known and does not match, so it cannot be hiding a higher REQ
		// reservation.
		it('does not block REQ allocation on a fully decoded, identity-certain artifact of a different, known type', () => {
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeDecodedArtifactOfType('decision', 'ADR-999', '.engineering/adr/ADR-999.md'), fakeArtifactWithId('REQ-005'))
			const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
			expect(result.ok)
				.toBe(true)
			if (!result.ok)
				return
			expect(result.plan.id)
				.toBe('REQ-006')
		})
	})

	it('rejects a multi-line title', () => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'req', title: 'Line one\nLine two', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('missing-value')
	})

	it('allocates REQ-1000 after REQ-999 (no leading zeroes above 999)', () => {
		const snapshot = emptySnapshot()
		snapshot.artifacts.push(fakeArtifactWithId('REQ-999'))
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return
		expect(result.plan.id)
			.toBe('REQ-1000')
	})

	it('refuses an already-occupied canonical target path even when its ID never decoded', () => {
		const snapshot = emptySnapshot()
		snapshot.entryKinds = new Map([['.engineering/req/REQ-001.md', 'file']])
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('target-exists')
	})

	it('rejects (managed-directory-symlinked) when the canonical type directory is a symlink, rather than allocating over it', () => {
		const snapshot = emptySnapshot()
		snapshot.entryKinds = new Map([
			['.engineering', 'directory'],
			['.engineering/req', 'symlink'],
		])
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('managed-directory-symlinked')
		expect(result.ok === false && result.diagnostics?.map(d => d.code))
			.toEqual(['EF-FS-004'])
		expect(result.ok === false && result.diagnostics?.[0]?.path)
			.toBe('.engineering/req')
	})

	it('rejects (managed-directory-symlinked) when `.engineering` itself is a symlink', () => {
		const snapshot = emptySnapshot()
		snapshot.entryKinds = new Map([['.engineering', 'symlink']])
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(false)
		expect(result.ok === false && result.reason)
			.toBe('managed-directory-symlinked')
		expect(result.ok === false && result.diagnostics?.map(d => d.path))
			.toEqual(['.engineering'])
	})

	it('does not reject a canonical type directory that simply does not exist yet (no entryKinds entry)', () => {
		// The common, legitimate case: no artifact of this type has been created
		// yet, so `.engineering/req` has no `entryKinds` entry at all. This must
		// allocate normally, not be confused with a forbidden symlink.
		const snapshot = emptySnapshot()
		snapshot.entryKinds = new Map([['.engineering', 'directory']])
		const result = computeCreatePlan({ snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(true)
	})

	it.each([
		['prd', 'prd', ['Problem', 'User Need', 'Desired Outcome', 'Success Criteria', 'Non-goals'], 'PRD-001', '.engineering/prd/PRD-001.md'],
		['req', 'requirement', ['Requirement', 'Rationale', 'Acceptance Criteria'], 'REQ-001', '.engineering/req/REQ-001.md'],
		['adr', 'decision', ['Context', 'Decision', 'Alternatives', 'Consequences'], 'ADR-001', '.engineering/adr/ADR-001.md'],
		['pol', 'policy', ['Policy', 'Scope', 'Rationale', 'Compliance'], 'POL-001', '.engineering/pol/POL-001.md'],
		['chg', 'change', ['Rationale', 'Sources', 'Changes', 'Verification'], 'CHG-001', '.engineering/chg/CHG-001.md'],
	] as const)('produces a valid draft skeleton for type token %s', (token, expectedType, headings, expectedId, expectedPath) => {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: token, title: 'A Title', summary: 'A summary sentence.', engineeringIdentity: FAKE_ENGINEERING_IDENTITY })
		expect(result.ok)
			.toBe(true)
		if (!result.ok)
			return

		expect(result.plan.type)
			.toBe(expectedType)
		expect(result.plan.id)
			.toBe(expectedId)
		expect(result.plan.path)
			.toBe(expectedPath)
		expect(result.plan.envelope)
			.toEqual({
				schema: SCHEMA_BY_TYPE[expectedType],
				type: expectedType,
				id: expectedId,
				title: 'A Title',
				status: 'draft',
				summary: 'A summary sentence.',
				tags: [],
				relations: [],
				resources: [],
				extensions: {},
			})
		expect(result.plan.changes)
			.toEqual([{ action: 'create', path: expectedPath }])

		const text = new TextDecoder()
			.decode(result.plan.bytes)
		expect(text)
			.toMatch(/^---\n/)
		for (const heading of headings) {
			expect(text)
				.toContain(`## ${heading}\n`)
		}
		expect(text.endsWith('\n') && !text.endsWith('\n\n'))
			.toBe(true)
	})
})

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target)
		.then(() => true, () => false)
}

describe('applyCreatePlan', () => {
	let tempDir: string
	// `.engineering`'s REAL identity, captured immediately after creating it in
	// `beforeEach` -- exactly what discovery would have observed before
	// `computeCreatePlan` ran in real usage (Finding 2, tenth round). Every
	// `computePlanOrThrow` call defaults to this so ordinary tests exercise the
	// real, matching-identity path; only the deliberate-mismatch regressions
	// below override it.
	let engineeringIdentity: FileIdentity

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-artifact-create-')))
		await fs.mkdir(path.join(tempDir, '.engineering'))
		const identity = await realDirectoryIdentity(path.join(tempDir, '.engineering'))
		if (identity === undefined)
			throw new Error('unexpected: freshly created \'.engineering\' has no directory identity')
		engineeringIdentity = identity
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	function computePlanOrThrow(overrides: Partial<Parameters<typeof computeCreatePlan>[0]> = {}): ArtifactCreatePlan {
		const result = computeCreatePlan({ snapshot: emptySnapshot(), type: 'req', title: 'Search Result Filtering', summary: 'Search results must support filtering.', engineeringIdentity, ...overrides })
		if (!result.ok)
			throw new Error(`unexpected computeCreatePlan failure: ${result.reason}`)
		return result.plan
	}

	it('performs zero writes when only the plan is computed (dry run)', () => {
		const plan = computePlanOrThrow()
		expect(plan.path)
			.toBe('.engineering/req/REQ-001.md')
	})

	it('publishes the complete draft file, creating the canonical directory when absent', async () => {
		const plan = computePlanOrThrow()
		const result = await applyCreatePlan(plan, tempDir)

		expect(result.applied)
			.toBe(true)
		if (!result.applied)
			return
		expect(result.path)
			.toBe(plan.path)

		const bytes = await fs.readFile(path.join(tempDir, plan.path))
		expect(new Uint8Array(bytes))
			.toEqual(plan.bytes)

		const entries = await fs.readdir(path.join(tempDir, '.engineering/req'))
		expect(entries)
			.toEqual(['REQ-001.md'])
	})

	it('rejects (raced) without overwriting a target created between plan and apply', async () => {
		const plan = computePlanOrThrow()
		await fs.mkdir(path.dirname(path.join(tempDir, plan.path)), { recursive: true })
		await fs.writeFile(path.join(tempDir, plan.path), 'a colliding draft got here first\n')

		const result = await applyCreatePlan(plan, tempDir)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('raced')

		const contents = await fs.readFile(path.join(tempDir, plan.path), 'utf8')
		expect(contents)
			.toBe('a colliding draft got here first\n')

		const leftoverTempFiles = (await fs.readdir(path.dirname(path.join(tempDir, plan.path))))
			.filter(name => name.includes('.tmp-'))
		expect(leftoverTempFiles)
			.toEqual([])
	})

	it('reports unsupported when hard-link publication is not available on the filesystem', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			publishViaHardLink: async () => ({ outcome: 'unsupported' as const, error: Object.assign(new Error('cross-device link'), { code: 'EXDEV' }) }),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('unsupported')

		expect(await pathExists(path.join(tempDir, plan.path)))
			.toBe(false)
	})

	it('falls back to "unknown error" when an unsupported publish failure carries no error code', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			publishViaHardLink: async () => ({ outcome: 'unsupported' as const, error: new Error('mysterious filesystem refusal') }),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('unsupported')
		expect(result.applied === false && result.message)
			.toContain('unknown error')
	})

	it('reports incomplete (not unsupported) for a generic publish failure without a recognized capability-absence code', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			publishViaHardLink: async () => ({ outcome: 'failed' as const, error: new Error('disk full') }),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Failed to publish '${plan.path}': disk full`)
	})

	it('treats a target-exists outcome from hard-link publication as a race', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			publishViaHardLink: async () => ({ outcome: 'target-exists' as const }),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('raced')
		expect(result.applied === false && result.message)
			.toBe(`'${plan.path}' already exists.`)

		expect(await pathExists(path.join(tempDir, plan.path)))
			.toBe(false)
	})

	it('detects a hard-link race that appears only after the temporary file was written and verified', async () => {
		const plan = computePlanOrThrow()
		let regularFileChecks = 0
		const deps = {
			...defaultApplyCreatePlanDeps,
			isRegularFile: async () => {
				regularFileChecks += 1
				// First call: pre-write check (target absent). Second call: the
				// post-verification re-check, simulating a competing writer that
				// created the target in between (13-cli-contract.md race handling).
				return regularFileChecks > 1
			},
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('raced')

		const leftoverTempFiles = (await fs.readdir(path.dirname(path.join(tempDir, plan.path))))
			.filter(name => name.includes('.tmp-'))
		expect(leftoverTempFiles)
			.toEqual([])
	})

	it('reports incomplete when the temporary file write itself fails', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			writeTempFileComplete: async () => ({ outcome: 'failed' as const, error: Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) }),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Failed to write the temporary file for '${plan.path}'.`)
	})

	it('reports incomplete when the read-back temporary file is a different length than the planned bytes', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			readFileBytes: async () => plan.bytes.slice(0, plan.bytes.length - 1),
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Temporary file for '${plan.path}' was not written with the planned bytes.`)

		const leftoverTempFiles = (await fs.readdir(path.dirname(path.join(tempDir, plan.path))))
			.filter(name => name.includes('.tmp-'))
		expect(leftoverTempFiles)
			.toEqual([])
	})

	it('reports incomplete when the read-back temporary file is the same length but different content than the planned bytes', async () => {
		const plan = computePlanOrThrow()
		const corrupted = plan.bytes.slice()
		corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! + 1) % 256
		const deps = {
			...defaultApplyCreatePlanDeps,
			readFileBytes: async () => corrupted,
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Temporary file for '${plan.path}' was not written with the planned bytes.`)
	})

	// ---- Symlinked managed-directory chain (EF-FS-004 domain rejection) -------

	it('rejects (rather than escaping) when the canonical type directory is a symlink to an external directory', async () => {
		const plan = computePlanOrThrow()
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-outside-')))
		try {
			await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
			await fs.symlink(outsideDir, path.join(tempDir, '.engineering/req'))

			const result = await applyCreatePlan(plan, tempDir)
			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// Nothing was written into the symlink's external target, and no
			// hard link was published at the symlink-traversing canonical path.
			expect(await fs.readdir(outsideDir))
				.toEqual([])
			await expect(fs.stat(path.join(tempDir, '.engineering/req/REQ-001.md'))).rejects.toThrow()

			const leftoverTempFiles = (await fs.readdir(outsideDir))
			expect(leftoverTempFiles)
				.toEqual([])
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('rejects (rather than escaping) when `.engineering` itself is a symlink to an external directory', async () => {
		const plan = computePlanOrThrow()
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-outside-')))
		try {
			// Replace the real `.engineering` `beforeEach` created (and the plan's
			// `engineeringIdentity` was captured against) with a symlink: the
			// symlink check fires before any identity comparison either way (see
			// `verifyChainComponent`), so this exercises the symlink-rejection path
			// regardless of the identity binding.
			await fs.rm(path.join(tempDir, '.engineering'), { recursive: true, force: true })
			await fs.symlink(outsideDir, path.join(tempDir, '.engineering'))

			const result = await applyCreatePlan(plan, tempDir)
			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// `ensureDirectory` (recursive `mkdir`) must never have run through the
			// symlink: no `req` directory (or anything else) was created inside
			// the external target.
			expect(await fs.readdir(outsideDir))
				.toEqual([])
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('rejects (TOCTOU) when the type directory is replaced with a symlink after the plan was computed but before apply runs', async () => {
		// The plan itself was computed against a snapshot with no symlinked
		// managed directory (chain "valid" at plan time) -- this test proves
		// `applyCreatePlan` re-checks live, rather than trusting that snapshot.
		const plan = computePlanOrThrow()
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-toctou-')))
		try {
			await fs.writeFile(path.join(outsideDir, 'pre-existing-secret.txt'), 'must not be disturbed')
			await fs.mkdir(path.join(tempDir, '.engineering'), { recursive: true })
			await fs.symlink(outsideDir, path.join(tempDir, '.engineering/req'))

			const result = await applyCreatePlan(plan, tempDir)
			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// The external directory's pre-existing content is untouched, and
			// nothing new (temp file or published artifact) was added to it.
			expect(await fs.readdir(outsideDir))
				.toEqual(['pre-existing-secret.txt'])
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('rejects when the type directory is replaced with a DIFFERENT real directory, no symlink involved, between checkpoints (Finding 2b regression)', async () => {
		// Same class as the fs-facts.ts / init.ts findings: a pure `isSymlink`
		// check, run fresh and independently at each checkpoint, cannot
		// distinguish the untouched original directory from a directory
		// substituted with a *different* real directory at the identical path
		// -- no symlink is ever present at the moment either check runs.
		// Identity (`dev`/`ino`) binding across checkpoints is required to
		// catch it.
		const plan = computePlanOrThrow()
		const reqDirPath = path.join(tempDir, '.engineering/req')
		const backupPath = path.join(tempDir, '.engineering/req-original-backup')
		await fs.mkdir(reqDirPath, { recursive: true })

		const deps = {
			...defaultApplyCreatePlanDeps,
			ensureDirectory: async (target: string) => {
				await defaultApplyCreatePlanDeps.ensureDirectory(target)
				if (target === reqDirPath) {
					await fs.rename(reqDirPath, backupPath)
					await fs.mkdir(reqDirPath)
				}
			},
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('rejected')

		// Nothing was published into the substituted directory, and the
		// original (backed-up) directory was never touched either.
		expect(await fs.readdir(reqDirPath))
			.toEqual([])
		expect(await fs.readdir(backupPath))
			.toEqual([])
	})

	// FINDING 2 (P1, tenth round): `.engineering` itself is bound to
	// `plan.engineeringIdentity` from `applyCreatePlan`'s very FIRST checkpoint
	// onward, never merely `undefined`. A prior implementation passed
	// `undefined` for BOTH chain components at that first checkpoint, so a
	// `.engineering` deleted or swapped for a different real directory strictly
	// between plan computation/authorization and `applyCreatePlan` was
	// wrongly accepted as an ordinary "not created yet" case identical to the
	// type directory's own legitimate absence -- `ensureDirectory`'s recursive
	// `mkdir` then silently recreated `.engineering` itself, and the fresh
	// allocation reload computed an ID over that new, empty shell instead of
	// refusing.
	describe('`.engineering` identity is bound from discovery time, before any write (Finding 2 regression, tenth round)', () => {
		it('rejects, without recreating `.engineering`, when the entire `.engineering` directory was deleted between plan computation and apply', async () => {
			// The exact reproduction from the review finding: compute the first
			// REQ plan (REQ-001) from a valid project, delete the entire
			// `.engineering` directory before `applyCreatePlan`, then apply.
			const plan = computePlanOrThrow()
			expect(plan.id)
				.toBe('REQ-001')

			await fs.rm(path.join(tempDir, '.engineering'), { recursive: true, force: true })

			const result = await applyCreatePlan(plan, tempDir)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// `.engineering` must NOT have been silently recreated by
			// `ensureDirectory`'s recursive `mkdir`, and nothing was published.
			await expect(fs.stat(path.join(tempDir, '.engineering'))).rejects.toThrow()
		})

		it('rejects, without writing anything, when `.engineering` was replaced by a DIFFERENT real directory between plan computation and apply (forced-identity stub)', async () => {
			// Rather than rely on timing to make two real directories land at the
			// same path with different `dev`/`ino` (platform/filesystem
			// dependent), force the plan's own `engineeringIdentity` to a value
			// that provably does not match the real, untouched `.engineering`
			// `beforeEach` created -- deterministically simulating "the plan was
			// computed against a `.engineering` that is no longer the one on
			// disk" without needing to physically race the swap.
			const mismatchedIdentity: FileIdentity = { dev: engineeringIdentity.dev, ino: engineeringIdentity.ino + 1 }
			const plan = computePlanOrThrow({ engineeringIdentity: mismatchedIdentity })
			expect(plan.id)
				.toBe('REQ-001')

			const result = await applyCreatePlan(plan, tempDir)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// `.engineering` itself is completely untouched (still empty, no
			// `req` directory or anything else created inside it), and nothing
			// was published.
			expect(await fs.readdir(path.join(tempDir, '.engineering')))
				.toEqual([])
			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
		})
	})

	// FINDING 1 (P1, eleventh round): the tenth-round regression directly above
	// forces `plan.engineeringIdentity` to a value that provably does NOT
	// match the real, untouched `.engineering` -- it proves ORDINARY mismatch
	// detection, not the ABA the review finding actually describes. On a
	// filesystem that recycles a just-freed directory inode (documented ext4
	// behavior), a `.engineering` deleted and immediately replaced with a
	// brand-new, empty directory can be assigned the EXACT SAME `dev`/`ino`
	// pair the plan captured -- identity alone cannot tell the two apart.
	// `applyCreatePlan` must also re-establish a content-generation witness
	// (configuration bytes, `PROJECT.md` bytes, and the complete visible
	// Artifact ID set) that an empty replacement cannot reproduce.
	describe('content-generation witness closes the identity-only ABA gap (Finding 1, eleventh round)', () => {
		/** A complete, realistic project: config, gitignore, and `PROJECT.md` -- but deliberately ZERO Requirement artifacts, exactly matching the review finding's own "first REQ-001 ever" reproduction, where a same-prefix-only allocation re-check (`verifyAllocationStillValid`'s pre-existing `nextId` comparison) trivially matches either way. */
		async function seedRealProject(engineeringDir: string): Promise<void> {
			await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), CONFIG_YAML)
			await fs.writeFile(path.join(engineeringDir, '.gitignore'), GITIGNORE)
			await fs.writeFile(path.join(engineeringDir, 'PROJECT.md'), PROJECT_MD)
		}

		it('rejects, without publishing, when `.engineering` is deleted and replaced by an empty directory whose identity is forced to alias the plan\'s captured identity at every observation point -- including the pre-publication snapshot reload\'s own pre/post-walk checks (deterministic inode-recycling simulation, never real inode recycling)', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await seedRealProject(engineeringDir)

			const loaded = await loadSnapshotFromWorkingTree(tempDir)
			expect(loaded.ok)
				.toBe(true)
			if (!loaded.ok)
				return

			const planResult = computeCreatePlan({ snapshot: loaded.snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity })
			expect(planResult.ok)
				.toBe(true)
			if (!planResult.ok)
				return
			const plan = planResult.plan
			// The exact reproduction from the review finding: the FIRST REQ-001
			// ever, over a project with zero pre-existing Requirement artifacts.
			expect(plan.id)
				.toBe('REQ-001')

			// ABA: delete `.engineering` entirely and replace it with a brand-new,
			// EMPTY directory at the identical path. Rather than rely on timing or
			// a specific filesystem/OS to reproduce a genuine dev/ino collision,
			// force EVERY identity observation this invocation makes for this
			// exact path -- `applyCreatePlan`'s own chain re-verification AND the
			// snapshot reload's internal pre-walk/post-walk identity checks
			// (`application/snapshot.ts`'s `expectedEngineeringIdentity` option) --
			// to report the plan's captured `engineeringIdentity`, exactly as a
			// real inode-recycling collision would.
			await fs.rm(engineeringDir, { recursive: true, force: true })
			await fs.mkdir(engineeringDir)

			function forcedIdentity(target: string): Promise<FileIdentity | undefined> {
				return realDirectoryIdentity(target)
					.then(real => (real === undefined ? undefined : (target === engineeringDir ? plan.engineeringIdentity : real)))
			}

			const deps = {
				...defaultApplyCreatePlanDeps,
				directoryIdentity: forcedIdentity,
				loadSnapshot: (root: string, expectedEngineeringIdentity: FileIdentity) =>
					loadSnapshotFromWorkingTree(root, { ...defaultSnapshotFsDeps, directoryIdentity: forcedIdentity }, { expectedEngineeringIdentity }),
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			// Nothing was published, and the replacement `.engineering` is left
			// exactly as the ABA left it -- empty -- never silently populated (its
			// `req` type directory is never even created) by this invocation.
			expect(await fs.readdir(engineeringDir))
				.toEqual([])
			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
		})

		it('rejects (raced) when `PROJECT.md`\'s bytes change in place between plan computation and apply, even though `.engineering`\'s identity never changes at all (content-witness mismatch, not an ABA)', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await seedRealProject(engineeringDir)

			const loaded = await loadSnapshotFromWorkingTree(tempDir)
			expect(loaded.ok)
				.toBe(true)
			if (!loaded.ok)
				return

			const planResult = computeCreatePlan({ snapshot: loaded.snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity })
			expect(planResult.ok)
				.toBe(true)
			if (!planResult.ok)
				return
			const plan = planResult.plan

			// Rewrite `PROJECT.md`'s content IN PLACE -- `.engineering` itself is
			// never touched, replaced, or recreated, so its real identity is
			// unchanged throughout. This isolates the CONTENT half of the witness:
			// no inode trick is involved at all.
			await fs.writeFile(path.join(engineeringDir, 'PROJECT.md'), PROJECT_MD.replace('Example Project', 'Rewritten Project'))

			const result = await applyCreatePlan(plan, tempDir)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
		})

		it('rejects (raced) when `PROJECT.md`\'s content changes strictly between the pre-write checkpoint and the pre-publication allocation reload -- proving the witness is re-established at BOTH checkpoints, not only the first', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await seedRealProject(engineeringDir)

			const loaded = await loadSnapshotFromWorkingTree(tempDir)
			expect(loaded.ok)
				.toBe(true)
			if (!loaded.ok)
				return

			const planResult = computeCreatePlan({ snapshot: loaded.snapshot, type: 'req', title: 'Title', summary: 'Summary text.', engineeringIdentity })
			expect(planResult.ok)
				.toBe(true)
			if (!planResult.ok)
				return
			const plan = planResult.plan

			// `deps.loadSnapshot` is called exactly twice per invocation: once by
			// the pre-write content-generation checkpoint, once more by the
			// pre-publication allocation reload. Let the FIRST call observe the
			// original, still-matching `PROJECT.md` (so the pre-write checkpoint
			// passes) and rewrite it only ahead of the SECOND call, isolating this
			// regression to the pre-publication checkpoint's own re-verification.
			let loadSnapshotCalls = 0
			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async (root: string, expectedEngineeringIdentity: FileIdentity) => {
					loadSnapshotCalls += 1
					if (loadSnapshotCalls > 1) {
						await fs.writeFile(path.join(root, '.engineering/PROJECT.md'), PROJECT_MD.replace('Example Project', 'Rewritten Mid-Apply'))
					}
					return defaultApplyCreatePlanDeps.loadSnapshot(root, expectedEngineeringIdentity)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')
			expect(loadSnapshotCalls)
				.toBe(2)

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()

			const leftoverTempFiles = (await fs.readdir(path.join(engineeringDir, 'req')))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles)
				.toEqual([])
		})
	})

	// FINDING 2 (P1, ninth round): the pre-publication `targetExists` re-check
	// alone proves only that THIS invocation's own candidate path is still
	// unclaimed -- it says nothing about whether the requested prefix's
	// ALLOCATION itself remains valid. Another writer can make a HIGHER
	// same-prefix Artifact visible at a DIFFERENT path (never touching this
	// invocation's own candidate target) strictly between plan computation and
	// publication.
	describe('allocation re-verification immediately before publication (Finding 2 regression, ninth round)', () => {
		function reqRequirementMd(id: string): string {
			return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Competing Requirement
status: draft
summary: A competing requirement published between plan computation and the pre-publication allocation re-check.
tags: []
relations: []
resources: []
---

## Requirement

The system must do something specific and testable.

## Rationale

Because it is needed.

## Acceptance Criteria

- The system behaves as specified.
`
		}

		it('rejects (raced) when a competing writer makes a higher same-prefix Artifact visible after planning but before the pre-publication allocation re-check', async () => {
			// The plan is computed over a snapshot where REQ-001 already exists,
			// so it selects REQ-002 -- exactly the review finding's reproduction.
			// Before the pre-publication allocation re-check runs, a competing
			// writer publishes a valid, identity-certain REQ-999: REQ-002 itself
			// is still absent (a bare `targetExists` re-check alone would keep
			// passing), but the TRUE next allocation is now REQ-1000, not
			// REQ-002.
			const snapshot = emptySnapshot()
			snapshot.artifacts.push(fakeArtifactWithId('REQ-001'))
			const plan = computePlanOrThrow({ snapshot })
			expect(plan.id)
				.toBe('REQ-002')

			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async (root: string, expectedEngineeringIdentity: FileIdentity) => {
					await fs.mkdir(path.join(root, '.engineering/req'), { recursive: true })
					await fs.writeFile(path.join(root, '.engineering/req/REQ-999.md'), reqRequirementMd('REQ-999'))
					return defaultApplyCreatePlanDeps.loadSnapshot(root, expectedEngineeringIdentity)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()

			const leftoverTempFiles = (await fs.readdir(path.join(tempDir, '.engineering/req')))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles)
				.toEqual([])
		})

		it('rejects (raced) when a competing writer makes an identity-uncertain same-prefix Artifact visible after planning but before the pre-publication allocation re-check', async () => {
			// Same class as above, but the competing writer's file itself never
			// decodes (malformed frontmatter) rather than declaring a higher,
			// well-formed ID -- the allocation witness must refuse exactly as
			// `computeCreatePlan` itself would have, rather than silently
			// treating the now-uncertain file as though it were absent.
			const plan = computePlanOrThrow()
			expect(plan.id)
				.toBe('REQ-001')

			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async (root: string, expectedEngineeringIdentity: FileIdentity) => {
					await fs.mkdir(path.join(root, '.engineering/req'), { recursive: true })
					await fs.writeFile(path.join(root, '.engineering/req/REQ-999.md'), 'not valid frontmatter at all\n')
					return defaultApplyCreatePlanDeps.loadSnapshot(root, expectedEngineeringIdentity)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()

			const leftoverTempFiles = (await fs.readdir(path.join(tempDir, '.engineering/req')))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles)
				.toEqual([])
		})
	})

	// FINDING 2 (P0): pre-publication chain checks alone cannot catch a swap
	// triggered from strictly INSIDE `writeTempFileComplete`/`publishViaHardLink`
	// themselves -- by the time any pre-check runs again, the call has already
	// returned. Only a POST-write/POST-publication re-verification, bound back
	// to the temporary file's own `fstat` identity, catches this.
	describe('post-write and post-publication identity verification (Finding 2 regression)', () => {
		it('retracts the publish (ownership-proven) and reports a typed race when the managed chain is swapped for a different real directory from INSIDE publishViaHardLink, even though the published content is provably intact', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const shadowDirs: string[] = []

			const deps = {
				...defaultApplyCreatePlanDeps,
				publishViaHardLink: async (tempPathArg: string, targetPathArg: string) => {
					const realResult = await defaultApplyCreatePlanDeps.publishViaHardLink(tempPathArg, targetPathArg)
					if (realResult.outcome === 'published') {
						// Triggered from INSIDE this dependency itself, after the real
						// hard link genuinely succeeded: hard-link the just-published
						// file into a separate directory (preserving its exact inode),
						// then swap that directory in for the type directory. The file
						// at `targetPathArg` still has exactly the bytes/inode this
						// invocation wrote -- only the managed chain identity around it
						// changed.
						const typeDirPath = path.dirname(targetPathArg)
						const shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-shadow-'))
						shadowDirs.push(shadowDir)
						await fs.link(targetPathArg, path.join(shadowDir, path.basename(targetPathArg)))
						await fs.rm(typeDirPath, { recursive: true, force: true })
						await fs.rename(shadowDir, typeDirPath)
					}
					return realResult
				},
			}

			try {
				const result = await applyCreatePlan(plan, tempDir, deps)

				expect(result.applied)
					.toBe(false)
				expect(result.applied === false && result.outcome)
					.toBe('raced')

				// The retraction removed only the entry it could prove (by inode)
				// was its own just-published content; the substituted directory
				// itself is otherwise left as the race left it (empty, here).
				expect(await fs.readdir(path.dirname(targetPath)))
					.toEqual([])

				const leftoverTempFiles = (await fs.readdir(path.dirname(targetPath)))
					.filter(name => name.includes('.tmp-'))
				expect(leftoverTempFiles)
					.toEqual([])
			}
			finally {
				for (const dir of shadowDirs)
					await fs.rm(dir, { recursive: true, force: true })
			}
		})

		it('reports applied+incomplete (never a plain success) and leaves foreign content untouched when the type directory is swapped for one already containing a different file at the temp name, from INSIDE publishViaHardLink before delegating to the real primitive', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const attackerContent = 'attacker content this invocation never wrote'

			const deps = {
				...defaultApplyCreatePlanDeps,
				publishViaHardLink: async (tempPathArg: string, targetPathArg: string) => {
					// Triggered from INSIDE this dependency, BEFORE delegating to the
					// real primitive: swap the type directory for a different real
					// directory that already contains a file at the exact temporary
					// name, with content this invocation never wrote. The real
					// `link()` call below then resolves both paths fresh, through the
					// swapped directory, and succeeds -- but hard-links the canonical
					// target to the WRONG file.
					const typeDirPath = path.dirname(targetPathArg)
					const victimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-victim-'))
					await fs.writeFile(path.join(victimDir, path.basename(tempPathArg)), attackerContent)
					await fs.rm(typeDirPath, { recursive: true, force: true })
					await fs.rename(victimDir, typeDirPath)
					return defaultApplyCreatePlanDeps.publishViaHardLink(tempPathArg, targetPathArg)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(true)
			expect('outcome' in result && result.outcome)
				.toBe('incomplete')

			// The foreign content must never be deleted (ownership could not be
			// proven by inode identity) and must never be misreported as the
			// planned bytes.
			const onDisk = await fs.readFile(targetPath, 'utf8')
			expect(onDisk)
				.toBe(attackerContent)
			expect(onDisk)
				.not.toBe(new TextDecoder()
					.decode(plan.bytes))
		})

		// FINDING 2 (P1): once publication is confirmed byte-for-byte and
		// identity-for-identity, the temporary file's removal is a "cleanup or
		// internal operation" (13-cli-contract.md), not the publication itself.
		// Swallowing its failure and returning a plain, unqualified success would
		// misreport the state exactly as 13-cli-contract.md forbids in the other
		// direction: silently downgrading a "publication succeeded, cleanup
		// failed" outcome to a fully-clean success.
		it('reports applied+cleanup-failed (never a plain success) when the verified temporary file cannot be unlinked after a successful, fully-verified publish', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)

			const deps = {
				...defaultApplyCreatePlanDeps,
				unlink: async (target: string) => {
					if (target.includes('.tmp-'))
						throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
					await defaultApplyCreatePlanDeps.unlink(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(true)
			expect('outcome' in result && result.outcome)
				.toBe('cleanup-failed')
			expect('outcome' in result && result.outcome === 'cleanup-failed' && result.path)
				.toBe(plan.path)

			// The publication itself is genuine and complete: the file is on disk
			// with exactly the planned bytes. Only the superfluous temporary file
			// (whose removal failed) is left behind.
			const onDisk = await fs.readFile(targetPath)
			expect(new Uint8Array(onDisk))
				.toEqual(plan.bytes)

			const leftoverTempFiles = (await fs.readdir(path.dirname(targetPath)))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles.length)
				.toBe(1)
		})
	})

	it('produces a draft file that validates as a draft under full snapshot validation', async () => {
		const engineeringDir = path.join(tempDir, '.engineering')
		await fs.mkdir(engineeringDir, { recursive: true })
		await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), CONFIG_YAML)
		await fs.writeFile(path.join(engineeringDir, '.gitignore'), GITIGNORE)
		await fs.writeFile(path.join(engineeringDir, 'PROJECT.md'), PROJECT_MD)

		const loaded = await loadSnapshotFromWorkingTree(tempDir)
		expect(loaded.ok)
			.toBe(true)
		if (!loaded.ok)
			return

		const planResult = computeCreatePlan({ snapshot: loaded.snapshot, type: 'req', title: 'Search Result Filtering', summary: 'Search results must support filtering by supported criteria.', engineeringIdentity })
		expect(planResult.ok)
			.toBe(true)
		if (!planResult.ok)
			return

		const applyResult = await applyCreatePlan(planResult.plan, tempDir)
		expect(applyResult.applied)
			.toBe(true)

		const reloaded = await loadSnapshotFromWorkingTree(tempDir)
		expect(reloaded.ok)
			.toBe(true)
		if (!reloaded.ok)
			return

		const validation = validateSnapshot(reloaded.snapshot)
		expect(validation.diagnostics.filter(d => d.severity === 'error'))
			.toEqual([])
		expect(validation.byId.get('REQ-001')?.status)
			.toBe('draft')
	})
})
