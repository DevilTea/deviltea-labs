import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecClient } from './client'

const roots: string[] = []

async function client(): Promise<SpecClient> {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-client-'))
	roots.push(root)
	const spec = new SpecClient(root)
	await spec.workspace.init()
	return spec
}

afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('frozen v1 semantic client', () => {
	it('creates, reads, updates, no-ops and deletes Features with optimistic concurrency', async () => {
		const spec = await client()
		const initial = await spec.graph.export()
		const created = await spec.feature.create({
			title: 'Search',
			summary: 'Find matching entries',
			expectedRevision: initial.revision,
		})
		const feature = created.changedNodes[0]!
		expect(feature)
			.toMatchObject({ kind: 'feature', title: 'Search', summary: 'Find matching entries' })
		expect(created.changedEdges)
			.toEqual({ added: [], removed: [] })
		expect(await spec.graph.get({ id: feature.id }))
			.toEqual({ revision: created.revision, data: feature })
		expect((await spec.graph.list()).data)
			.toEqual([{ id: feature.id, kind: 'feature', title: 'Search' }])
		expect((await readFile(join(spec.root, `.spec/features/${feature.id}.md`), 'utf8')))
			.toContain('rules: []')
		await expect(spec.feature.update({
			id: feature.id,
			changes: { title: 'New title' },
			expectedRevision: initial.revision,
		})).rejects.toMatchObject({
			code: 'revision_conflict',
			details: { expectedRevision: initial.revision, currentRevision: created.revision },
		})
		const noOp = await spec.feature.update({
			id: feature.id,
			changes: { summary: 'Find matching entries' },
			expectedRevision: created.revision,
		})
		expect(noOp)
			.toEqual({ revision: created.revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } })
		const updated = await spec.feature.update({
			id: feature.id,
			changes: { title: 'New title' },
			expectedRevision: noOp.revision,
		})
		expect(updated.changedNodes)
			.toEqual([expect.objectContaining({ id: feature.id, title: 'New title' })])
		expect(updated.revision).not.toBe(noOp.revision)
		const removed = await spec.feature.delete({ id: feature.id, expectedRevision: updated.revision })
		expect(removed)
			.toMatchObject({ changedNodes: [], deletedIds: [feature.id] })
		expect((await spec.graph.export()).data.nodes)
			.toEqual([])
	})

	it('preserves the entire unrelated Markdown body on semantic updates', async () => {
		const spec = await client()
		const initial = await spec.graph.export()
		const created = await spec.feature.create({ title: 'Search', summary: 'Find', expectedRevision: initial.revision })
		const id = created.changedNodes[0]!.id
		const path = join(spec.root, `.spec/features/${id}.md`)
		const original = await readFile(path, 'utf8')
		const notes = '\n\n## Notes\nEvery byte must survive.\n'
		await writeFile(path, original.replace(/\n$/, notes))
		const revision = (await spec.workspace.validate()).revision!
		expect(revision)
			.toBe(created.revision)
		await spec.feature.update({ id, changes: { summary: 'Find all items' }, expectedRevision: revision })
		expect((await readFile(path, 'utf8')).endsWith(notes))
			.toBe(true)
	})

	it('enforces Story relations and exposes graph queries, edge deltas and outgoing cleanup', async () => {
		const spec = await client()
		const a = await spec.feature.create({
			title: 'Search',
			summary: 'Look up',
			expectedRevision: (await spec.graph.export()).revision,
		})
		const b = await spec.feature.create({
			title: 'Results',
			summary: 'Show matches',
			expectedRevision: a.revision,
		})
		const featureId = a.changedNodes[0]!.id
		const targetId = b.changedNodes[0]!.id
		const created = await spec.story.create({
			title: 'Find a product',
			actor: 'Customer',
			goal: 'Locate an item',
			value: 'Save time',
			motivates: [featureId],
			expectedRevision: b.revision,
		})
		const story = created.changedNodes[0]!
		expect(story.kind)
			.toBe('story')
		expect(created.changedEdges.added)
			.toEqual([{ from: story.id, type: 'motivates', to: featureId }])
		expect((await spec.graph.incoming({ id: featureId })).data)
			.toEqual(created.changedEdges.added)
		expect((await spec.graph.outgoing({ id: story.id, type: 'motivates' })).data)
			.toEqual(created.changedEdges.added)
		const relations = await spec.graph.setRelationTargets({
			sourceId: story.id,
			type: 'motivates',
			targets: [targetId, featureId],
			expectedRevision: created.revision,
		})
		expect(relations.changedNodes)
			.toEqual([])
		expect(relations.changedEdges.added)
			.toEqual([{ from: story.id, type: 'motivates', to: targetId }])
		const noOpRelations = await spec.graph.setRelationTargets({
			sourceId: story.id,
			type: 'motivates',
			targets: [featureId, targetId],
			expectedRevision: relations.revision,
		})
		expect(noOpRelations)
			.toEqual({ revision: relations.revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } })
		await expect(spec.graph.setRelationTargets({
			sourceId: story.id,
			type: 'motivates',
			targets: [],
			expectedRevision: relations.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		await expect(spec.feature.delete({ id: featureId, expectedRevision: relations.revision }))
			.rejects.toMatchObject({
				code: 'referenced_unit',
				details: { targetId: featureId, inboundEdges: expect.any(Array) },
			})
		const unchanged = await spec.graph.export()
		expect(unchanged.revision)
			.toBe(relations.revision)
		const storyRemoved = await spec.story.delete({ id: story.id, expectedRevision: relations.revision })
		expect(storyRemoved.changedEdges.removed)
			.toHaveLength(2)
		expect(storyRemoved.deletedIds)
			.toEqual([story.id])
		const featureRemoved = await spec.feature.delete({ id: featureId, expectedRevision: storyRemoved.revision })
		expect(featureRemoved.deletedIds)
			.toEqual([featureId])
	})

	it('rejects duplicate or empty relations, wrong target kind and invalid request keys', async () => {
		const spec = await client()
		const feature = await spec.feature.create({
			title: 'Search',
			summary: 'Lookup',
			expectedRevision: (await spec.graph.export()).revision,
		})
		const id = feature.changedNodes[0]!.id
		await expect(spec.story.create({
			title: 'Find',
			actor: 'Customer',
			goal: 'Find',
			value: 'Fast',
			motivates: [],
			expectedRevision: feature.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		await expect(spec.story.create({
			title: 'Find',
			actor: 'Customer',
			goal: 'Find',
			value: 'Fast',
			motivates: [id, id],
			expectedRevision: feature.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'duplicate_target' } })
		await expect(spec.feature.create({
			title: 'Test',
			summary: 'Test',
			expectedRevision: feature.revision,
			id: 'caller-id',
		} as never)).rejects.toMatchObject({
			code: 'invalid_request',
			details: { issues: [expect.objectContaining({ path: 'request.id', reason: 'unexpected' })] },
		})
		const story = await spec.story.create({
			title: 'Find',
			actor: 'Customer',
			goal: 'Find',
			value: 'Fast',
			motivates: [id],
			expectedRevision: feature.revision,
		})
		await expect(spec.graph.setRelationTargets({
			sourceId: story.changedNodes[0]!.id,
			type: 'motivates',
			targets: [story.changedNodes[0]!.id],
			expectedRevision: story.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'target_kind' } })
		expect((await spec.graph.export()).revision)
			.toBe(story.revision)
	})

	it('serializes simultaneous local mutations with the same expected revision', async () => {
		const spec = await client()
		const { revision } = await spec.graph.export()
		const results = await Promise.allSettled([
			spec.feature.create({ title: 'A', summary: 'One', expectedRevision: revision }),
			spec.feature.create({ title: 'B', summary: 'Two', expectedRevision: revision }),
		])
		expect(results.filter(result => result.status === 'fulfilled'))
			.toHaveLength(1)
		expect(results.filter(result => result.status === 'rejected'))
			.toHaveLength(1)
		expect((await spec.graph.export()).data.nodes)
			.toHaveLength(1)
	})

	it('blocks semantic reads and writes for invalid persistence while allowing validation', async () => {
		const spec = await client()
		await writeFile(join(spec.root, '.spec/unexpected.md'), 'unexpected')
		const validation = await spec.workspace.validate()
		expect(validation.valid)
			.toBe(false)
		expect(validation).not.toHaveProperty('revision')
		await expect(spec.graph.export()).rejects.toMatchObject({ code: 'validation_failed' })
		await expect(spec.feature.create({
			title: 'A',
			summary: 'B',
			expectedRevision: '0'.repeat(64),
		})).rejects.toMatchObject({ code: 'validation_failed' })
	})
})
