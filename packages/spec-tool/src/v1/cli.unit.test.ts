import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isV1Command, runV1Cli } from './cli'
import { SpecClient } from './client'

const roots: string[] = []

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-cli-'))
	roots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('v1 resource-first CLI adapter', () => {
	it('supports exact JSON init and Feature/Story lifecycle using the same SpecClient semantics', async () => {
		const root = await tempRoot()
		const io = { cwd: root, stdin: '{}' }
		const init = await runV1Cli(['--root', root, 'workspace', 'init'], io)
		expect(init)
			.toMatchObject({ exitCode: 0, stderr: '' })
		const revision = JSON.parse(init.stdout).revision as string
		expect(await readFile(join(root, '.spec/spec.yaml'), 'utf8'))
			.toBe('formatVersion: 1\n')
		const feature = await runV1Cli(['feature', 'create', '--root', root], {
			...io,
			stdin: JSON.stringify({ title: 'Search', summary: 'Find items', expectedRevision: revision }),
		})
		expect(feature.exitCode)
			.toBe(0)
		const created = JSON.parse(feature.stdout) as { revision: string, changedNodes: Array<{ id: string }> }
		const client = new SpecClient(root)
		expect((await client.graph.export()).revision)
			.toBe(created.revision)
		const story = await runV1Cli(['--root', root, 'story', 'create'], {
			...io,
			stdin: JSON.stringify({
				title: 'Find a product',
				actor: 'Buyer',
				goal: 'Find product',
				value: 'Save time',
				motivates: [created.changedNodes[0]!.id],
				expectedRevision: created.revision,
			}),
		})
		expect(story.exitCode)
			.toBe(0)
		const storyResponse = JSON.parse(story.stdout) as { revision: string, changedNodes: Array<{ id: string }>, changedEdges: { added: unknown[] } }
		expect(storyResponse.changedEdges.added)
			.toHaveLength(1)
		const graph = await runV1Cli(['graph', 'export', `--root=${root}`], io)
		expect(JSON.parse(graph.stdout))
			.toEqual(await client.graph.export())
		const list = await runV1Cli(['graph', 'list', '--root', root], { ...io, stdin: '{"kind":"story"}' })
		expect(JSON.parse(list.stdout))
			.toEqual(await client.graph.list({ kind: 'story' }))
		const deleteStory = await runV1Cli(['story', 'delete', '--root', root], {
			...io,
			stdin: JSON.stringify({ id: storyResponse.changedNodes[0]!.id, expectedRevision: storyResponse.revision }),
		})
		expect(JSON.parse(deleteStory.stdout).deletedIds)
			.toEqual([storyResponse.changedNodes[0]!.id])
	})

	it('returns structured JSON error on stderr with binary failure status', async () => {
		const root = await tempRoot()
		const init = await runV1Cli(['workspace', 'init', '--root', root], { cwd: root, stdin: '{}' })
		const revision = JSON.parse(init.stdout).revision as string
		const invalid = await runV1Cli(['feature', 'create', '--root', root], {
			cwd: root,
			stdin: JSON.stringify({ title: 'Search', summary: 'Find', expectedRevision: revision, id: 'provided' }),
		})
		expect(invalid.exitCode)
			.toBe(1)
		expect(invalid.stdout)
			.toBe('')
		expect(JSON.parse(invalid.stderr))
			.toMatchObject({
				code: 'invalid_request',
				details: { issues: [{ path: 'request.id', reason: 'unexpected' }] },
			})
		const missing = await runV1Cli(['graph', 'get', '--root', root], { cwd: root, stdin: '{"id":"bad"}' })
		expect(JSON.parse(missing.stderr).code)
			.toBe('invalid_request')
		const badJson = await runV1Cli(['graph', 'get', '--root', root], { cwd: root, stdin: '{broken' })
		expect(JSON.parse(badJson.stderr).code)
			.toBe('invalid_request')
		expect((await runV1Cli(['graph', 'export', '--root', root], { cwd: root, stdin: '{}' })).exitCode)
			.toBe(0)
	})

	it('rejects invalid state through normal graph reads, but exposes validation diagnostics', async () => {
		const root = await tempRoot()
		await runV1Cli(['workspace', 'init', '--root', root], { cwd: root, stdin: '{}' })
		await writeFile(join(root, '.spec/extra'), 'unknown')
		const validate = await runV1Cli(['workspace', 'validate', '--root', root], { cwd: root, stdin: '{}' })
		expect(validate.exitCode)
			.toBe(1)
		expect(validate.stdout)
			.toBe('')
		expect(JSON.parse(validate.stderr))
			.toMatchObject({ valid: false, issues: expect.any(Array) })
		const read = await runV1Cli(['graph', 'export', '--root', root], { cwd: root, stdin: '{}' })
		expect(read.exitCode)
			.toBe(1)
		expect(JSON.parse(read.stderr).code)
			.toBe('validation_failed')
	})

	it('resolves --root ahead of Git toplevel and requires either a root or Git repository', async () => {
		const root = await tempRoot()
		const other = await tempRoot()
		const outside = await runV1Cli(['workspace', 'validate'], { cwd: other, stdin: '{}' })
		expect(outside.exitCode)
			.toBe(1)
		expect(JSON.parse(outside.stderr).code)
			.toBe('invalid_request')
		execFileSync('git', ['init', '-q', root], { encoding: 'utf8' })
		const nested = join(root, 'nested')
		await mkdir(nested)
		const init = await runV1Cli(['workspace', 'init'], { cwd: nested, stdin: '{}' })
		expect(init.exitCode)
			.toBe(0)
		const explicit = await runV1Cli(['workspace', 'validate', '--root', other], { cwd: nested, stdin: '{}' })
		expect(JSON.parse(explicit.stderr).valid)
			.toBe(false)
		expect((await runV1Cli(['workspace', 'validate'], { cwd: nested, stdin: '{}' })).exitCode)
			.toBe(0)
	})

	it('offers human output only via --format human and dispatches new namespaces without hiding legacy commands', async () => {
		const root = await tempRoot()
		await runV1Cli(['workspace', 'init', '--root', root], { cwd: root, stdin: '{}' })
		const human = await runV1Cli(['workspace', 'validate', '--root', root, '--format', 'human'], { cwd: root, stdin: '{}' })
		expect(human)
			.toMatchObject({ exitCode: 0, stderr: '' })
		expect(human.stdout)
			.toMatch(/^Workspace valid\nRevision: [0-9a-f]{64}\n$/)
		expect(isV1Command(['--root', root, 'graph', 'get']))
			.toBe(true)
		expect(isV1Command(['artifact', 'create']))
			.toBe(false)
		expect((await runV1Cli(['--root', root, 'workspace', 'init'], { cwd: root, stdin: '{}' })).exitCode)
			.toBe(1)
	})
})
