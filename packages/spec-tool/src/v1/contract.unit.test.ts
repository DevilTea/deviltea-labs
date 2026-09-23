import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runV1Cli } from './cli'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'

const roots: string[] = []
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-contract-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return client
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})
async function feature(client: SpecClient, title: string) {
	return client.feature.create({ title, summary: title, expectedRevision: (await client.graph.export()).revision })
}
async function contract(client: SpecClient, title: string, constrains: string[]) {
	return client.contract.create({
		title,
		summary: `Shared authority: ${title}`,
		constrains,
		expectedRevision: (await client.graph.export()).revision,
	})
}
function noChanges(revision: string) {
	return { revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } }
}

describe('frozen v1 standalone Contract and embedded Clause', () => {
	it('persists standalone Contract with canonical fields and validates Feature-only 1..N scope', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const target = f.changedNodes[0]!.id
		const rule = await client.rule.create({
			ownerId: target,
			statement: 'Search rule',
			expectedRevision: f.revision,
		})
		const ruleId = rule.changedNodes[0]!.id
		await expect(client.contract.create({
			title: 'Empty',
			summary: 'none',
			constrains: [],
			expectedRevision: rule.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		await expect(contract(client, 'Invalid', [ruleId]))
			.rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'target_kind' } })
		const created = await contract(client, 'Shared', [target])
		const node = created.changedNodes[0]!
		expect(node)
			.toMatchObject({
				kind: 'contract',
				title: 'Shared',
				summary: 'Shared authority: Shared',
				source: { path: `.spec/contracts/${node.id}.md` },
			})
		expect(created.changedEdges.added)
			.toEqual([{ from: node.id, type: 'constrains', to: target }])
		const file = join(client.root, node.source.path)
		expect((await readFile(file, 'utf8')).startsWith(
			`---\nid: ${node.id}\ntitle: Shared\nsummary: "Shared authority: Shared"\nclauses: []\nconstrains:\n`,
		))
			.toBe(true)
		expect((await client.graph.get({ id: node.id })).data)
			.toEqual(node)
		expect((await client.graph.list({ kind: 'contract' })).data)
			.toEqual([
				{ id: node.id, kind: 'contract', title: 'Shared' },
			])
		expect((await client.graph.outgoing({ id: node.id, type: 'constrains' })).data)
			.toEqual([
				{ from: node.id, type: 'constrains', to: target },
			])
		expect((await client.workspace.validate()).valid)
			.toBe(true)
		await writeFile(file, `${await readFile(file, 'utf8')}\n## Nonsemantic human note\nPreserve exact body.\n`)
		const updated = await client.contract.update({
			id: node.id,
			changes: { summary: 'Revised scope' },
			expectedRevision: created.revision,
		})
		expect(updated.changedNodes)
			.toEqual([expect.objectContaining({ id: node.id, summary: 'Revised scope' })])
		expect(await readFile(file, 'utf8'))
			.toContain('## Nonsemantic human note\nPreserve exact body.\n')
		expect(await client.contract.update({
			id: node.id,
			changes: {},
			expectedRevision: updated.revision,
		}))
			.toEqual(noChanges(updated.revision))
	})

	it('materializes Clause inherited effective edges, and changes them with Contract scope', async () => {
		const client = await setup()
		const first = await feature(client, 'Alpha')
		const second = await feature(client, 'Beta')
		const a = first.changedNodes[0]!.id
		const b = second.changedNodes[0]!.id
		const c = await contract(client, 'Global', [a])
		const ownerId = c.changedNodes[0]!.id
		const created = await client.clause.create({
			ownerId,
			statement: 'Must support feature',
			expectedRevision: c.revision,
		})
		const id = created.changedNodes[0]!.id
		expect(created.changedNodes[0])
			.toMatchObject({
				id,
				kind: 'clause',
				statement: 'Must support feature',
				ownerId,
				source: { path: `.spec/contracts/${ownerId}.md` },
			})
		expect(created.changedEdges.added)
			.toEqual([{ from: id, type: 'constrains', to: a }])
		expect((await client.graph.get({ id })).data)
			.toEqual(created.changedNodes[0])
		expect((await client.graph.list({ kind: 'clause' })).data)
			.toEqual([{ id, kind: 'clause' }])
		const raw = await readFile(join(client.root, `.spec/contracts/${ownerId}.md`), 'utf8')
		expect(raw)
			.toContain(`  - id: ${id}\n    statement: Must support feature`)
		expect(raw).not.toContain('    constrains:')
		const updated = await client.graph.setRelationTargets({
			sourceId: ownerId,
			type: 'constrains',
			targets: [b],
			expectedRevision: created.revision,
		})
		expect(updated.changedEdges)
			.toEqual({
				added: [
					{ from: ownerId, type: 'constrains', to: b },
					{ from: id, type: 'constrains', to: b },
				].sort((x, y) => x.from.localeCompare(y.from)),
				removed: [
					{ from: ownerId, type: 'constrains', to: a },
					{ from: id, type: 'constrains', to: a },
				].sort((x, y) => x.from.localeCompare(y.from)),
			})
		expect((await client.graph.outgoing({ id, type: 'constrains' })).data)
			.toEqual([
				{ from: id, type: 'constrains', to: b },
			])
		expect((await client.graph.export()).revision)
			.toBe(updated.revision)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('treats optional Clause override as a full nonempty replacement and null as inheritance', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const a = f.changedNodes[0]!.id
		const other = await feature(client, 'Browse')
		const b = other.changedNodes[0]!.id
		const rule = await client.rule.create({
			ownerId: a,
			statement: 'Search Rule',
			expectedRevision: other.revision,
		})
		const rid = rule.changedNodes[0]!.id
		const c = await contract(client, 'Shared', [a])
		const ownerId = c.changedNodes[0]!.id
		const created = await client.clause.create({
			ownerId,
			statement: 'Override clause',
			constrains: [rid, b],
			expectedRevision: c.revision,
		})
		const id = created.changedNodes[0]!.id
		expect(created.changedEdges.added)
			.toEqual([
				{ from: id, type: 'constrains', to: b },
				{ from: id, type: 'constrains', to: rid },
			].sort((x, y) => x.to.localeCompare(y.to)))
		const path = join(client.root, `.spec/contracts/${ownerId}.md`)
		expect(await readFile(path, 'utf8'))
			.toContain('    constrains:')
		const changedOwner = await client.graph.setRelationTargets({
			sourceId: ownerId,
			type: 'constrains',
			targets: [b],
			expectedRevision: created.revision,
		})
		expect(changedOwner.changedEdges.added)
			.toEqual([{ from: ownerId, type: 'constrains', to: b }])
		expect((await client.graph.outgoing({ id })).data)
			.toHaveLength(2)
		await expect(client.graph.setRelationTargets({
			sourceId: id,
			type: 'constrains',
			targets: [],
			expectedRevision: changedOwner.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		await expect(client.graph.setRelationTargets({
			sourceId: id,
			type: 'constrains',
			targets: [ownerId],
			expectedRevision: changedOwner.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'target_kind' } })
		const inherited = await client.graph.setRelationTargets({
			sourceId: id,
			type: 'constrains',
			targets: null,
			expectedRevision: changedOwner.revision,
		})
		expect(inherited.changedEdges.added)
			.toEqual([])
		expect(inherited.changedEdges.removed)
			.toEqual([
				{ from: id, type: 'constrains', to: rid },
			])
		expect((await client.graph.outgoing({ id })).data)
			.toEqual([{ from: id, type: 'constrains', to: b }])
		const raw = await readFile(path, 'utf8')
		expect(raw)
			.toContain(`  - id: ${id}\n    statement: Override clause\n`)
		expect(raw).not.toContain('    constrains:')
		expect(await client.graph.setRelationTargets({
			sourceId: id,
			type: 'constrains',
			targets: null,
			expectedRevision: inherited.revision,
		}))
			.toEqual(noChanges(inherited.revision))
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('reorders without semantic revision change, reparents with preserved ID and recomputed inherited scope', async () => {
		const client = await setup()
		const fa = await feature(client, 'Alpha')
		const fb = await feature(client, 'Beta')
		const a = fa.changedNodes[0]!.id
		const b = fb.changedNodes[0]!.id
		const left = await contract(client, 'Left', [a])
		const right = await contract(client, 'Right', [b])
		const ownerA = left.changedNodes[0]!.id
		const ownerB = right.changedNodes[0]!.id
		const first = await client.clause.create({ ownerId: ownerA, statement: 'First', expectedRevision: right.revision })
		const second = await client.clause.create({ ownerId: ownerA, statement: 'Second', expectedRevision: first.revision })
		const oldId = first.changedNodes[0]!.id
		const nextId = second.changedNodes[0]!.id
		for (const invalid of [[oldId], [oldId, oldId], [oldId, newUuidV7()]]) {
			await expect(client.clause.reorder({ ownerId: ownerA, orderedIds: invalid, expectedRevision: second.revision }))
				.rejects.toMatchObject({ code: 'invalid_request' })
		}
		const reordered = await client.clause.reorder({
			ownerId: ownerA,
			orderedIds: [nextId, oldId],
			expectedRevision: second.revision,
		})
		expect(reordered)
			.toEqual(noChanges(second.revision))
		const source = join(client.root, `.spec/contracts/${ownerA}.md`)
		const target = join(client.root, `.spec/contracts/${ownerB}.md`)
		expect((await readFile(source, 'utf8')).indexOf(nextId))
			.toBeLessThan(
				(await readFile(source, 'utf8')).indexOf(oldId),
			)
		await writeFile(source, `${await readFile(source, 'utf8')}\nLeft note.\n`)
		await writeFile(target, `${await readFile(target, 'utf8')}\nRight note.\n`)
		const moved = await client.clause.reparent({
			id: oldId,
			newOwnerId: ownerB,
			expectedRevision: reordered.revision,
		})
		expect(moved.changedNodes)
			.toEqual([expect.objectContaining({ id: oldId, ownerId: ownerB })])
		expect(moved.changedEdges)
			.toEqual({
				added: [{ from: oldId, type: 'constrains', to: b }],
				removed: [{ from: oldId, type: 'constrains', to: a }],
			})
		expect(await readFile(source, 'utf8'))
			.toContain('Left note.')
		expect(await readFile(target, 'utf8'))
			.toContain('Right note.')
		expect((await client.graph.outgoing({ id: oldId })).data)
			.toEqual([
				{ from: oldId, type: 'constrains', to: b },
			])
		expect((await client.clause.reparent({
			id: oldId,
			newOwnerId: ownerB,
			expectedRevision: moved.revision,
		})).revision)
			.toBe(moved.revision)
		await expect(client.clause.reparent({
			id: oldId,
			newOwnerId: ownerA,
			expectedRevision: reordered.revision,
		})).rejects.toMatchObject({ code: 'revision_conflict' })
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('blocks ordinary delete for inbound references and attached Clause children', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const c = await contract(client, 'Shared', [fid])
		const cid = c.changedNodes[0]!.id
		const clause = await client.clause.create({ ownerId: cid, statement: 'Clause', expectedRevision: c.revision })
		const clauseId = clause.changedNodes[0]!.id
		await expect(client.contract.delete({ id: cid, expectedRevision: clause.revision }))
			.rejects.toMatchObject({ code: 'invalid_request' })
		await expect(client.feature.delete({ id: fid, expectedRevision: clause.revision }))
			.rejects.toMatchObject({ code: 'referenced_unit' })
		const scenario = await client.scenario.create({
			title: 'Demonstrates Contract and Clause',
			steps: [{ type: 'when', text: 'call API' }, { type: 'then', text: 'see result' }],
			demonstrates: [cid, clauseId],
			expectedRevision: clause.revision,
		})
		await expect(client.clause.delete({ id: clauseId, expectedRevision: scenario.revision }))
			.rejects.toMatchObject({ code: 'referenced_unit' })
		const removed = await client.scenario.delete({
			id: scenario.changedNodes[0]!.id,
			expectedRevision: scenario.revision,
		})
		const dropped = await client.clause.delete({ id: clauseId, expectedRevision: removed.revision })
		expect(dropped.deletedIds)
			.toEqual([clauseId])
		expect(dropped.changedEdges.removed)
			.toEqual([{ from: clauseId, type: 'constrains', to: fid }])
		const contractDeleted = await client.contract.delete({ id: cid, expectedRevision: dropped.revision })
		expect(contractDeleted.deletedIds)
			.toEqual([cid])
		expect(existsSync(join(client.root, `.spec/contracts/${cid}.md`)))
			.toBe(false)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('rejects invalid persisted Clause schema, optional null and duplicate UUIDs across kinds', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const c = await contract(client, 'Shared', [fid])
		const cid = c.changedNodes[0]!.id
		const path = join(client.root, `.spec/contracts/${cid}.md`)
		const pristine = await readFile(path, 'utf8')
		const invalidClauses = [
			`  - statement: Wrong order\n    id: ${newUuidV7()}`,
			`  - id: ${newUuidV7()}\n    statement: Text\n    constrains: []`,
			`  - id: ${newUuidV7()}\n    statement: Text\n    constrains: null`,
			`  - id: ${fid}\n    statement: Duplicate Feature ID`,
			`  - id: ${newUuidV7()}\n    statement: Text\n    extra: false`,
		]
		for (const bad of invalidClauses) {
			await writeFile(path, pristine.replace('clauses: []', `clauses:\n${bad}`))
			expect((await client.workspace.validate()).valid)
				.toBe(false)
		}
		await writeFile(path, pristine)
		await writeFile(path, pristine.replace(/constrains:\n {2}- [^\n]+\n/u, 'constrains: []\n'))
		expect((await client.workspace.validate()).issues)
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ path: 'constrains', reason: 'empty' }),
			]))
		await writeFile(path, pristine)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('exposes compiled-contract CRUD and Clause operations through JSON-stdin resource CLI', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const target = f.changedNodes[0]!.id
		const created = await runV1Cli(['contract', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				title: 'CLI Contract',
				summary: 'Shared API',
				constrains: [target],
				expectedRevision: f.revision,
			}),
		})
		expect(created.exitCode)
			.toBe(0)
		expect(created.stderr)
			.toBe('')
		const result = JSON.parse(created.stdout) as { revision: string, changedNodes: Array<{ id: string }> }
		const ownerId = result.changedNodes[0]!.id
		const child = await runV1Cli(['clause', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				ownerId,
				statement: 'CLI Clause',
				expectedRevision: result.revision,
			}),
		})
		expect(child.exitCode)
			.toBe(0)
		const clauseResult = JSON.parse(child.stdout) as { revision: string, changedNodes: Array<{ id: string }> }
		const id = clauseResult.changedNodes[0]!.id
		expect((await client.graph.get({ id })).data)
			.toMatchObject({ kind: 'clause', ownerId })
		const malformed = await runV1Cli(['clause', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				ownerId,
				statement: 'Invalid',
				constrains: [],
				expectedRevision: clauseResult.revision,
			}),
		})
		expect(malformed.exitCode)
			.toBe(1)
		expect(malformed.stdout)
			.toBe('')
		expect(JSON.parse(malformed.stderr).code)
			.toBe('relation_invalid')
		const deleted = await runV1Cli(['clause', 'delete', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({ id, expectedRevision: clauseResult.revision }),
		})
		expect(JSON.parse(deleted.stdout).deletedIds)
			.toEqual([id])
	})
})
