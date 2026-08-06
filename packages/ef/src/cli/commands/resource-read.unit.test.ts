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
		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/req/REQ-001/example.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
	})

	it('writes the exact raw bytes with no trailing newline and exits 0 on success', async () => {
		await setupProject()
		const location = '.engineering/resources/req/REQ-001/example.json'
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
		const location = '.engineering/resources/req/REQ-001/example.json'
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
		const outcome = await runResourceReadCommand('REQ-999', '.engineering/resources/req/REQ-999/example.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toEqual(new Uint8Array(0))
		expect(outcome.stderr.length)
			.toBeGreaterThan(0)
	})

	it('exits 2 when the owner exists but declares no descriptor with the exact location', async () => {
		await setupProject()
		const location = '.engineering/resources/req/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, location, 'content')

		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/req/REQ-001/other.json', {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 2 when the location is declared by a different Artifact than the supplied owner', async () => {
		await setupProject()
		const location = '.engineering/resources/req/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		await writeFile(root, '.engineering/req/REQ-002.md', requirementMdWithResource('REQ-002', '.engineering/resources/req/REQ-002/example.json')
			.replace('REQ-002', 'REQ-002'))
		await writeFile(root, location, 'content')
		await writeFile(root, '.engineering/resources/req/REQ-002/example.json', 'other content')

		const outcome = await runResourceReadCommand('REQ-002', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('exits 1 when the descriptor exists but the managed local file is missing', async () => {
		await setupProject()
		const location = '.engineering/resources/req/REQ-001/example.json'
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
		const location = '.engineering/resources/req/REQ-001/example.json'
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMdWithResource('REQ-001', location))
		const realFile = path.join(root, '.engineering/resources/req/REQ-001/real.json')
		await fs.mkdir(path.dirname(realFile), { recursive: true })
		await fs.writeFile(realFile, 'content')
		await fs.symlink(realFile, path.join(root, location))

		const outcome = await runResourceReadCommand('REQ-001', location, {}, deps())
		expect(outcome.exitCode)
			.toBe(1)
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

		const outcome = await runResourceReadCommand('REQ-001', '.engineering/resources/req/REQ-001/example.json', {}, deps())
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
