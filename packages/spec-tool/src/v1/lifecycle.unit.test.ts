import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runV1Cli } from './cli'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'

const roots: string[] = []
async function setup(): Promise<SpecClient> {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-lifecycle-'))
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
async function contract(client: SpecClient, targets: string[]) {
	return client.contract.create({
		title: 'Policy',
		summary: 'Shared policy',
		constrains: targets,
		expectedRevision: (await client.graph.export()).revision,
	})
}
async function scenario(client: SpecClient, demonstrates: string[]) {
	return client.scenario.create({
		title: 'Demonstrates existing authority',
		steps: [{ type: 'when', text: 'request is made' }, { type: 'then', text: 'response is returned' }],
		demonstrates,
		expectedRevision: (await client.graph.export()).revision,
	})
}
function sourcePath(root: string, kind: 'features' | 'contracts', id: string): string {
	return join(root, '.spec', kind, `${id}.md`)
}

describe('cross-kind lifecycle and explicit compound teardown', () => {
	it('promotes Rule to inherited Clause with stable identity and keeps Scenario demonstrations', async () => {
		const client = await setup()
		const f = await feature(client, 'Alpha')
		const ownerId = f.changedNodes[0]!.id
		const rule = await client.rule.create({
			ownerId,
			statement: 'Original rule',
			expectedRevision: f.revision,
		})
		const id = rule.changedNodes[0]!.id
		const c = await contract(client, [ownerId])
		const contractId = c.changedNodes[0]!.id
		const existing = await client.clause.create({
			ownerId: contractId,
			statement: 'Existing Clause',
			expectedRevision: c.revision,
		})
		const existingId = existing.changedNodes[0]!.id
		const shown = await scenario(client, [id])
		const featureFile = sourcePath(client.root, 'features', ownerId)
		const contractFile = sourcePath(client.root, 'contracts', contractId)
		await writeFile(featureFile, `${await readFile(featureFile, 'utf8')}\nFeature note.\n`)
		await writeFile(contractFile, `${await readFile(contractFile, 'utf8')}\nContract note.\n`)
		const promoted = await client.rule.promote({
			id,
			newOwnerId: contractId,
			relations: { constrains: null },
			expectedRevision: shown.revision,
		})
		expect(promoted.changedNodes)
			.toEqual([
				expect.objectContaining({
					id,
					kind: 'clause',
					ownerId: contractId,
					statement: 'Original rule',
					source: { path: `.spec/contracts/${contractId}.md` },
				}),
			])
		expect(promoted.deletedIds)
			.toEqual([])
		expect(promoted.changedEdges.added)
			.toEqual([{ from: id, type: 'constrains', to: ownerId }])
		expect(promoted.changedEdges.removed)
			.toEqual([])
		expect((await client.graph.get({ id })).data)
			.toMatchObject({ id, kind: 'clause', ownerId: contractId })
		expect((await client.graph.outgoing({ id: shown.changedNodes[0]!.id })).data)
			.toEqual([
				{ from: shown.changedNodes[0]!.id, type: 'demonstrates', to: id },
			])
		expect(await readFile(featureFile, 'utf8'))
			.toContain('Feature note.')
		expect(await readFile(contractFile, 'utf8'))
			.toContain('Contract note.')
		expect(await readFile(featureFile, 'utf8')).not.toContain(id)
		const persisted = await readFile(contractFile, 'utf8')
		expect(persisted.indexOf(existingId))
			.toBeLessThan(persisted.indexOf(id))
		expect(persisted).not.toContain('    constrains:')
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('requires explicit final constrains on promotion and rejects illegal self-target or wrong owners', async () => {
		const client = await setup()
		const first = await feature(client, 'Alpha')
		const second = await feature(client, 'Beta')
		const a = first.changedNodes[0]!.id
		const b = second.changedNodes[0]!.id
		const own = await client.rule.create({ ownerId: a, statement: 'Promote me', expectedRevision: second.revision })
		const rid = own.changedNodes[0]!.id
		const other = await client.rule.create({ ownerId: b, statement: 'Other Rule', expectedRevision: own.revision })
		const otherId = other.changedNodes[0]!.id
		const c = await contract(client, [a])
		const cid = c.changedNodes[0]!.id
		const before = await client.graph.export()
		await expect(client.rule.promote({
			id: rid,
			newOwnerId: cid,
			relations: { constrains: [rid] },
			expectedRevision: before.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'target_kind' } })
		await expect(client.rule.promote({
			id: rid,
			newOwnerId: a,
			relations: { constrains: null },
			expectedRevision: before.revision,
		})).rejects.toMatchObject({ code: 'not_found' })
		await expect(client.rule.promote({
			id: rid,
			newOwnerId: cid,
			relations: {} as never,
			expectedRevision: before.revision,
		})).rejects.toMatchObject({ code: 'invalid_request' })
		expect(await client.graph.export())
			.toEqual(before)
		const promoted = await client.rule.promote({
			id: rid,
			newOwnerId: cid,
			relations: { constrains: [otherId, b] },
			expectedRevision: before.revision,
		})
		expect(promoted.changedEdges.added)
			.toEqual(expect.arrayContaining([
				{ from: rid, type: 'constrains', to: otherId },
				{ from: rid, type: 'constrains', to: b },
			]))
		expect(promoted.changedEdges.added)
			.toHaveLength(2)
		expect(promoted.changedEdges.added).not.toContainEqual({ from: rid, type: 'constrains', to: a })
		expect(await readFile(sourcePath(client.root, 'contracts', cid), 'utf8'))
			.toContain('    constrains:')
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('blocks promotion of a Rule constrained by another Clause without modifying persistence', async () => {
		const client = await setup()
		const f = await feature(client, 'Alpha')
		const fid = f.changedNodes[0]!.id
		const rule = await client.rule.create({ ownerId: fid, statement: 'Target Rule', expectedRevision: f.revision })
		const id = rule.changedNodes[0]!.id
		const c = await contract(client, [fid])
		const cid = c.changedNodes[0]!.id
		const constraining = await client.clause.create({
			ownerId: cid,
			statement: 'Constraint source',
			constrains: [id],
			expectedRevision: c.revision,
		})
		const before = await client.graph.export()
		const featureFile = sourcePath(client.root, 'features', fid)
		const contractFile = sourcePath(client.root, 'contracts', cid)
		const files = await Promise.all([featureFile, contractFile].map(file => readFile(file, 'utf8')))
		await expect(client.rule.promote({
			id,
			newOwnerId: cid,
			relations: { constrains: null },
			expectedRevision: constraining.revision,
		})).rejects.toMatchObject({
			code: 'relation_invalid',
			details: { reason: 'target_kind', sourceId: constraining.changedNodes[0]!.id },
		})
		expect(await client.graph.export())
			.toEqual(before)
		expect(await Promise.all([featureFile, contractFile].map(file => readFile(file, 'utf8'))))
			.toEqual(files)
	})

	it('demotes Clause to Rule with explicit empty relations and removes Clause-only edges', async () => {
		const client = await setup()
		const f = await feature(client, 'Alpha')
		const g = await feature(client, 'Beta')
		const a = f.changedNodes[0]!.id
		const b = g.changedNodes[0]!.id
		const existing = await client.rule.create({ ownerId: b, statement: 'Existing Rule', expectedRevision: g.revision })
		const c = await contract(client, [a])
		const cid = c.changedNodes[0]!.id
		const clause = await client.clause.create({
			ownerId: cid,
			statement: 'Explicit clause',
			constrains: [b],
			expectedRevision: c.revision,
		})
		const id = clause.changedNodes[0]!.id
		const shown = await scenario(client, [id])
		const before = await client.graph.export()
		for (const relations of [undefined, { constrains: [] }, { unknown: true }]) {
			await expect(client.clause.demote({
				id,
				newOwnerId: b,
				relations: relations as never,
				expectedRevision: before.revision,
			})).rejects.toMatchObject({ code: 'invalid_request' })
		}
		expect(await client.graph.export())
			.toEqual(before)
		const from = sourcePath(client.root, 'contracts', cid)
		const to = sourcePath(client.root, 'features', b)
		await writeFile(from, `${await readFile(from, 'utf8')}\nContract body.\n`)
		await writeFile(to, `${await readFile(to, 'utf8')}\nFeature body.\n`)
		const demoted = await client.clause.demote({
			id,
			newOwnerId: b,
			relations: {},
			expectedRevision: shown.revision,
		})
		expect(demoted.changedNodes)
			.toEqual([expect.objectContaining({ id, kind: 'rule', ownerId: b })])
		expect(demoted.changedEdges.removed)
			.toEqual([{ from: id, type: 'constrains', to: b }])
		expect(demoted.changedEdges.added)
			.toEqual([])
		const toText = await readFile(to, 'utf8')
		expect(toText.indexOf(existing.changedNodes[0]!.id))
			.toBeLessThan(toText.indexOf(id))
		expect(toText)
			.toContain('Feature body.')
		expect(await readFile(from, 'utf8'))
			.toContain('Contract body.')
		expect((await client.graph.outgoing({ id: shown.changedNodes[0]!.id })).data)
			.toEqual([
				{ from: shown.changedNodes[0]!.id, type: 'demonstrates', to: id },
			])
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('requires exact child sets and guards each inbound reference on Feature compound delete', async () => {
		const client = await setup()
		const featureResult = await feature(client, 'Feature with Rules')
		const ownerId = featureResult.changedNodes[0]!.id
		const first = await client.rule.create({ ownerId, statement: 'Rule A', expectedRevision: featureResult.revision })
		const second = await client.rule.create({ ownerId, statement: 'Rule B', expectedRevision: first.revision })
		const a = first.changedNodes[0]!.id
		const b = second.changedNodes[0]!.id
		for (const childIds of [[], [a], [a, a], [a, newUuidV7()]]) {
			await expect(client.feature.deleteWithChildren({
				ownerId,
				childIds,
				expectedRevision: second.revision,
			})).rejects.toMatchObject({ code: 'invalid_request' })
		}
		const demonstrated = await scenario(client, [b])
		await expect(client.feature.deleteWithChildren({
			ownerId,
			childIds: [b, a],
			expectedRevision: demonstrated.revision,
		})).rejects.toMatchObject({ code: 'referenced_unit', details: { targetId: b } })
		expect((await client.workspace.validate()).valid)
			.toBe(true)
		const removedScenario = await client.scenario.delete({
			id: demonstrated.changedNodes[0]!.id,
			expectedRevision: demonstrated.revision,
		})
		const deleted = await client.feature.deleteWithChildren({
			ownerId,
			childIds: [b, a],
			expectedRevision: removedScenario.revision,
		})
		expect(deleted.deletedIds)
			.toEqual([ownerId, a, b].sort())
		expect(deleted.changedNodes)
			.toEqual([])
		expect(existsSync(sourcePath(client.root, 'features', ownerId)))
			.toBe(false)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('atomically compound-deletes a Contract and all Clauses, removing outgoing effective edges', async () => {
		const client = await setup()
		const f = await feature(client, 'Alpha')
		const g = await feature(client, 'Beta')
		const a = f.changedNodes[0]!.id
		const b = g.changedNodes[0]!.id
		const c = await contract(client, [a])
		const cid = c.changedNodes[0]!.id
		const first = await client.clause.create({ ownerId: cid, statement: 'Inherited', expectedRevision: c.revision })
		const second = await client.clause.create({
			ownerId: cid,
			statement: 'Override',
			constrains: [b],
			expectedRevision: first.revision,
		})
		const one = first.changedNodes[0]!.id
		const two = second.changedNodes[0]!.id
		await expect(client.contract.deleteWithChildren({
			ownerId: cid,
			childIds: [one],
			expectedRevision: second.revision,
		})).rejects.toMatchObject({ code: 'invalid_request' })
		const shown = await scenario(client, [cid, two])
		await expect(client.contract.deleteWithChildren({
			ownerId: cid,
			childIds: [two, one],
			expectedRevision: shown.revision,
		})).rejects.toMatchObject({ code: 'referenced_unit' })
		const gone = await client.scenario.delete({
			id: shown.changedNodes[0]!.id,
			expectedRevision: shown.revision,
		})
		const deleted = await client.contract.deleteWithChildren({
			ownerId: cid,
			childIds: [two, one],
			expectedRevision: gone.revision,
		})
		expect(deleted.deletedIds)
			.toEqual([cid, one, two].sort())
		expect(deleted.changedEdges.removed)
			.toEqual(expect.arrayContaining([
				{ from: cid, type: 'constrains', to: a },
				{ from: one, type: 'constrains', to: a },
				{ from: two, type: 'constrains', to: b },
			]))
		expect(deleted.changedEdges.removed)
			.toHaveLength(3)
		expect(existsSync(sourcePath(client.root, 'contracts', cid)))
			.toBe(false)
		expect((await client.graph.export()).data.nodes.map(node => node.kind))
			.toEqual(['feature', 'feature'])
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('rejects stale revision for conversion and compound deletion without touching source files', async () => {
		const client = await setup()
		const f = await feature(client, 'Alpha')
		const fid = f.changedNodes[0]!.id
		const r = await client.rule.create({
			ownerId: fid,
			statement: 'Rule A',
			expectedRevision: f.revision,
		})
		const rid = r.changedNodes[0]!.id
		const c = await contract(client, [fid])
		const cid = c.changedNodes[0]!.id
		const source = sourcePath(client.root, 'features', fid)
		const target = sourcePath(client.root, 'contracts', cid)
		const previous = await Promise.all([source, target].map(file => readFile(file, 'utf8')))
		await expect(client.rule.promote({
			id: rid,
			newOwnerId: cid,
			relations: { constrains: null },
			expectedRevision: r.revision,
		})).rejects.toMatchObject({ code: 'revision_conflict' })
		expect(await Promise.all([source, target].map(file => readFile(file, 'utf8'))))
			.toEqual(previous)
		const promoted = await client.rule.promote({
			id: rid,
			newOwnerId: cid,
			relations: { constrains: null },
			expectedRevision: c.revision,
		})
		await expect(client.clause.demote({
			id: rid,
			newOwnerId: fid,
			relations: {},
			expectedRevision: c.revision,
		})).rejects.toMatchObject({ code: 'revision_conflict' })
		const demoted = await client.clause.demote({
			id: rid,
			newOwnerId: fid,
			relations: {},
			expectedRevision: promoted.revision,
		})
		await expect(client.feature.deleteWithChildren({
			ownerId: fid,
			childIds: [rid],
			expectedRevision: promoted.revision,
		})).rejects.toMatchObject({ code: 'revision_conflict' })
		expect((await client.graph.export()).revision)
			.toBe(demoted.revision)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('exposes conversion and compound-delete resource commands through JSON-stdin CLI', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const rule = await client.rule.create({ ownerId: fid, statement: 'CLI Rule', expectedRevision: f.revision })
		const rid = rule.changedNodes[0]!.id
		const c = await contract(client, [fid])
		const cid = c.changedNodes[0]!.id
		const promotion = await runV1Cli(['rule', 'promote', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				id: rid,
				newOwnerId: cid,
				relations: { constrains: null },
				expectedRevision: c.revision,
			}),
		})
		expect(promotion.exitCode)
			.toBe(0)
		expect(promotion.stderr)
			.toBe('')
		const result = JSON.parse(promotion.stdout) as { revision: string, changedNodes: Array<{ id: string, kind: string }> }
		expect(result.changedNodes[0])
			.toMatchObject({ id: rid, kind: 'clause' })
		const invalid = await runV1Cli(['clause', 'demote', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				id: rid,
				newOwnerId: fid,
				relations: { constrains: [] },
				expectedRevision: result.revision,
			}),
		})
		expect(invalid.exitCode)
			.toBe(1)
		expect(invalid.stdout)
			.toBe('')
		expect(JSON.parse(invalid.stderr).code)
			.toBe('invalid_request')
		const demotion = await runV1Cli(['clause', 'demote', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				id: rid,
				newOwnerId: fid,
				relations: {},
				expectedRevision: result.revision,
			}),
		})
		const restored = JSON.parse(demotion.stdout) as { revision: string, changedNodes: Array<{ id: string, kind: string }> }
		expect(restored.changedNodes[0])
			.toMatchObject({ id: rid, kind: 'rule' })
		const ownerDelete = await runV1Cli(['feature', 'delete-with-children', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				ownerId: fid,
				childIds: [rid],
				expectedRevision: restored.revision,
			}),
		})
		expect(ownerDelete.exitCode)
			.toBe(1)
		expect(JSON.parse(ownerDelete.stderr).code)
			.toBe('referenced_unit')
		const dropped = await client.contract.deleteWithChildren({
			ownerId: cid,
			childIds: [],
			expectedRevision: restored.revision,
		})
		const final = await runV1Cli(['feature', 'delete-with-children', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				ownerId: fid,
				childIds: [rid],
				expectedRevision: dropped.revision,
			}),
		})
		expect(final.exitCode)
			.toBe(0)
		expect(JSON.parse(final.stdout).deletedIds)
			.toEqual([fid, rid].sort())
	})
})
