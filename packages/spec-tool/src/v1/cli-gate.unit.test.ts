import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../cli'
import { runV1Cli } from './cli'
import { SpecClient } from './client'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-cli-gate-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return { root, client }
}
async function call(root: string, resource: string, operation: string, request: unknown = {}) {
	const response = await runV1Cli([resource, operation, '--root', root], {
		cwd: root,
		stdin: JSON.stringify(request),
	})
	expect(response.exitCode, `${resource}/${operation}: ${response.stderr}`)
		.toBe(0)
	expect(response.stderr)
		.toBe('')
	return JSON.parse(response.stdout) as Record<string, any>
}

describe('final resource-first CLI dispatch and error contract', () => {
	it('handles help, option validation, malformed JSON, unknown commands and human output', async () => {
		const { root } = await setup()
		for (const argv of [['--help'], ['-h'], ['--root', root, '--help']]) {
			const help = await runV1Cli(argv, { cwd: root, stdin: 'not JSON' })
			expect(help.exitCode)
				.toBe(0)
			expect(help.stdout)
				.toContain('workspace init|validate')
		}
		expect((await main(['--help'])).stdout)
			.toContain('clause create')
		for (const argv of [
			[],
			['workspace'],
			['workspace', 'validate', 'extra'],
			['--root'],
			['--root', '--format', 'workspace', 'init'],
			['--format'],
			['--format', 'xml', 'workspace', 'validate'],
			['--format=xml', 'workspace', 'validate'],
			['--surprise', 'workspace', 'validate'],
			['--root=', 'workspace', 'validate'],
			['artifact', 'create', '--root', root],
			['graph', 'unknown', '--root', root],
		]) {
			const response = await runV1Cli(argv, { cwd: root, stdin: '{}' })
			expect(response.exitCode)
				.toBe(1)
			expect(response.stdout)
				.toBe('')
			expect(JSON.parse(response.stderr).code)
				.toBe('invalid_request')
		}
		for (const stdin of ['[]', 'null', '42', '"string"', '{not json']) {
			const response = await runV1Cli(['graph', 'export', '--root', root], { cwd: root, stdin })
			expect(response.exitCode)
				.toBe(1)
			expect(JSON.parse(response.stderr).code)
				.toBe('invalid_request')
		}
		for (const resource of ['workspace', 'graph']) {
			const operation = resource === 'workspace' ? 'validate' : 'export'
			const response = await runV1Cli([resource, operation, '--root', root], {
				cwd: root,
				stdin: '{"unexpected":true}',
			})
			expect(JSON.parse(response.stderr).details.issues[0].reason)
				.toBe('unexpected')
		}
		const bad = await runV1Cli(['graph', 'get', '--root', root, '--format', 'human'], {
			cwd: root,
			stdin: '{"id":"malformed"}',
		})
		expect(bad.exitCode)
			.toBe(1)
		expect(bad.stderr)
			.toContain('invalid_request: ')
		const human = await runV1Cli(['graph', 'list', '--root', root, '--format=human'], { cwd: root })
		expect(human.exitCode)
			.toBe(0)
		expect(human.stdout)
			.toContain('Revision: ')
		await writeFile(join(root, '.spec', 'illegal'), '')
		const invalidHuman = await runV1Cli(['workspace', 'validate', '--root', root, '--format', 'human'], {
			cwd: root,
			stdin: '{}',
		})
		expect(invalidHuman.exitCode)
			.toBe(1)
		expect(invalidHuman.stderr)
			.toContain('Workspace invalid')
	})

	it('dispatches all remaining CRUD/reorder/reparent and graph variants', async () => {
		const { root, client } = await setup()
		const run = (resource: string, operation: string, request: unknown = {}) =>
			call(root, resource, operation, request)
		const revision = async () => (await client.graph.export()).revision
		const a = await run('feature', 'create', { title: 'A', summary: 'A', expectedRevision: await revision() })
		const featureA = a.changedNodes[0].id as string
		const b = await run('feature', 'create', { title: 'B', summary: 'B', expectedRevision: await revision() })
		const featureB = b.changedNodes[0].id as string
		const s = await run('story', 'create', {
			title: 'Intent',
			actor: 'Buyer',
			goal: 'Find',
			value: 'Save time',
			motivates: [featureA],
			expectedRevision: await revision(),
		})
		const sid = s.changedNodes[0].id as string
		const r = await run('rule', 'create', { ownerId: featureA, statement: 'Must work', expectedRevision: await revision() })
		const rid = r.changedNodes[0].id as string
		const c = await run('contract', 'create', {
			title: 'External',
			summary: 'Shared',
			constrains: [featureB],
			expectedRevision: await revision(),
		})
		const cid = c.changedNodes[0].id as string
		const d = await run('contract', 'create', {
			title: 'Second external',
			summary: 'Shared',
			constrains: [featureA],
			expectedRevision: await revision(),
		})
		const did = d.changedNodes[0].id as string
		const clause = await run('clause', 'create', {
			ownerId: cid,
			statement: 'Portable',
			expectedRevision: await revision(),
		})
		const clauseId = clause.changedNodes[0].id as string
		const scenario = await run('scenario', 'create', {
			title: 'Flow',
			steps: [{ type: 'when', text: 'I request' }, { type: 'then', text: 'I receive' }],
			demonstrates: [featureB],
			expectedRevision: await revision(),
		})
		const scenarioId = scenario.changedNodes[0].id as string
		expect((await run('graph', 'list', { kind: 'clause' })).data)
			.toEqual([{ id: clauseId, kind: 'clause' }])
		expect((await run('graph', 'get', { id: scenarioId })).data.kind)
			.toBe('scenario')
		expect((await run('graph', 'incoming', { id: featureB, type: 'constrains' })).data)
			.toContainEqual({ from: cid, type: 'constrains', to: featureB })
		expect((await run('graph', 'outgoing', { id: clauseId })).data)
			.toHaveLength(1)
		await run('feature', 'update', {
			id: featureB,
			changes: { title: 'Renamed B' },
			expectedRevision: await revision(),
		})
		await run('story', 'update', {
			id: sid,
			changes: { value: 'More time' },
			expectedRevision: await revision(),
		})
		await run('rule', 'update', {
			id: rid,
			changes: { statement: 'Updated' },
			expectedRevision: await revision(),
		})
		await run('clause', 'update', {
			id: clauseId,
			changes: { statement: 'Updated policy' },
			expectedRevision: await revision(),
		})
		await run('contract', 'update', {
			id: cid,
			changes: { summary: 'Updated contract' },
			expectedRevision: await revision(),
		})
		await run('scenario', 'update', {
			id: scenarioId,
			changes: { title: 'Updated flow' },
			expectedRevision: await revision(),
		})
		await run('graph', 'set-relation-targets', {
			sourceId: scenarioId,
			type: 'demonstrates',
			targets: [clauseId],
			expectedRevision: await revision(),
		})
		await run('graph', 'set-relation-targets', {
			sourceId: cid,
			type: 'constrains',
			targets: [featureA],
			expectedRevision: await revision(),
		})
		await run('graph', 'set-relation-targets', {
			sourceId: clauseId,
			type: 'constrains',
			targets: [rid],
			expectedRevision: await revision(),
		})
		await run('graph', 'set-relation-targets', {
			sourceId: clauseId,
			type: 'constrains',
			targets: null,
			expectedRevision: await revision(),
		})
		await run('graph', 'set-relation-targets', {
			sourceId: sid,
			type: 'motivates',
			targets: [featureB],
			expectedRevision: await revision(),
		})
		await run('scenario', 'delete', { id: scenarioId, expectedRevision: await revision() })
		await run('story', 'delete', { id: sid, expectedRevision: await revision() })
		await run('rule', 'reparent', {
			id: rid,
			newOwnerId: featureB,
			expectedRevision: await revision(),
		})
		await run('rule', 'reorder', {
			ownerId: featureB,
			orderedIds: [rid],
			expectedRevision: await revision(),
		})
		await run('clause', 'reparent', {
			id: clauseId,
			newOwnerId: did,
			expectedRevision: await revision(),
		})
		await run('clause', 'reorder', {
			ownerId: did,
			orderedIds: [clauseId],
			expectedRevision: await revision(),
		})
		await run('clause', 'delete', { id: clauseId, expectedRevision: await revision() })
		await run('contract', 'delete', { id: cid, expectedRevision: await revision() })
		await run('contract', 'delete', { id: did, expectedRevision: await revision() })
		await run('rule', 'delete', { id: rid, expectedRevision: await revision() })
		await run('feature', 'delete', { id: featureA, expectedRevision: await revision() })
		await run('feature', 'delete', { id: featureB, expectedRevision: await revision() })
		expect((await run('graph', 'export')).data.nodes)
			.toEqual([])
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})
})
