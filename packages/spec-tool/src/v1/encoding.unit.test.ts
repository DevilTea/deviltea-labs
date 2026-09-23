import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'
import { renderNewScenarioFile } from './scenario'
import { encodeContract, encodeStory } from './storage'

const roots: string[] = []
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-encoding-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return { root, client }
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { force: true, recursive: true })))
})

describe('canonical byte-level persistence validation', () => {
	it('rejects noncanonical manifest bytes even if YAML parses to the same meaning', async () => {
		const { root, client } = await setup()
		const path = join(root, '.spec/spec.yaml')
		for (const content of [
			'formatVersion: 1',
			'formatVersion: 1\r\n',
			'formatVersion: 1  \n',
			'formatVersion: 1\n# noncanonical comment\n',
			'  formatVersion: 1\n',
			Buffer.from([0x66, 0x6F, 0xFF]),
		]) {
			await writeFile(path, content)
			const validation = await client.workspace.validate()
			expect(validation.valid, JSON.stringify(content))
				.toBe(false)
			expect(validation.revision)
				.toBeUndefined()
			expect(validation.issues)
				.toEqual(expect.arrayContaining([
					expect.objectContaining({ source: { path: '.spec/spec.yaml' }, reason: 'invalid_format' }),
				]))
		}
		await writeFile(path, 'formatVersion: 1\n')
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('rejects invalid UTF-8 in every semantic source root before any mutation can corrupt its bytes', async () => {
		const { root, client } = await setup()
		const feature = await client.feature.create({
			title: 'Stable title',
			summary: 'Stable summary',
			expectedRevision: (await client.graph.export()).revision,
		})
		const featureId = feature.changedNodes[0]!.id
		const featurePath = `.spec/features/${featureId}.md`
		const storyId = newUuidV7()
		const contractId = newUuidV7()
		const scenarioId = newUuidV7()
		const examples = [
			{ path: featurePath, content: await readFile(join(root, featurePath)) },
			{
				path: `.spec/stories/${storyId}.md`,
				content: Buffer.from(encodeStory({
					id: storyId,
					title: 'Find',
					actor: 'Buyer',
					goal: 'Find',
					value: 'Save time',
					motivates: [featureId],
				})),
			},
			{
				path: `.spec/contracts/${contractId}.md`,
				content: Buffer.from(encodeContract({
					id: contractId,
					title: 'Shared policy',
					summary: 'Shared authority',
					clauses: [],
					constrains: [featureId],
				})),
			},
			{
				path: `.spec/scenarios/${newUuidV7()}.feature`,
				content: Buffer.from(renderNewScenarioFile({
					id: scenarioId,
					title: 'Find',
					demonstrates: [featureId],
					steps: [{ type: 'when', text: 'I search' }, { type: 'then', text: 'I see results' }],
				})),
			},
		]
		for (const { path, content } of examples) {
			const absolute = join(root, path)
			await mkdir(dirname(absolute), { recursive: true })
			const invalid = Buffer.concat([content, Buffer.from([0xFF, 0xFE, 0x41])])
			await writeFile(absolute, invalid)
			const validation = await client.workspace.validate()
			expect(validation.valid, path)
				.toBe(false)
			expect(validation.revision)
				.toBeUndefined()
			expect(validation.issues)
				.toEqual(expect.arrayContaining([
					expect.objectContaining({ source: { path }, reason: 'invalid_format' }),
				]))
			await expect(client.graph.export()).rejects.toMatchObject({ code: 'validation_failed' })
			await expect(client.feature.update({
				id: featureId,
				changes: { title: 'Attempted mutation' },
				expectedRevision: feature.revision,
			})).rejects.toMatchObject({ code: 'validation_failed' })
			expect((await readFile(absolute)).equals(invalid), path)
				.toBe(true)
			await writeFile(absolute, content)
			expect((await client.workspace.validate()).valid)
				.toBe(true)
		}
	})

	it('preserves valid UTF-8 body bytes on an unrelated semantic rewrite', async () => {
		const { root, client } = await setup()
		const created = await client.feature.create({
			title: 'Original',
			summary: 'Original',
			expectedRevision: (await client.graph.export()).revision,
		})
		const path = join(root, created.changedNodes[0]!.source.path)
		const original = (await readFile(path)).toString('utf8')
		const notes = '\n\n# 說明 ✨ — résumé\nValid encoded replacement character: \uFFFD\n'
		await writeFile(path, original + notes)
		const revision = (await client.workspace.validate()).revision!
		const result = await client.feature.update({
			id: created.changedNodes[0]!.id,
			changes: { title: 'Renamed' },
			expectedRevision: revision,
		})
		expect(result.revision).not.toBe(revision)
		expect((await readFile(path)).toString('utf8')
			.endsWith(notes))
			.toBe(true)
	})
})
