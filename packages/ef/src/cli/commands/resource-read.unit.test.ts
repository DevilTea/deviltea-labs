import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runResourceReadCommand } from './resource-read'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`
const GITIGNORE = '.cache/\n.generated/\n.tmp/\n.lock\n'
const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for CLI resource-read tests.
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

function requirementMdWithResource(id: string, location: string): string {
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Example Requirement
status: active
summary: A minimal example requirement used for CLI resource-read tests.
tags: []
relations: []
resources:
  - type: example
    location: ${location}
    role: evidence
    media_type: application/json
    normative: false
    description: An example resource.
---

## Requirement

The system must do something specific and testable.

## Rationale

Because it is needed.

## Acceptance Criteria

- The system behaves as specified.
`
}

async function writeFile(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

describe('runResourceReadCommand', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-resource-')))
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	function deps() {
		return { cwd: root, executor: createGitExecutor() }
	}

	async function setupProject(): Promise<void> {
		await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
	}

	it('reports exit 2 when no EF project can be discovered', async () => {
		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/REQ-001/example.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('writes the exact raw bytes with no trailing newline and exits 0 on success', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		const rawBytes = Buffer.from('{"no-trailing-newline":true}', 'utf8')
		await writeFile(root, location, rawBytes)

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(0)
		expect(Buffer.from(outcome.stdout as Uint8Array))
			.toEqual(rawBytes)
		expect(outcome.stderr)
			.toBe('')
	})

	it('preserves exact binary bytes (not decoded as text)', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		const binaryBytes = Buffer.from([0x00, 0xFF, 0x10, 0xAB, 0x7F, 0x80])
		await writeFile(root, location, binaryBytes)

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(0)
		expect(Buffer.from(outcome.stdout as Uint8Array))
			.toEqual(binaryBytes)
	})

	it('exits 2 when the owner Artifact does not exist', async () => {
		await setupProject()
		const outcome = await runResourceReadCommand('REQ-999', '.engineering/resources/REQ-999/example.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
		expect(outcome.stderr.length)
			.toBeGreaterThan(0)
	})

	it('exits 2 when the owner exists but declares no descriptor with the exact location', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, location, 'content')

		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/REQ-001/other.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 2 when the location is declared by a different Artifact than the supplied owner', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, '.engineering/req/REQ-002.md', requirementMdWithResource('REQ-002', '.engineering/resources/REQ-002/example.json')
			.replace('REQ-002', 'REQ-002'))
		await writeFile(root, location, 'content')
		await writeFile(root, '.engineering/resources/REQ-002/example.json', 'other content')

		const outcome = await runResourceReadCommand('REQ-002', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 1, empty stdout, when two Artifacts declare the same local path, whichever owner is used to read it (EF-RES-009 exclusive ownership)', async () => {
		await setupProject()
		// `REQ-001` legitimately declares a location inside its own managed
		// Resource directory. `REQ-002` improperly declares the identical
		// location (itself also a repository-integrity violation, EF-RES-014,
		// for `REQ-002`'s own descriptor -- but that is irrelevant to this
		// regression: the point is that reading through `REQ-001`, whose own
		// descriptor is perfectly well-formed, must still be rejected because
		// the project-wide ownership index shows the location has two owners).
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, '.engineering/req/REQ-002.md', requirementMdWithResource('REQ-002', location))
		await writeFile(root, location, 'content')

		const viaLegitimateOwner = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(viaLegitimateOwner.exitCode)
			.toBe(1)
		expect(viaLegitimateOwner.stdout)
			.toEqual(new Uint8Array(0))

		const viaRogueOwner = await runResourceReadCommand('REQ-002', location, {}, deps())
		expect(viaRogueOwner.exitCode)
			.toBe(1)
		expect(viaRogueOwner.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('exits 1 and does not serve the file when a declared location differs only in letter case from the on-disk entry (case-insensitive filesystem)', async (ctx) => {
		await setupProject()
		const actualLocation = '.engineering/resources/REQ-001/example.json'
		const declaredLocation = '.engineering/resources/REQ-001/Example.JSON'
		await writeFile(root, actualLocation, 'content')

		// This regression is only meaningful on a filesystem that resolves the
		// wrong-case path to the same on-disk entry; skip on a genuinely
		// case-sensitive filesystem where the scenario cannot arise.
		const resolvesCaseInsensitively = await fs.stat(path.join(root, declaredLocation))
			.then(() => true, () => false)
		if (!resolvesCaseInsensitively) {
			ctx.skip()
			return
		}

		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', declaredLocation))

		const outcome = await runResourceReadCommand('REQ-001', declaredLocation, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('exits 1 when the descriptor exists but the managed local file is missing', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		// Intentionally never write the file at `location`.

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('exits 1 when the managed path is a forbidden symlink', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		const realFile = path.join(root, '.engineering/resources/REQ-001/real.json')
		await fs.mkdir(path.dirname(realFile), { recursive: true })
		await fs.writeFile(realFile, 'content')
		await fs.symlink(realFile, path.join(root, location))

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
	})

	it('exits 1 when an ancestor directory of the managed path is a symlink, even though the final component is an ordinary file', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-001/passwd'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))

		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-ancestor-')))
		try {
			await fs.writeFile(path.join(outsideDir, 'passwd'), 'root:x:0:0::/root:/bin/sh\n')
			// Replace the owner's managed Resource directory itself with a symlink
			// to an external directory. The final `passwd` entry, reached through
			// that symlinked ancestor, is a perfectly ordinary regular file --
			// `lstat` on the final component alone would never catch this; only
			// `lstat`-ing every ancestor component does.
			await fs.mkdir(path.join(root, '.engineering/resources'), { recursive: true })
			await fs.symlink(outsideDir, path.join(root, '.engineering/resources/REQ-001'))

			const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
			expect(outcome.exitCode)
				.toBe(1)
			expect(outcome.stdout)
				.toEqual(new Uint8Array(0))
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('exits 1 and never reads outside the project root when a descriptor location contains a \'..\' segment (EF-RES-007)', async () => {
		await setupProject()
		const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-outside-')))
		try {
			const secretPath = path.join(outsideDir, 'secret.json')
			await fs.writeFile(secretPath, '{"secret":true}')
			// `root` and `outsideDir` are independent `mkdtemp` siblings under the
			// OS temp directory, so the relative path between them is guaranteed to
			// climb out of `root` via one or more '..' segments without depending
			// on any particular fixed depth.
			const location = path.relative(root, secretPath)
				.split(path.sep)
				.join('/')
			await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))

			const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
			expect(outcome.exitCode)
				.toBe(1)
			expect(outcome.stdout)
				.toEqual(new Uint8Array(0))
		}
		finally {
			await fs.rm(outsideDir, { recursive: true, force: true })
		}
	})

	it('exits 1 when the descriptor location is not beneath the owner\'s managed Resource directory (EF-RES-014)', async () => {
		await setupProject()
		const location = '.engineering/resources/REQ-999/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, location, 'content')

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('exits 2 when the project snapshot cannot be loaded (read-error, not engineering-missing)', async () => {
		await setupProject()
		// `.gitignore` is read unconditionally by `loadSnapshotFromWorkingTree`
		// but never inspected by project discovery/resolution, so replacing it
		// with a directory lets `resolveProject` succeed while the snapshot load
		// itself fails with `read-error` (mirrors
		// `application/snapshot.unit.test.ts`'s own `read-error` fixture).
		await fs.rm(path.join(root, '.engineering', '.gitignore'))
		await fs.mkdir(path.join(root, '.engineering', '.gitignore'))

		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/REQ-001/example.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
		expect(outcome.stderr)
			.toContain('EF project snapshot could not be loaded')
	})

	it('exits 1 for an external (http/https) location matched by descriptor, treated as a missing managed local file', async () => {
		await setupProject()
		const location = 'https://example.com/spec.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
		expect(outcome.stderr)
			.toBe(`Location '${location}' is an external URL, not a managed local file.\n`)
	})

	it('does not accept --format (has no format option in its input shape at all)', () => {
		// Structural guarantee: `ResourceReadOptions` has no `format` field, so
		// `program.ts` rejecting `--format` for this command is enforced by
		// simply never registering that option on it (see program.ts tests).
		const options: import('./resource-read').ResourceReadOptions = { project: undefined }
		expect('format' in options)
			.toBe(false)
	})
})
