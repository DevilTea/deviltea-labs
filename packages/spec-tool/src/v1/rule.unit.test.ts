import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runV1Cli } from './cli'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'
import { replaceSemanticFiles } from './storage'

const roots: string[] = []
async function setup(): Promise<SpecClient> {
	const root = await mkdtemp(join(tmpdir(), 'spec-rule-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return client
}
async function feature(client: SpecClient, title: string) {
	return client.feature.create({ title, summary: title, expectedRevision: (await client.graph.export()).revision })
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('frozen v1 Feature-local Rule resource', () => {
	it('creates, reads, updates and deletes globally addressable Rule nodes', async () => {
		const client = await setup()
		const owner = await feature(client, 'Search')
		const ownerId = owner.changedNodes[0]!.id
		const created = await client.rule.create({ ownerId, statement: 'Order results', expectedRevision: owner.revision })
		const rule = created.changedNodes[0]!
		expect(rule)
			.toMatchObject({ kind: 'rule', statement: 'Order results', ownerId, source: { path: `.spec/features/${ownerId}.md` } })
		expect((await client.graph.get({ id: rule.id })).data)
			.toEqual(rule)
		expect((await client.graph.list({ kind: 'rule' })).data)
			.toEqual([{ id: rule.id, kind: 'rule' }])
		const path = join(client.root, `.spec/features/${ownerId}.md`)
		const initial = await readFile(path, 'utf8')
		expect(initial)
			.toContain(`id: ${rule.id}\n    statement: Order results`)
		await writeFile(path, `${initial}\n# Human note\nKeep me.\n`)
		const noOp = await client.rule.update({ id: rule.id, changes: { statement: 'Order results' }, expectedRevision: created.revision })
		expect(noOp.changedNodes)
			.toEqual([])
		expect(noOp.revision)
			.toBe(created.revision)
		const updated = await client.rule.update({ id: rule.id, changes: { statement: 'Sort by id' }, expectedRevision: noOp.revision })
		expect(updated.changedNodes)
			.toEqual([expect.objectContaining({ id: rule.id, statement: 'Sort by id' })])
		expect(updated.revision).not.toBe(noOp.revision)
		expect(await readFile(path, 'utf8'))
			.toContain('# Human note\nKeep me.\n')
		await expect(client.feature.delete({ id: ownerId, expectedRevision: updated.revision }))
			.rejects.toMatchObject({ code: 'invalid_request' })
		const deleted = await client.rule.delete({ id: rule.id, expectedRevision: updated.revision })
		expect(deleted.deletedIds)
			.toEqual([rule.id])
		expect((await client.feature.delete({ id: ownerId, expectedRevision: deleted.revision })).deletedIds)
			.toEqual([ownerId])
	})

	it('reorders with complete sets without semantic revision changes', async () => {
		const client = await setup()
		const owner = await feature(client, 'Search')
		const ownerId = owner.changedNodes[0]!.id
		const one = await client.rule.create({ ownerId, statement: 'First', expectedRevision: owner.revision })
		const two = await client.rule.create({ ownerId, statement: 'Second', expectedRevision: one.revision })
		const a = one.changedNodes[0]!.id
		const b = two.changedNodes[0]!.id
		for (const orderedIds of [[a], [a, a], [a, newUuidV7()]]) {
			await expect(client.rule.reorder({ ownerId, orderedIds, expectedRevision: two.revision }))
				.rejects.toMatchObject({ code: 'invalid_request' })
		}
		const moved = await client.rule.reorder({ ownerId, orderedIds: [b, a], expectedRevision: two.revision })
		expect(moved)
			.toEqual({ revision: two.revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } })
		const content = await readFile(join(client.root, `.spec/features/${ownerId}.md`), 'utf8')
		expect(content.indexOf(b))
			.toBeLessThan(content.indexOf(a))
	})

	it('reparents a stable Rule to another Feature tail and preserves both bodies', async () => {
		const client = await setup()
		const source = await feature(client, 'Source')
		const target = await feature(client, 'Target')
		const from = source.changedNodes[0]!.id
		const to = target.changedNodes[0]!.id
		const moving = await client.rule.create({ ownerId: from, statement: 'Moving', expectedRevision: target.revision })
		const already = await client.rule.create({ ownerId: to, statement: 'Existing', expectedRevision: moving.revision })
		const ruleId = moving.changedNodes[0]!.id
		const fromPath = join(client.root, `.spec/features/${from}.md`)
		const toPath = join(client.root, `.spec/features/${to}.md`)
		await writeFile(fromPath, `${await readFile(fromPath, 'utf8')}\nSource note.\n`)
		await writeFile(toPath, `${await readFile(toPath, 'utf8')}\nTarget note.\n`)
		const moved = await client.rule.reparent({ id: ruleId, newOwnerId: to, expectedRevision: already.revision })
		expect(moved.changedNodes)
			.toEqual([expect.objectContaining({ id: ruleId, kind: 'rule', ownerId: to })])
		expect(moved.revision).not.toBe(already.revision)
		const targetContent = await readFile(toPath, 'utf8')
		expect(targetContent.indexOf(already.changedNodes[0]!.id))
			.toBeLessThan(targetContent.indexOf(ruleId))
		expect(targetContent)
			.toContain('Target note.')
		expect(await readFile(fromPath, 'utf8'))
			.toContain('Source note.')
		expect((await client.rule.reparent({ id: ruleId, newOwnerId: to, expectedRevision: moved.revision })).revision)
			.toBe(moved.revision)
		await expect(client.rule.reparent({ id: ruleId, newOwnerId: from, expectedRevision: already.revision }))
			.rejects.toMatchObject({ code: 'revision_conflict' })
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('rejects duplicate Rule IDs across Features and invalid embedded schemas', async () => {
		const client = await setup()
		const first = await feature(client, 'One')
		const second = await feature(client, 'Two')
		const id = first.changedNodes[0]!.id
		const otherId = second.changedNodes[0]!.id
		const added = await client.rule.create({ ownerId: id, statement: 'Only one', expectedRevision: second.revision })
		const ruleId = added.changedNodes[0]!.id
		const path = join(client.root, `.spec/features/${otherId}.md`)
		const pristine = await readFile(path, 'utf8')
		await writeFile(path, pristine.replace('rules: []', `rules:\n  - id: ${ruleId}\n    statement: Copied`))
		expect((await client.workspace.validate()).issues)
			.toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'duplicate' })]))
		for (const item of [`  - statement: Backwards\n    id: ${newUuidV7()}`, `  - id: ${newUuidV7()}\n    statement: ""`, `  - id: ${newUuidV7()}\n    statement: Okay\n    extra: illegal`]) {
			await writeFile(path, pristine.replace('rules: []', `rules:\n${item}`))
			expect((await client.workspace.validate()).valid)
				.toBe(false)
		}
		await writeFile(path, pristine)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('rolls back both original files when post-publish verification fails', async () => {
		const client = await setup()
		const a = await feature(client, 'First')
		const b = await feature(client, 'Second')
		const paths = [a.changedNodes[0]!.source.path, b.changedNodes[0]!.source.path]
		const previous = await Promise.all(paths.map(path => readFile(join(client.root, path), 'utf8')))
		await expect(replaceSemanticFiles(client.root, [
			{ path: paths[0]!, content: 'replaced first' },
			{ path: paths[1]!, content: 'replaced second' },
		], async () => { throw new Error('injected verification failure') }))
			.rejects.toThrow('injected verification failure')
		expect(await Promise.all(paths.map(path => readFile(join(client.root, path), 'utf8'))))
			.toEqual(previous)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('exposes Rule operations through JSON-stdin CLI', async () => {
		const client = await setup()
		const owner = await feature(client, 'CLI owner')
		const ownerId = owner.changedNodes[0]!.id
		const created = await runV1Cli(['rule', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({ ownerId, statement: 'CLI rule', expectedRevision: owner.revision }),
		})
		expect(created.exitCode)
			.toBe(0)
		expect(created.stderr)
			.toBe('')
		const result = JSON.parse(created.stdout) as { revision: string, changedNodes: Array<{ id: string }> }
		const id = result.changedNodes[0]!.id
		expect((await client.graph.get({ id })).data)
			.toMatchObject({ kind: 'rule', ownerId, statement: 'CLI rule' })
		const malformed = await runV1Cli(['rule', 'create', '--root', client.root], { cwd: client.root, stdin: '{}' })
		expect(malformed.exitCode)
			.toBe(1)
		expect(malformed.stdout)
			.toBe('')
		expect(JSON.parse(malformed.stderr).code)
			.toBe('invalid_request')
		const deleted = await runV1Cli(['rule', 'delete', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({ id, expectedRevision: result.revision }),
		})
		expect(JSON.parse(deleted.stdout).deletedIds)
			.toEqual([id])
	})
})
