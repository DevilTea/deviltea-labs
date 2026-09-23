import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'
import { encodeFeature, removeSemanticFile, withSemanticMutationJournal, writeSemanticFile } from './storage'
import { readSnapshot } from './workspace'
import { withWorkspaceWriteLock } from './write-lock'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-journal-test-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	const initial = await client.graph.export()
	const feature = await client.feature.create({
		title: 'Valid',
		summary: 'Original',
		expectedRevision: initial.revision,
	})
	return { client, feature }
}

describe('semantic mutation journal', () => {
	it('reverts modified and newly created files when post-write validation fails', async () => {
		const { client, feature } = await setup()
		const oldPath = feature.changedNodes[0]!.source.path
		const newPath = `.spec/features/${newUuidV7()}.md`
		const original = await readFile(join(client.root, oldPath), 'utf8')
		await expect(withWorkspaceWriteLock(client.root, () => withSemanticMutationJournal(client.root, async () => {
			await writeSemanticFile(client.root, oldPath, 'invalid frontmatter')
			const newId = newPath.split('/')
				.at(-1)!.slice(0, -3)
			await writeSemanticFile(client.root, newPath, encodeFeature({
				id: newId,
				title: 'Second',
				summary: 'Create should rollback too',
				rules: [],
			}))
			await readSnapshot(client.root, true)
		}))).rejects.toMatchObject({ code: 'validation_failed' })
		expect(await readFile(join(client.root, oldPath), 'utf8'))
			.toBe(original)
		expect(existsSync(join(client.root, newPath)))
			.toBe(false)
		expect((await client.graph.export()).revision)
			.toBe(feature.revision)
		expect(existsSync(join(client.root, '.spec-tool-v1.lock')))
			.toBe(false)
	})

	it('reverts a semantic deletion when a subsequent mutation step throws', async () => {
		const { client, feature } = await setup()
		const path = feature.changedNodes[0]!.source.path
		const original = await readFile(join(client.root, path), 'utf8')
		await expect(withWorkspaceWriteLock(client.root, () => withSemanticMutationJournal(client.root, async () => {
			await removeSemanticFile(client.root, path)
			throw new Error('Injected post-delete failure')
		}))).rejects.toThrow('Injected post-delete failure')
		expect(await readFile(join(client.root, path), 'utf8'))
			.toBe(original)
		expect((await client.graph.export()).revision)
			.toBe(feature.revision)
	})
})
