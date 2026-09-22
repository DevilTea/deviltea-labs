import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isUuidV7, newUuidV7 } from './identity'
import { encodeFeature, encodeStory, writeSemanticFile } from './storage'
import { initWorkspace, readSnapshot, validateWorkspace } from './workspace'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-workspace-'))
	roots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('frozen v1 workspace foundation', () => {
	it('initializes only the exact manifest and validates an empty semantic graph', async () => {
		const root = await temporaryRoot()
		const result = await initWorkspace(root)
		expect(await readFile(join(root, '.spec/spec.yaml'), 'utf8'))
			.toBe('formatVersion: 1\n')
		const validation = await validateWorkspace(root)
		expect(validation)
			.toEqual({ valid: true, revision: result.revision, issues: [] })
		expect(result)
			.toEqual({
				revision: expect.stringMatching(/^[0-9a-f]{64}$/),
				changedNodes: [],
				deletedIds: [],
				changedEdges: { added: [], removed: [] },
			})
		expect((await readSnapshot(root)).ir)
			.toEqual({ formatVersion: 1, nodes: [], edges: [] })
	})

	it('refuses to replace an existing workspace even if empty', async () => {
		const root = await temporaryRoot()
		await mkdir(join(root, '.spec'))
		await expect(initWorkspace(root)).rejects.toMatchObject({
			code: 'invalid_request',
			details: { issues: [{ path: '.spec', reason: 'conflict' }] },
		})
		expect((await validateWorkspace(root)).valid)
			.toBe(false)
	})

	it('uses globally canonical UUIDv7 and excludes Markdown notes from semantic revision', async () => {
		const root = await temporaryRoot()
		await initWorkspace(root)
		const id = newUuidV7()
		expect(isUuidV7(id))
			.toBe(true)
		expect(isUuidV7(id.toUpperCase()))
			.toBe(false)
		const path = `.spec/features/${id}.md`
		const record = { id, title: 'Search', summary: 'Locate matching items', rules: [] }
		const originalNotes = '\n\n# Non-canonical notes\n'
		await writeSemanticFile(root, path, encodeFeature(record, originalNotes))
		const initial = await readSnapshot(root)
		expect(initial.ir)
			.toEqual({
				formatVersion: 1,
				nodes: [{ id, kind: 'feature', title: 'Search', summary: 'Locate matching items', source: { path } }],
				edges: [],
			})
		await writeSemanticFile(root, path, encodeFeature(record, '\n\n# Edited notes\n'))
		expect((await readSnapshot(root)).revision)
			.toBe(initial.revision)
		await writeSemanticFile(root, path, encodeFeature({ ...record, summary: 'A changed semantic summary' }, originalNotes))
		expect((await readSnapshot(root)).revision).not.toBe(initial.revision)
	})

	it('materializes Story motivates edges only to existing Features', async () => {
		const root = await temporaryRoot()
		await initWorkspace(root)
		const featureId = newUuidV7()
		const storyId = newUuidV7()
		await writeSemanticFile(root, `.spec/features/${featureId}.md`, encodeFeature({
			id: featureId,
			title: 'Search',
			summary: 'Item lookup',
			rules: [],
		}))
		const storyPath = `.spec/stories/${storyId}.md`
		await writeSemanticFile(root, storyPath, encodeStory({
			id: storyId,
			title: 'Find items',
			actor: 'User',
			goal: 'Locate item',
			value: 'Save time',
			motivates: [featureId],
		}))
		const snapshot = await readSnapshot(root)
		expect(snapshot.ir.nodes.map(node => node.id))
			.toEqual([featureId, storyId].sort())
		expect(snapshot.ir.edges)
			.toEqual([{ from: storyId, type: 'motivates', to: featureId }])
		await rm(join(root, `.spec/features/${featureId}.md`))
		const invalid = await validateWorkspace(root)
		expect(invalid.valid)
			.toBe(false)
		expect(invalid).not.toHaveProperty('revision')
		expect(invalid.issues)
			.toEqual([expect.objectContaining({
				source: { path: storyPath },
				path: 'motivates',
				reason: 'unresolved',
			})])
	})

	it('rejects unknown layout entries, invalid frontmatter, bad IDs and symbolic links', async () => {
		const root = await temporaryRoot()
		await initWorkspace(root)
		await writeFile(join(root, '.spec/extra.txt'), 'unexpected')
		await mkdir(join(root, '.spec/features'))
		await writeFile(join(root, '.spec/features/not-a-uuid.md'), '---\nid: invalid\n---\n')
		const id = newUuidV7()
		await writeFile(join(root, `.spec/features/${id}.md`), [
			'---',
			`id: ${id}`,
			'title: Search',
			'summary: Valid',
			'rules: []',
			'extra: unexpected',
			'---',
			'',
		].join('\n'))
		await symlink(join(root, '.spec/spec.yaml'), join(root, `.spec/features/${newUuidV7()}.md`))
		const invalid = await validateWorkspace(root)
		expect(invalid.valid)
			.toBe(false)
		expect(invalid.issues.map(issue => issue.reason))
			.toEqual(expect.arrayContaining(['unsupported', 'invalid_format']))
		expect(invalid).not.toHaveProperty('revision')
	})

	it('rejects duplicate semantic IDs across kinds', async () => {
		const root = await temporaryRoot()
		await initWorkspace(root)
		const id = newUuidV7()
		await writeSemanticFile(root, `.spec/features/${id}.md`, encodeFeature({
			id,
			title: 'Search',
			summary: 'Lookup',
			rules: [],
		}))
		await writeSemanticFile(root, `.spec/stories/${id}.md`, encodeStory({
			id,
			title: 'Find',
			actor: 'User',
			goal: 'Find',
			value: 'Fast',
			motivates: [id],
		}))
		const validation = await validateWorkspace(root)
		expect(validation.valid)
			.toBe(false)
		expect(validation.issues)
			.toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'duplicate' })]))
	})
})
