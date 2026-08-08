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
import { writeTempFileComplete as realWriteTempFileComplete } from '../platform/hard-link-publish'
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

	// Finding (P0, fifteenth round): the read-back byte content the temporary
	// write is validated against is now returned directly by
	// `writeTempFileComplete` itself (read through the SAME open handle that
	// wrote it), not re-derived from a later, independent `deps.readFileBytes(tempPath)`
	// pathname call -- so these two regressions now simulate a corrupted
	// read-back by wrapping the REAL primitive and doctoring its RETURNED
	// lease's `bytes` field, never the real bytes actually persisted on disk.
	// (Sixteenth round: the lease's other members -- `identity`, `fstatLive`,
	// `release` -- are spread through unchanged, so the underlying handle
	// stays a genuine, still-open lease.)
	it('reports incomplete when the handle-bound read-back is a different length than the planned bytes', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			writeTempFileComplete: async (tempPath: string, bytes: Uint8Array) => {
				const real = await realWriteTempFileComplete(tempPath, bytes)
				return real.outcome === 'written' ? { outcome: 'written' as const, lease: { ...real.lease, bytes: real.lease.bytes.slice(0, real.lease.bytes.length - 1) } } : real
			},
		}

		const result = await applyCreatePlan(plan, tempDir, deps)
		expect(result.applied)
			.toBe(false)
		expect(result.applied === false && result.outcome)
			.toBe('incomplete')
		expect(result.applied === false && result.message)
			.toBe(`Temporary file for '${plan.path}' was not written with the planned bytes.`)

		// The REAL file on disk still holds the genuinely correct bytes and
		// identity -- only this test's forged return value disagrees. The
		// ownership-proof cleanup attempt re-verifies the witness against the
		// REAL, unforged, on-disk bytes by pathname (`fileOwnershipProven`,
		// unchanged) and correctly refuses to delete a file that does not
		// actually match the (deliberately wrong) witness it was asked to
		// verify against; the genuinely correct temporary file this
		// invocation wrote is left behind rather than removed on a witness
		// that cannot even be proven self-consistent.
		const leftoverTempFiles = (await fs.readdir(path.dirname(path.join(tempDir, plan.path))))
			.filter(name => name.includes('.tmp-'))
		expect(leftoverTempFiles.length)
			.toBe(1)
	})

	it('reports incomplete when the handle-bound read-back is the same length but different content than the planned bytes', async () => {
		const plan = computePlanOrThrow()
		const deps = {
			...defaultApplyCreatePlanDeps,
			writeTempFileComplete: async (tempPath: string, bytes: Uint8Array) => {
				const real = await realWriteTempFileComplete(tempPath, bytes)
				if (real.outcome !== 'written')
					return real
				const corrupted = real.lease.bytes.slice()
				corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! + 1) % 256
				return { outcome: 'written' as const, lease: { ...real.lease, bytes: corrupted } }
			},
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

	// FINDING 3 (P1, twelfth round): `LoadSnapshotResult` includes `read-error`
	// (and execution/unavailability reasons) alongside proven state-change
	// reasons (`engineering-swapped`, `engineering-missing`), but the
	// pre-write and pre-publication re-verification checkpoints previously
	// flattened EVERY reload failure into the same typed race rejection. A
	// read/permission/I/O failure does not establish that another writer
	// invalidated the plan -- it establishes only that this invocation could
	// not finish checking. Such a failure must be reported as `applied: false,
	// outcome: 'incomplete'`, never `'raced'`.
	describe('a read-error re-verifying the plan is reported as incomplete, never a claimed race (Finding 3 regression, twelfth round)', () => {
		it('reports incomplete (not raced) when the pre-write content-generation reload itself fails with a read-error', async () => {
			const plan = computePlanOrThrow()
			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async () => ({ ok: false as const, reason: 'read-error' as const, message: 'stub: simulated I/O failure re-verifying the project' }),
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
			expect(result.applied === false && result.message)
				.toContain('stub: simulated I/O failure re-verifying the project')

			// Nothing was written: this checkpoint runs before `ensureDirectory`.
			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
			await expect(fs.stat(path.join(tempDir, '.engineering/req'))).rejects.toThrow()
		})

		it('reports incomplete (not raced) when the pre-publication allocation reload itself fails with a read-error', async () => {
			const plan = computePlanOrThrow()
			let loadSnapshotCalls = 0
			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async (projectRoot: string, expectedEngineeringIdentity: FileIdentity) => {
					loadSnapshotCalls += 1
					// First call: the pre-write content-generation checkpoint -- let it
					// observe the real, still-valid project so that checkpoint passes,
					// isolating this regression to the SECOND (pre-publication) reload.
					if (loadSnapshotCalls > 1)
						return { ok: false as const, reason: 'read-error' as const, message: 'stub: simulated I/O failure immediately before publication' }
					return defaultApplyCreatePlanDeps.loadSnapshot(projectRoot, expectedEngineeringIdentity)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
			expect(result.applied === false && result.message)
				.toContain('stub: simulated I/O failure immediately before publication')
			expect(loadSnapshotCalls)
				.toBe(2)

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
			const leftoverTempFiles = (await fs.readdir(path.join(tempDir, '.engineering/req')))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles)
				.toEqual([])
		})

		// `engineering-swapped` (a PROVEN identity mismatch, as opposed to
		// `read-error`'s mere inability to check) must still be reported as a
		// typed race, exactly as before -- this reclassification narrows what
		// counts as a race, it does not widen `incomplete` to also cover proven
		// state changes.
		it('still reports raced (not incomplete) when the pre-publication reload itself reports a proven `engineering-swapped` mismatch', async () => {
			const plan = computePlanOrThrow()
			const deps = {
				...defaultApplyCreatePlanDeps,
				loadSnapshot: async () => ({ ok: false as const, reason: 'engineering-swapped' as const, message: 'stub: simulated proven identity mismatch' }),
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')
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

	// FINDING 2 (P1, twelfth round): the post-publication re-verification just
	// above (managed chain identity + `targetPath`'s own `fstat` identity
	// bound back to `tempIdentity`) proves only that the published file is
	// genuinely THIS INVOCATION's own file, through a managed chain carrying
	// familiar `dev`/`ino` pairs -- never that it was published into the
	// exact PROJECT GENERATION this plan was authorized against. A canonical
	// type directory replaced by a content-distinct generation strictly after
	// the pre-publication reload but from INSIDE `publishViaHardLink` itself
	// -- whose identity is forced to alias the value this invocation already
	// captured, exactly the inode-recycling hazard `ContentGenerationWitness`
	// documents (simulated here deterministically via a forced-identity stub,
	// never real inode recycling) -- passes every pre-Finding-2-twelfth-round
	// check even though it demonstrably contains an Artifact this plan never
	// accounted for.
	describe('post-publication content-generation witness (Finding 2 regression, twelfth round)', () => {
		it('retracts the publish (ownership-proven) and reports a typed race -- rather than a plain success -- when the canonical type directory is replaced by a content-distinct generation from INSIDE publishViaHardLink after the real link, with the replacement\'s identity forced to alias the value already captured', async () => {
			const engineeringDir = path.join(tempDir, '.engineering')
			await fs.writeFile(path.join(engineeringDir, 'ef.yaml'), CONFIG_YAML)
			await fs.writeFile(path.join(engineeringDir, '.gitignore'), GITIGNORE)
			await fs.writeFile(path.join(engineeringDir, 'PROJECT.md'), PROJECT_MD)

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
			// The exact reproduction the review finding describes: the FIRST
			// REQ-001 ever, so a same-prefix-only allocation re-check would
			// trivially match either way -- only the COMPLETE visible ID set
			// tells the replacement generation apart.
			expect(plan.id)
				.toBe('REQ-001')

			const targetPath = path.join(tempDir, plan.path)
			const reqDirPath = path.join(engineeringDir, 'req')
			let forcedTypeDirIdentity: FileIdentity | undefined

			// Forces every observation of the `req` canonical directory's path
			// to report whichever real identity was FIRST observed there, no
			// matter how many times the real directory instance backing that
			// path is later substituted -- exactly what a filesystem recycling
			// a just-freed inode for a brand-new directory would report. Every
			// OTHER path (in particular `.engineering` itself, never touched by
			// this test) still reports its genuine, unforced identity.
			function forcedIdentity(target: string): Promise<FileIdentity | undefined> {
				return realDirectoryIdentity(target)
					.then((real) => {
						if (real === undefined)
							return undefined
						if (target !== reqDirPath)
							return real
						forcedTypeDirIdentity ??= real
						return forcedTypeDirIdentity
					})
			}

			const deps = {
				...defaultApplyCreatePlanDeps,
				directoryIdentity: forcedIdentity,
				loadSnapshot: (root: string, expectedEngineeringIdentity: FileIdentity) =>
					loadSnapshotFromWorkingTree(root, { ...defaultSnapshotFsDeps, directoryIdentity: forcedIdentity }, { expectedEngineeringIdentity }),
				publishViaHardLink: async (tempPathArg: string, targetPathArg: string) => {
					const realResult = await defaultApplyCreatePlanDeps.publishViaHardLink(tempPathArg, targetPathArg)
					if (realResult.outcome === 'published') {
						// Triggered from INSIDE this dependency, AFTER the real link()
						// genuinely succeeded: build a content-distinct replacement
						// `req` directory. The just-published file's exact inode is
						// preserved at BOTH the canonical name and the temporary name
						// (so the post-publication file-identity check, AND this
						// invocation's own best-effort temp-file cleanup, both keep
						// working) -- but an EXTRA, fully valid Requirement this plan
						// never accounted for is ALSO present: a genuinely different
						// project generation's `req` directory, not a mere rename of
						// the original.
						const replacementDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-replacement-req-'))
						await fs.link(targetPathArg, path.join(replacementDir, path.basename(targetPathArg)))
						await fs.link(tempPathArg, path.join(replacementDir, path.basename(tempPathArg)))
						await fs.writeFile(path.join(replacementDir, 'REQ-999.md'), `---
schema: ef/requirement@1
type: requirement
id: REQ-999
title: Unrelated Replacement Requirement
status: draft
summary: An Artifact visible only in the replacement generation, never authorized by this plan.
tags: []
relations: []
resources: []
---

## Requirement

Placeholder.

## Rationale

Placeholder.

## Acceptance Criteria

- Placeholder.
`)
						await fs.rm(reqDirPath, { recursive: true, force: true })
						await fs.rename(replacementDir, reqDirPath)
					}
					return realResult
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			// Only the entry this invocation could prove (by inode) was its own
			// just-published file was retracted; the replacement directory's
			// otherwise-foreign content -- the extra Requirement this plan never
			// authorized -- is left completely untouched.
			await expect(fs.stat(targetPath)).rejects.toThrow()
			expect(await fs.readdir(reqDirPath))
				.toEqual(['REQ-999.md'])
		})
	})

	// FINDING 1 (P0, thirteenth round): `safeUnlink` had no ownership proof at
	// all -- it unlinked whatever currently occupied `tempPath` BY PATHNAME,
	// even immediately after a `verifyManagedDirectoryChain` re-verification
	// had just proven the chain no longer denotes what this invocation is
	// bound to. Deterministic reproduction (no forced-identity aliasing
	// needed here: the type directory is genuinely, physically replaced):
	// this invocation's own temporary file is written and byte-verified, its
	// `lstat` identity is captured, and ONLY THEN -- on the very next
	// `directoryIdentity` observation of the type directory, the one
	// `verifyManagedDirectoryChain`'s post-write re-check performs -- the
	// entire type directory is replaced with a different real directory that
	// already contains a foreign file at the EXACT temporary basename. The
	// chain re-check correctly reports a mismatch (a different real directory
	// instance), but the un-fixed code's very next step, `safeUnlink(tempPath)`,
	// resolved that same pathname fresh, through the KNOWN replacement, and
	// deleted the foreign file before ever reporting the rejection.
	describe('ownership-proven temporary-file cleanup (Finding 1, thirteenth round)', () => {
		it('leaves a foreign file at the exact temporary basename untouched when the type directory is replaced with a different real directory strictly after this invocation\'s own temporary file was written, verified, and identity-captured', async () => {
			const plan = computePlanOrThrow()
			const reqDirPath = path.join(tempDir, '.engineering/req')
			const targetPath = path.join(tempDir, plan.path)
			const fixedNonce = 'fixed-nonce-finding-1'
			const tempBasename = `.${path.basename(plan.path)}.tmp-${fixedNonce}`
			const foreignContent = 'foreign content at the exact temporary basename that this invocation never wrote'

			let typeDirIdentityCalls = 0

			const deps = {
				...defaultApplyCreatePlanDeps,
				generateNonce: () => fixedNonce,
				directoryIdentity: async (target: string) => {
					if (target === reqDirPath) {
						typeDirIdentityCalls++
						// Call #1: the very first pre-write chain check, before the
						// type directory exists at all. Call #2: the chain check
						// immediately after `ensureDirectory` creates it, still empty,
						// still BEFORE the temporary file is written. Call #3: the
						// post-write chain re-check, which runs only after this
						// invocation's own temporary file has already been written,
						// byte-verified, and had its `lstat` identity captured -- the
						// exact point the review finding describes. Replace the type
						// directory strictly at that point, before this call's own
						// `lstat` observes it.
						if (typeDirIdentityCalls === 3) {
							const replacementDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-typedir-replacement-'))
							await fs.writeFile(path.join(replacementDir, tempBasename), foreignContent)
							await fs.rm(reqDirPath, { recursive: true, force: true })
							await fs.rename(replacementDir, reqDirPath)
						}
					}
					return realDirectoryIdentity(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// The foreign file at the exact temporary basename must survive:
			// its identity can never be bound back to the temporary file THIS
			// invocation itself created and byte-verified, so ownership can
			// never be proven, and the un-fixed pathname-based unlink must not
			// have run against it.
			const onDisk = await fs.readFile(path.join(reqDirPath, tempBasename), 'utf8')
			expect(onDisk)
				.toBe(foreignContent)

			// The canonical target was never created either: publication was
			// never even attempted, since the chain check failed first.
			await expect(fs.stat(targetPath)).rejects.toThrow()
		})
	})

	// FINDING (P0, fifteenth round): a prior implementation reported only
	// `{ outcome: 'written' }` from `writeTempFileComplete` -- no identity of
	// the inode its own `open(tempPath, 'wx')` handle actually created.
	// `applyCreatePlan` then established `tempWitness` from TWO fresh
	// PATHNAME observations made only AFTER that handle had already closed:
	// `deps.readFileBytes(tempPath)`, then `deps.fileIdentity(tempPath)`.
	// Neither call carries any provenance binding it back to the exact file
	// this invocation itself created -- whatever real regular file happens to
	// occupy `tempPath` by the time they run is what gets adopted as "ours".
	// Deterministic reproduction (no forced-identity aliasing: the type
	// directory is genuinely, physically replaced): the REAL `writeTempFileComplete`
	// succeeds, creating this invocation's own temporary file; strictly
	// afterward -- before this invocation ever re-observes `tempPath` by
	// pathname for ANY reason -- the entire type directory is replaced with a
	// different real directory that already contains a foreign regular file
	// at the EXACT temporary basename, with bytes BYTE-FOR-BYTE IDENTICAL to
	// `plan.bytes` (proving content equality alone can never distinguish the
	// foreign file from this invocation's own). The un-fixed code's
	// subsequent `readFileBytes`/`fileIdentity` pathname reads resolve fresh
	// through the replacement, silently binding `tempWitness` to the FOREIGN
	// file's own identity; the following managed-directory-chain re-check
	// correctly detects the replacement, and the un-fixed `deleteOwnedTempFile`
	// call then finds the foreign file matches that wrongly-bound witness --
	// by BOTH identity and byte content -- and unlinks it.
	describe('temporary-file ownership witness is bound to the handle that created it, not a later pathname observation (Finding, fifteenth round)', () => {
		it('leaves a byte-identical foreign temp file untouched, and never publishes, when the type directory is swapped for one containing a foreign file at the exact temp basename immediately after the real write succeeds', async () => {
			const plan = computePlanOrThrow()
			const reqDirPath = path.join(tempDir, '.engineering/req')
			const targetPath = path.join(tempDir, plan.path)
			const fixedNonce = 'fixed-nonce-finding-15'
			const tempBasename = `.${path.basename(plan.path)}.tmp-${fixedNonce}`

			let foreignIdentity: FileIdentity | undefined

			const deps = {
				...defaultApplyCreatePlanDeps,
				generateNonce: () => fixedNonce,
				// Delegate to the REAL primitive first -- this invocation's own
				// temporary file is genuinely created, written, fsynced, and
				// closed exactly as production code does. Only AFTER it
				// reports success (i.e. strictly after its handle is already
				// closed) does this hook replace the type directory -- before
				// `applyCreatePlan` itself ever performs another pathname
				// observation of `tempPath` for any reason.
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome === 'written') {
						const replacementDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-typedir-replacement-15-'))
						const foreignPath = path.join(replacementDir, tempBasename)
						// Byte-for-byte identical to `plan.bytes`: content alone
						// must never be sufficient to prove ownership.
						await fs.writeFile(foreignPath, bytes)
						const foreignStat = await fs.stat(foreignPath)
						foreignIdentity = { dev: foreignStat.dev, ino: foreignStat.ino }
						await fs.rm(reqDirPath, { recursive: true, force: true })
						await fs.rename(replacementDir, reqDirPath)
					}
					return real
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			// Never a plain success: the managed chain was genuinely replaced
			// strictly after the write.
			expect(result.applied === true && result.outcome === 'applied')
				.toBe(false)

			// The canonical target must never be published.
			await expect(fs.stat(targetPath)).rejects.toThrow()

			// The foreign file at the exact temporary basename must survive
			// COMPLETELY UNTOUCHED -- same identity, same bytes -- because
			// this invocation can never prove (by inode identity bound to its
			// own creating handle) that it owns it, even though the bytes
			// are byte-for-byte identical to `plan.bytes`.
			const survivingPath = path.join(reqDirPath, tempBasename)
			const survivingStat = await fs.stat(survivingPath)
			expect({ dev: survivingStat.dev, ino: survivingStat.ino })
				.toEqual(foreignIdentity)
			const survivingBytes = await fs.readFile(survivingPath)
			expect(new Uint8Array(survivingBytes))
				.toEqual(plan.bytes)
		})

		it('flows the identity returned by writeTempFileComplete\'s own handle through to the published target (happy path: same inode as a genuine hard link)', async () => {
			const plan = computePlanOrThrow()
			let capturedIdentity: FileIdentity | undefined

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome === 'written')
						capturedIdentity = real.lease.identity
					return real
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)
			expect(result.applied)
				.toBe(true)
			if (!result.applied)
				return
			expect(result.outcome)
				.toBe('applied')

			expect(capturedIdentity)
				.toBeDefined()
			const publishedStat = await fs.stat(path.join(tempDir, plan.path))
			expect({ dev: publishedStat.dev, ino: publishedStat.ino })
				.toEqual(capturedIdentity)
		})
	})

	// FINDING (P0, sixteenth round): the fifteenth-round fix (capture
	// identity/bytes from the creating handle) is still not enough if that
	// handle is then CLOSED before `applyCreatePlan` finishes deciding what to
	// do with the temporary file: once closed, the temporary file has only its
	// pathname link, and if another actor removes that link, the underlying
	// inode becomes free for the filesystem to recycle -- a byte-identical
	// foreign replacement written at the exact same basename could then report
	// the exact same `(dev, ino)` the closed handle once did, fooling BOTH the
	// identity comparison and a byte-content comparison in `fileOwnershipProven`
	// at once.
	//
	// Deterministic reproduction (no reliance on real inode recycling): the
	// REAL `writeTempFileComplete` succeeds, and its returned lease's creating
	// handle is left OPEN (this is the fix under test). This invocation's own
	// temporary file's ONE pathname link is then genuinely removed, and a
	// byte-identical foreign file is installed at the exact same basename --
	// then `deps.fileIdentity(tempPath)` is FORCED to report the ORIGINAL,
	// handle-captured identity, simulating what a coincidental inode-recycling
	// ABA would look like to any pathname-only observation (deliberately
	// simulated rather than relied upon to happen for real, since no
	// filesystem this package targets can be made to recycle a specific inode
	// number deterministically and quickly). A real, unforced managed-directory-
	// chain mismatch (the type directory reported as a symlink, once) then
	// drives `deleteOwnedTempFile`'s ownership-proven cleanup. Because the
	// lease's handle is still open the whole time, `fstatLive()` genuinely
	// pins the original inode: the underlying file's own `nlink` reaches zero
	// the instant its one link is removed, so `fstatLive()` reports `undefined`
	// (fail closed) regardless of what the forced `deps.fileIdentity(tempPath)`
	// claims -- the foreign file must survive completely untouched.
	describe('temporary-file ownership proof stays valid for as long as the lease is held, immune to a forced pathname-identity match (Finding, sixteenth round)', () => {
		it('leaves a byte-identical foreign temp file untouched even when the pathname-identity dependency is forced to falsely report a match, when a real chain mismatch drives cleanup', async () => {
			const plan = computePlanOrThrow()
			const reqDirPath = path.join(tempDir, '.engineering/req')
			const targetPath = path.join(tempDir, plan.path)
			const fixedNonce = 'fixed-nonce-finding-16'
			const tempBasename = `.${path.basename(plan.path)}.tmp-${fixedNonce}`
			const tempPath = path.join(reqDirPath, tempBasename)

			let originalIdentity: FileIdentity | undefined
			let foreignBytes: Uint8Array | undefined
			let chainMismatchTriggered = false

			const deps = {
				...defaultApplyCreatePlanDeps,
				generateNonce: () => fixedNonce,
				// Delegate to the REAL primitive first -- this invocation's own
				// temporary file is genuinely created, written, fsynced, and its
				// handle is left OPEN (returned as the lease). Only AFTER it
				// reports success does this hook remove that ONE pathname link
				// for real and install a byte-identical foreign file at the
				// exact same basename -- exercising the real ABA setup the fix
				// must survive.
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome === 'written') {
						originalIdentity = real.lease.identity
						foreignBytes = bytes.slice()
						await fs.unlink(tempPathArg)
						await fs.writeFile(tempPathArg, foreignBytes)
					}
					return real
				},
				// Deterministic ABA simulation: force the pathname-identity
				// dependency to report the ORIGINAL, handle-captured identity
				// for `tempPath` -- exactly what a coincidental real inode
				// recycling would look like to a pathname-only observer. The
				// fix must not be fooled by this alone.
				fileIdentity: async (target: string) => {
					if (target === tempPath && originalIdentity !== undefined)
						return originalIdentity
					return defaultApplyCreatePlanDeps.fileIdentity(target)
				},
				// A real, unforced managed-directory-chain mismatch, triggered
				// exactly once, strictly after the write above has already run
				// (never during the very first, pre-write chain checks, before
				// the type directory even exists).
				isSymlink: async (target: string) => {
					if (target === reqDirPath && originalIdentity !== undefined && !chainMismatchTriggered) {
						chainMismatchTriggered = true
						return true
					}
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			// A genuine chain-mismatch rejection, never a plain success and
			// never publication.
			expect(result.applied === false && result.outcome)
				.toBe('rejected')
			await expect(fs.stat(targetPath)).rejects.toThrow()

			// The foreign file must survive completely untouched -- same
			// identity, same bytes -- because `fstatLive()` reports `undefined`
			// (this invocation's own temp file's `nlink` reached zero the
			// instant its one link was removed) regardless of what the forced
			// `fileIdentity(tempPath)` claims.
			const survivingStat = await fs.stat(tempPath)
			expect({ dev: survivingStat.dev, ino: survivingStat.ino })
				.not.toEqual(originalIdentity)
			const survivingBytes = await fs.readFile(tempPath)
			expect(new Uint8Array(survivingBytes))
				.toEqual(foreignBytes)
		})
	})

	// FINDING (P1, fourteenth round): once `publishViaHardLink` reports
	// `'published'`, publication has ALREADY physically occurred, so
	// 13-cli-contract.md's "the implementation MUST NOT misreport the
	// published state as unapplied" governs every subsequent observation and
	// cleanup step. `verifyManagedDirectoryChain` and `deps.fileIdentity` both
	// rethrow a non-`ENOENT` `lstat` failure (they are plain observation
	// primitives, not domain checks); several post-publication call sites
	// awaited them without any surrounding `try`/`catch`, so an unexpected
	// `EIO`/`EACCES` there escaped `applyCreatePlan` entirely -- and, from
	// there, `runArtifactCreateCommand`'s outer catch reported `applied:
	// false`, misreporting a publication that genuinely happened as though it
	// never did. `fileOwnershipProven`'s own `deps.fileIdentity` call had the
	// identical hole, which `deleteOwnedTempFile` (the sole best-effort
	// temp-file cleanup primitive) inherited.
	// FINDING (P1, sixteenth round): a rejection from the temporary file's own
	// `handle.close()` (now `OwnedFileLease.release()`) must never override an
	// already-decided `applyCreatePlan` result by escaping as an uncaught
	// rejection (13-cli-contract.md's exit table reserves exit `3` for
	// internal defects, exit `2` for execution/permission inability -- a
	// pre-publication close failure escaping unguarded would misreport a
	// simple cleanup hiccup as an internal defect). `release()` itself never
	// throws; these regressions instead mock its RETURN VALUE
	// (`released-with-error`) and assert `applyCreatePlan`'s own
	// `foldLeaseRelease` folds it into the correct typed outcome depending on
	// whether canonical publication had already occurred.
	describe('temp-lease release() failure containment (Finding 2, sixteenth round)', () => {
		it('reports applied:false/incomplete (never a rejection, never a stronger claim such as raced) when the temp lease fails to release BEFORE any canonical publication', async () => {
			const plan = computePlanOrThrow()
			const reqDirPath = path.join(tempDir, '.engineering/req')
			const releaseError = Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })
			let writeCompleted = false
			let chainMismatchTriggered = false

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					writeCompleted = true
					// `fstatLive` and `bytes`/`identity` are the REAL lease's own,
					// unmodified -- only `release()`'s reported OUTCOME is
					// mocked, exactly as a real close failure would surface
					// through `OwnedFileLease`'s own non-throwing contract.
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								await real.lease.release()
								return { outcome: 'released-with-error' as const, error: releaseError }
							},
						},
					}
				},
				// A real, unforced managed-directory-chain mismatch, triggered
				// exactly once, strictly after the write -- so publication is
				// never even attempted.
				isSymlink: async (target: string) => {
					if (target === reqDirPath && writeCompleted && !chainMismatchTriggered) {
						chainMismatchTriggered = true
						return true
					}
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
			expect(result.applied === false && result.message)
				.toContain(releaseError.message)

			await expect(fs.stat(path.join(tempDir, plan.path))).rejects.toThrow()
		})

		it('reports applied:true/cleanup-failed (never a rejection, never a plain success) when the temp lease fails to release AFTER a fully verified publish', async () => {
			const plan = computePlanOrThrow()
			const releaseError = Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								await real.lease.release()
								return { outcome: 'released-with-error' as const, error: releaseError }
							},
						},
					}
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(true)
			expect('outcome' in result && result.outcome)
				.toBe('cleanup-failed')
			expect('message' in result && result.message)
				.toContain(releaseError.message)

			// The canonical publication genuinely happened, was fully
			// verified, and its temp file was even successfully unlinked --
			// only releasing the lease itself failed -- so the published file
			// must still be exactly what this invocation wrote.
			const onDisk = await fs.readFile(path.join(tempDir, plan.path))
			expect(new Uint8Array(onDisk))
				.toEqual(plan.bytes)
		})
	})

	describe('post-published state exception containment (Finding regression, fourteenth round)', () => {
		it('reports applied:true/incomplete (never rejecting the call) when the post-publication fileIdentity(targetPath) re-check throws an unexpected error after a real, successful hard link', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)

			const deps = {
				...defaultApplyCreatePlanDeps,
				fileIdentity: async (target: string) => {
					if (target === targetPath)
						throw Object.assign(new Error('input/output error'), { code: 'EIO' })
					return defaultApplyCreatePlanDeps.fileIdentity(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(true)
			expect('outcome' in result && result.outcome)
				.toBe('incomplete')

			// The canonical publication genuinely happened and must not be
			// misreported as unapplied: the file is still on disk with exactly
			// the planned bytes.
			const onDisk = await fs.readFile(targetPath)
			expect(new Uint8Array(onDisk))
				.toEqual(plan.bytes)
		})

		it('reports applied:true/cleanup-failed (never rejecting, never a plain success) when the best-effort cleanup ownership-probe fileIdentity(tempPath) throws after a fully verified publish', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const fixedNonce = 'fixed-nonce-round14-cleanup'
			const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${fixedNonce}`)

			const deps = {
				...defaultApplyCreatePlanDeps,
				generateNonce: () => fixedNonce,
				fileIdentity: async (target: string) => {
					// Finding (P0, fifteenth round): the temporary file's own
					// identity is established from `writeTempFileComplete`'s
					// handle-bound return value now, never from a `deps.fileIdentity(tempPath)`
					// call -- so the ONLY remaining call to `deps.fileIdentity(tempPath)`
					// in a fully-verified publish is the FINAL, otherwise-best-effort
					// cleanup ownership probe inside `deleteOwnedTempFile`, the one
					// this regression targets.
					if (target === tempPath)
						throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
					return defaultApplyCreatePlanDeps.fileIdentity(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(true)
			expect('outcome' in result && result.outcome)
				.toBe('cleanup-failed')

			const onDisk = await fs.readFile(targetPath)
			expect(new Uint8Array(onDisk))
				.toEqual(plan.bytes)

			const leftoverTempFiles = (await fs.readdir(path.dirname(targetPath)))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles.length)
				.toBe(1)
		})

		it('preserves applied:false/raced (never re-promoted to applied:true) when the temp-file cleanup ownership-probe throws immediately after a successful target retraction', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const shadowDirs: string[] = []
			const fixedNonce = 'fixed-nonce-round14-retraction'
			const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${fixedNonce}`)

			const deps = {
				...defaultApplyCreatePlanDeps,
				generateNonce: () => fixedNonce,
				fileIdentity: async (target: string) => {
					// Finding (P0, fifteenth round): the ONLY remaining call to
					// `deps.fileIdentity(tempPath)` on this path is the
					// best-effort temp-file cleanup probe that runs immediately
					// after the successful target retraction below.
					if (target === tempPath)
						throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
					return defaultApplyCreatePlanDeps.fileIdentity(target)
				},
				publishViaHardLink: async (tempPathArg: string, targetPathArg: string) => {
					const realResult = await defaultApplyCreatePlanDeps.publishViaHardLink(tempPathArg, targetPathArg)
					if (realResult.outcome === 'published') {
						// Same technique as the "Finding 2 regression" test above:
						// swap the managed chain for a DIFFERENT real directory from
						// INSIDE `publishViaHardLink`, strictly after the real
						// `link()` call succeeded, so the post-publication chain
						// re-check reports a mismatch even though the published
						// file's own content/inode is still provably this
						// invocation's own (the hard link into the shadow directory
						// preserves it) -- this is what drives `applyCreatePlan`
						// into the ownership-proven retraction path below.
						const typeDirPath = path.dirname(targetPathArg)
						const shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ef-create-shadow-round14-'))
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

				// The canonical target was genuinely retracted; this must never be
				// re-promoted back to `applied: true` merely because the
				// SEPARATE, best-effort temp-file cleanup probe also failed.
				await expect(fs.stat(targetPath)).rejects.toThrow()
			}
			finally {
				for (const dir of shadowDirs)
					await fs.rm(dir, { recursive: true, force: true })
			}
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

	// FINDING 2 (P1, thirteenth round): `captureContentGenerationWitness`
	// builds `visibleIds` with `collectVisibleIds`, which intentionally skips
	// any Artifact whose envelope never decoded -- the same reason
	// `computeCreatePlan` and `verifyAllocationStillValid` both separately run
	// `findIdentityUncertainArtifact` alongside it, never in its place. The
	// FINAL post-publication verifier, `verifyPostPublicationGenerationWitness`,
	// did not repeat that gate: a newly-visible malformed Artifact leaves
	// `current.visibleIds` exactly equal to `plan.contentWitness.visibleIds +
	// plan.id` (the one change publication itself is supposed to make), so the
	// un-fixed function reported a plain, fully-verified success even though
	// the allocator's own completeness proof could no longer be established at
	// the actual publication point -- exactly the state `computeCreatePlan` and
	// `verifyAllocationStillValid` both deliberately refuse instead of guessing
	// past.
	describe('post-publication allocation-completeness re-verification (Finding 2, thirteenth round)', () => {
		it('retracts the publish (ownership-proven) and reports a typed race -- never a plain success -- when a newly-visible malformed Artifact is created from INSIDE publishViaHardLink, even though the managed chain and content-generation witness both otherwise match', async () => {
			const plan = computePlanOrThrow()
			expect(plan.id)
				.toBe('REQ-001')
			const reqDirPath = path.join(tempDir, '.engineering/req')
			const targetPath = path.join(tempDir, plan.path)

			const deps = {
				...defaultApplyCreatePlanDeps,
				publishViaHardLink: async (tempPathArg: string, targetPathArg: string) => {
					// Triggered from INSIDE this dependency, BEFORE delegating to the
					// real primitive: make a newly-visible Artifact file appear whose
					// frontmatter never decodes at all. The real hard link below
					// still succeeds; the managed chain identity and the published
					// path's own inode are both completely unaffected -- only the
					// set of visible Artifacts changed, in a way `collectVisibleIds`
					// alone cannot see.
					await fs.writeFile(path.join(reqDirPath, 'REQ-999.md'), 'not valid frontmatter at all\n')
					return defaultApplyCreatePlanDeps.publishViaHardLink(tempPathArg, targetPathArg)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('raced')

			// The retraction removed only the entry it could prove -- by inode
			// AND byte content -- was its own just-published file; the malformed
			// Artifact this invocation never authorized is left completely
			// untouched.
			await expect(fs.stat(targetPath)).rejects.toThrow()
			const malformedOnDisk = await fs.readFile(path.join(reqDirPath, 'REQ-999.md'), 'utf8')
			expect(malformedOnDisk)
				.toBe('not valid frontmatter at all\n')

			const leftoverTempFiles = (await fs.readdir(reqDirPath))
				.filter(name => name.includes('.tmp-'))
			expect(leftoverTempFiles)
				.toEqual([])
		})
	})

	// FINDING B (P1, eighteenth round): `applyCreatePlan` released the
	// temporary file's lease (`tempLease`) only after a successful,
	// non-throwing return from `runPublicationSteps` -- a bare `const natural
	// = await runPublicationSteps(...)`, with no surrounding `try`. Every
	// pre-publication re-check inside `runPublicationSteps`
	// (`verifyManagedDirectoryChain`'s `isSymlink`/`directoryIdentity`,
	// `verifyAllocationStillValid`'s reload, `targetExists`) can rethrow a
	// non-`ENOENT` `lstat` failure exactly like any other `lstat`-based check
	// in this package (`platform/fs-facts.ts`'s own `tryLstat`): once
	// `writeTempFileComplete` had already returned `tempLease`, a real
	// `EACCES`/`EIO` from the very FIRST post-write chain probe let that lease
	// escape completely unreleased as an uncaught rejection -- directly
	// contradicting `applyCreatePlan`'s own documented "released EXACTLY
	// ONCE" guarantee -- and the CLI's generic top-level `catch` then reported
	// exit `3` (an internal implementation defect) for what is, in fact, an
	// ordinary execution/permission failure (13-cli-contract.md exit `2`'s
	// own class).
	describe('escaped-exception lease finalization and error classification (Finding B, eighteenth round)', () => {
		it('releases the already-acquired temp-file lease exactly once and reports applied:false/incomplete (never a rejection) when a non-ENOENT chain probe throws immediately after a real temp write succeeds', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const probeError = Object.assign(new Error('permission denied'), { code: 'EACCES', syscall: 'lstat' })
			let tempWritten = false
			let probeThrown = false
			let releaseCallCount = 0

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					tempWritten = true
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								releaseCallCount++
								return real.lease.release()
							},
						},
					}
				},
				// The very first probe `runPublicationSteps` makes immediately
				// after the temporary write completes (`verifyManagedDirectoryChain`'s
				// own `isSymlink` re-check of the managed chain).
				isSymlink: async (target: string) => {
					if (tempWritten && !probeThrown) {
						probeThrown = true
						throw probeError
					}
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(probeThrown)
				.toBe(true)
			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
			expect(result.applied === false && result.message)
				.toContain(probeError.message)
			// Structured finalization: the temp-file lease -- already acquired by
			// the time the probe threw -- was released exactly once, never
			// skipped by the escaping exception.
			expect(releaseCallCount)
				.toBe(1)

			// No canonical publication occurred.
			await expect(fs.stat(targetPath)).rejects.toThrow()
		})

		it('control: still propagates a genuine programmer/invariant error (e.g. a TypeError) as a rejection, but only after releasing the already-acquired temp-file lease exactly once', async () => {
			const plan = computePlanOrThrow()
			let tempWritten = false
			let releaseCallCount = 0

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					tempWritten = true
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								releaseCallCount++
								return real.lease.release()
							},
						},
					}
				},
				isSymlink: async (target: string) => {
					if (tempWritten)
						throw new TypeError('invariant violated: unreachable state')
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			await expect(applyCreatePlan(plan, tempDir, deps))
				.rejects.toThrow(TypeError)
			expect(releaseCallCount)
				.toBe(1)
		})
	})

	// FINDING 2 (P2, nineteenth round, correcting the eighteenth round's own
	// fix; matching `application/init.ts`'s own identical finding and fix):
	// `isFsSystemError`'s prior bare `typeof error.code === 'string'` check
	// misclassified a Node internal argument/invariant error -- which routinely
	// carries an `ERR_`-prefixed string `.code` too, e.g. `ERR_INVALID_ARG_TYPE`
	// -- as an ordinary fs system error, silently downgrading a genuine
	// implementation defect from 13-cli-contract.md's exit `3` class to its
	// exit `2` class. This regression fails against that prior implementation
	// (which would resolve with `applied: false, outcome: 'incomplete'` instead
	// of rejecting) and passes only once the classifier also requires an
	// errno-mnemonic-shaped `.code` (`/^E[A-Z0-9]+$/`, which an
	// underscore-containing `ERR_...` code never matches) AND a string
	// `.syscall`, which a Node internal argument/invariant error never carries.
	describe('fs-system-error classification requires a real errno shape, not just a string `.code` (Finding 2, nineteenth round)', () => {
		it('propagates a Node internal argument/invariant error carrying an ERR_-prefixed `.code` (e.g. ERR_INVALID_ARG_TYPE) as a rejection -- never misclassified as an ordinary fs system error -- after releasing the already-acquired temp-file lease exactly once', async () => {
			const plan = computePlanOrThrow()
			let tempWritten = false
			let releaseCallCount = 0

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					tempWritten = true
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								releaseCallCount++
								return real.lease.release()
							},
						},
					}
				},
				isSymlink: async (target: string) => {
					if (tempWritten)
						throw Object.assign(new TypeError('bad internal argument'), { code: 'ERR_INVALID_ARG_TYPE' })
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			await expect(applyCreatePlan(plan, tempDir, deps))
				.rejects.toThrow('bad internal argument')
			expect(releaseCallCount)
				.toBe(1)
		})
	})

	// FINDING B (twenty-second round): the very first `targetExists`
	// pre-publication probe (`isRegularFile`/`isDirectory`/`isSymlink`, in that
	// order) `lstat`s `plan.path` directly -- if the canonical type directory
	// was replaced by a regular file since the plan was computed, that `lstat`
	// itself fails `ENOTDIR` (a path component is no longer a directory), a
	// real, non-`ENOENT` error production's `tryLstat` (`platform/fs-facts.ts`)
	// does not normalize. This is exactly as certain a proof of a broken
	// managed-directory chain as `verifyManagedDirectoryChain`'s own ordinary,
	// non-throwing `'rejected'` outcome for the identical condition -- before
	// this round, the escaping exception instead reached only
	// `applyCreatePlan`'s generic top-level `isFsSystemError` catch, which
	// cannot tell this PROVEN structural fact apart from a genuine `EACCES`/`EIO`
	// observation failure, and folded both alike into `applied: false, outcome:
	// 'incomplete'` (13-cli-contract.md exit `2`) -- silently downgrading a
	// proven race/rejection (exit `1`, `complete: true`) into a merely
	// "execution failed, retry" report. This regression fails against that
	// prior implementation (which reports `outcome: 'incomplete'`) and passes
	// only once `targetExistsOrChainRejected` classifies the escaping
	// `ENOTDIR` as `'rejected'` instead of letting it propagate.
	describe('a targetExists probe failure whose error code itself proves the managed chain was replaced is a domain rejection, never folded into incomplete (Finding B, twenty-second round)', () => {
		it('reports applied:false/rejected (never applied:false/incomplete) when the canonical type directory is replaced by a real regular file, causing the first targetExists probe to throw a real-shaped ENOTDIR', async () => {
			const plan = computePlanOrThrow()
			const typeDirPath = path.join(tempDir, '.engineering/req')
			await fs.writeFile(typeDirPath, 'a regular file where the canonical type directory should be')

			const result = await applyCreatePlan(plan, tempDir)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// The replacement file itself was never touched.
			const content = await fs.readFile(typeDirPath, 'utf8')
			expect(content)
				.toBe('a regular file where the canonical type directory should be')
		})

		it('control: still reports applied:false/incomplete when that same first targetExists probe throws EACCES instead (mere observation noise, not a proven structural fact)', async () => {
			const plan = computePlanOrThrow()
			const targetPath = path.join(tempDir, plan.path)
			const probeError = Object.assign(new Error('permission denied'), { code: 'EACCES', syscall: 'lstat' })

			const deps = {
				...defaultApplyCreatePlanDeps,
				isRegularFile: async (target: string) => {
					if (target === targetPath)
						throw probeError
					return defaultApplyCreatePlanDeps.isRegularFile(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
		})
	})

	// FINDING (twenty-third round): the twenty-second round's fix routed
	// `targetExists`'s own pre-publication probes through
	// `targetExistsOrChainRejected`, but explicitly left `verifyChainComponent`'s
	// own `isSymlink`/`directoryIdentity` probes as a documented residual gap --
	// they had the identical bare-call shape. Reproduction: the `.engineering`
	// chain-component check passes (it is re-verified against the real,
	// untouched directory), and only THEN -- strictly between that check and
	// the type directory's own component probe -- is `.engineering` itself
	// replaced by a regular file. The type directory's `isSymlink` probe then
	// `lstat`s a path (`.engineering/req`) whose ANCESTOR is no longer a
	// directory, a real, non-`ENOENT` `ENOTDIR` production's `tryLstat` does not
	// normalize. Before this round, that exception escaped `verifyChainComponent`
	// uncaught, all the way to `applyCreatePlan`'s generic top-level
	// `isFsSystemError` catch, which cannot tell this PROVEN structural fact
	// apart from a genuine `EACCES`/`EIO` observation failure -- reporting
	// `applied: false, outcome: 'incomplete'` (exit `2`) for what is, in fact, a
	// proven managed-directory-chain rejection (exit `1`, EF-FS-004).
	describe('a verifyChainComponent probe failure whose error code itself proves an ancestor of the component was replaced is a domain rejection, never folded into incomplete (Finding, twenty-third round)', () => {
		it('reports applied:false/rejected (never applied:false/incomplete) when `.engineering` is replaced by a real regular file strictly between the `.engineering` chain-component check and the type directory\'s own probe', async () => {
			const plan = computePlanOrThrow()
			const engineeringPath = path.join(tempDir, '.engineering')
			let mutated = false

			const deps = {
				...defaultApplyCreatePlanDeps,
				directoryIdentity: async (target: string) => {
					// Capture the REAL identity first (so `.engineering`'s own chain-
					// component check still passes -- it is bound to
					// `plan.engineeringIdentity`, and must match to reach the type
					// directory's own probe at all), THEN perform the replacement, so
					// the fault lands exactly between the two component checks, never
					// inside the first one.
					const real = await realDirectoryIdentity(target)
					if (!mutated && target === engineeringPath) {
						mutated = true
						await fs.rm(engineeringPath, { recursive: true, force: true })
						await fs.writeFile(engineeringPath, 'a regular file where .engineering should be')
					}
					return real
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// The replacement file itself was never touched.
			const content = await fs.readFile(engineeringPath, 'utf8')
			expect(content)
				.toBe('a regular file where .engineering should be')
		})

		it('control: still reports applied:false/incomplete when that same type directory probe throws EACCES instead (mere observation noise, not a proven structural fact)', async () => {
			const plan = computePlanOrThrow()
			const typeDirPath = path.join(tempDir, '.engineering/req')
			const probeError = Object.assign(new Error('permission denied'), { code: 'EACCES', syscall: 'lstat' })

			const deps = {
				...defaultApplyCreatePlanDeps,
				isSymlink: async (target: string) => {
					if (target === typeDirPath)
						throw probeError
					return defaultApplyCreatePlanDeps.isSymlink(target)
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('incomplete')
		})

		// Post-temp-write variant: the identical structural fault, injected at
		// the managed-chain re-check that runs AFTER the temporary file has
		// already been written (`runPublicationSteps`'s own re-check, immediately
		// before the "allocation still valid" check). This exercises a DIFFERENT
		// hazard than the pre-write variant above: by this point a temp-file
		// lease is held open, and every rejection path from here on must still
		// release it EXACTLY ONCE (13-cli-contract.md's own "released exactly
		// once" guarantee -- Finding 2, sixteenth/eighteenth rounds) and must
		// never let the ownership-proven cleanup attempt destructively touch the
		// foreign replacement now occupying `.engineering` (it is not this
		// invocation's own file, and `deleteOwnedTempFile`'s ownership proof must
		// correctly refuse to act on it).
		it('post-temp-write variant: releases the lease exactly once and never destructively touches the foreign replacement, still reporting rejected (not incomplete)', async () => {
			const plan = computePlanOrThrow()
			const engineeringPath = path.join(tempDir, '.engineering')
			let tempWritten = false
			let mutated = false
			let releaseCallCount = 0

			const deps = {
				...defaultApplyCreatePlanDeps,
				writeTempFileComplete: async (tempPathArg: string, bytes: Uint8Array) => {
					const real = await realWriteTempFileComplete(tempPathArg, bytes)
					if (real.outcome !== 'written')
						return real
					tempWritten = true
					return {
						outcome: 'written' as const,
						lease: {
							...real.lease,
							release: async () => {
								releaseCallCount++
								return real.lease.release()
							},
						},
					}
				},
				directoryIdentity: async (target: string) => {
					const real = await realDirectoryIdentity(target)
					// Only mutate once, and only strictly AFTER the temporary write has
					// already completed -- exercising the post-write chain re-check,
					// not the earlier pre-write ones this same override also observes.
					if (tempWritten && !mutated && target === engineeringPath) {
						mutated = true
						await fs.rm(engineeringPath, { recursive: true, force: true })
						await fs.writeFile(engineeringPath, 'a regular file where .engineering should be, post-write')
					}
					return real
				},
			}

			const result = await applyCreatePlan(plan, tempDir, deps)

			expect(result.applied)
				.toBe(false)
			expect(result.applied === false && result.outcome)
				.toBe('rejected')

			// The lease was released exactly once, regardless of the mid-flight
			// structural fault.
			expect(releaseCallCount)
				.toBe(1)

			// The foreign replacement now occupying `.engineering` was never
			// destructively touched by the ownership-proven cleanup attempt: its
			// content is exactly what this test wrote, untouched.
			const content = await fs.readFile(engineeringPath, 'utf8')
			expect(content)
				.toBe('a regular file where .engineering should be, post-write')
		})
	})
})
