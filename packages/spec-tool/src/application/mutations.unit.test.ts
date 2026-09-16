import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../cli/program'
import { encodeArtifact } from '../domain/envelope'
import { REQUIRED_SECTIONS } from '../domain/model'
import { initWorkspace } from './init'
import { loadSnapshotFromWorkingTree } from './snapshot'

function bodyFor(kind: keyof typeof REQUIRED_SECTIONS, value = 'Substantive content.'): string {
	return REQUIRED_SECTIONS[kind].map(section => `## ${section}\n${value}`)
		.join('\n\n')
}

async function initializedWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-mutations-'))
	const result = await initWorkspace(root, { title: 'Mutation tests' })
	expect(result.ok)
		.toBe(true)
	return root
}

async function command(root: string, args: string[]): Promise<{ exitCode: number, json: any }> {
	const result = await runCli([...args, '--format', 'json'], { cwd: root }, { version: 'test' })
	return { exitCode: result.exitCode, json: JSON.parse(result.stdout) }
}

describe('spec-native artifact, relation, and lifecycle mutations', () => {
	it('supports CRUD, activation, atomic supersede ordering, and draft delete integrity', async () => {
		const root = await initializedWorkspace()
		try {
			const created = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Old story'])
			expect(created.exitCode)
				.toBe(0)
			const oldId = created.json.artifact.id
			expect(created.json.artifact.status)
				.toBe('draft')

			const updated = await command(root, ['artifact', 'update', oldId, '--title', 'Updated story'])
			expect(updated.exitCode)
				.toBe(0)
			expect(updated.json.artifact.title)
				.toBe('Updated story')
			expect(updated.json.artifact.status)
				.toBe('draft')

			const bodyUpdated = await command(root, ['artifact', 'update', oldId, '--body', bodyFor('story')])
			expect(bodyUpdated.exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'activate', oldId])).exitCode)
				.toBe(0)

			const replacementCreated = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Replacement'])
			const replacementId = replacementCreated.json.artifact.id
			const replacementBody = await command(root, ['artifact', 'update', replacementId, '--body', bodyFor('story')])
			expect(replacementBody.exitCode)
				.toBe(0)
			const superseded = await command(root, ['lifecycle', 'supersede', replacementId, oldId])
			expect(superseded.exitCode)
				.toBe(0)
			expect(superseded.json.replacement.status)
				.toBe('active')
			expect(superseded.json.replaced.status)
				.toBe('superseded')

			const loaded = await loadSnapshotFromWorkingTree(root)
			const replacement = loaded.snapshot.artifacts.find(artifact => artifact.id === replacementId)!
			const old = loaded.snapshot.artifacts.find(artifact => artifact.id === oldId)!
			expect(replacement.relations)
				.toContainEqual({ type: 'supersedes', target: oldId })
			expect(old.status)
				.toBe('superseded')
			expect((await command(root, ['artifact', 'update', oldId, '--title', 'Nope'])).exitCode)
				.toBe(1)
			const incomingTarget = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Incoming target'])
			const useCase = await command(root, ['artifact', 'create', '--kind', 'use-case', '--title', 'Use case'])
			const relation = await command(root, ['relation', 'add', useCase.json.artifact.id, incomingTarget.json.artifact.id, '--type', 'refines'])
			expect(relation.exitCode)
				.toBe(0)
			expect((await command(root, ['artifact', 'delete', incomingTarget.json.artifact.id])).exitCode)
				.toBe(1)
			expect((await command(root, ['relation', 'remove', useCase.json.artifact.id, incomingTarget.json.artifact.id, '--type', 'refines'])).exitCode)
				.toBe(0)
			expect((await command(root, ['artifact', 'delete', incomingTarget.json.artifact.id])).exitCode)
				.toBe(0)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('protects and resumes a replacement-first intermediate state', async () => {
		const root = await initializedWorkspace()
		try {
			const old = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Old'])
			const oldId = old.json.artifact.id
			expect((await command(root, ['artifact', 'update', oldId, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'activate', oldId])).exitCode)
				.toBe(0)
			const replacement = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Replacement'])
			const replacementId = replacement.json.artifact.id
			expect((await command(root, ['artifact', 'update', replacementId, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			const loaded = await loadSnapshotFromWorkingTree(root)
			const replacementArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === replacementId)!
			await writeFile(join(root, replacementArtifact.path!), encodeArtifact({
				...replacementArtifact,
				status: 'active',
				relations: [{ type: 'supersedes', target: oldId }],
			}))

			const retired = await command(root, ['lifecycle', 'retire', replacementId])
			expect(retired.exitCode)
				.toBe(1)
			expect(retired.json.diagnostics.map((item: { code: string }) => item.code))
				.toContain('SPEC-RELATION-INTEGRITY')
			const after = await loadSnapshotFromWorkingTree(root)
			expect(after.snapshot.artifacts.find(artifact => artifact.id === replacementId)?.status)
				.toBe('active')
			expect(after.snapshot.artifacts.find(artifact => artifact.id === oldId)?.status)
				.toBe('active')

			const resumed = await command(root, ['lifecycle', 'supersede', replacementId, oldId])
			expect(resumed.exitCode)
				.toBe(0)
			expect(resumed.json.replaced.status)
				.toBe('superseded')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('transfers current replacement targets across chained supersession', async () => {
		const root = await initializedWorkspace()
		try {
			const original = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Original'])
			const originalId = original.json.artifact.id
			expect((await command(root, ['artifact', 'update', originalId, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'activate', originalId])).exitCode)
				.toBe(0)

			const first = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'First replacement'])
			const firstId = first.json.artifact.id
			expect((await command(root, ['artifact', 'update', firstId, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'supersede', firstId, originalId])).exitCode)
				.toBe(0)

			const second = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Second replacement'])
			const secondId = second.json.artifact.id
			expect((await command(root, ['artifact', 'update', secondId, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			const chained = await command(root, ['lifecycle', 'supersede', secondId, firstId])
			expect(chained.exitCode)
				.toBe(0)

			const loaded = await loadSnapshotFromWorkingTree(root)
			const originalArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === originalId)!
			const firstArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === firstId)!
			const secondArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === secondId)!
			expect(originalArtifact.status)
				.toBe('superseded')
			expect(firstArtifact.status)
				.toBe('superseded')
			expect(firstArtifact.relations.filter(relation => relation.type === 'supersedes'))
				.toEqual([])
			expect(secondArtifact.status)
				.toBe('active')
			expect(secondArtifact.relations.filter(relation => relation.type === 'supersedes'))
				.toEqual(expect.arrayContaining([
					{ type: 'supersedes', target: firstId },
					{ type: 'supersedes', target: originalId },
				]))
			expect((await command(root, ['validate'])).exitCode)
				.toBe(0)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('requires every supersedes edge source to remain active', async () => {
		const root = await initializedWorkspace()
		try {
			const old = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Old'])
			const first = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'First replacement'])
			const second = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Second replacement'])
			for (const id of [old.json.artifact.id, first.json.artifact.id, second.json.artifact.id]) {
				expect((await command(root, ['artifact', 'update', id, '--body', bodyFor('story')])).exitCode)
					.toBe(0)
				expect((await command(root, ['lifecycle', 'activate', id])).exitCode)
					.toBe(0)
			}

			const loaded = await loadSnapshotFromWorkingTree(root)
			const oldArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === old.json.artifact.id)!
			const firstArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === first.json.artifact.id)!
			const secondArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === second.json.artifact.id)!
			await writeFile(join(root, oldArtifact.path!), encodeArtifact({ ...oldArtifact, status: 'superseded' }))
			await writeFile(join(root, firstArtifact.path!), encodeArtifact({ ...firstArtifact, relations: [{ type: 'supersedes', target: oldArtifact.id }] }))
			await writeFile(join(root, secondArtifact.path!), encodeArtifact({ ...secondArtifact, relations: [{ type: 'supersedes', target: oldArtifact.id }] }))

			const rejected = await command(root, ['lifecycle', 'retire', firstArtifact.id])
			expect(rejected.exitCode)
				.toBe(1)
			expect(rejected.json.diagnostics.map((item: { code: string }) => item.code))
				.toContain('SPEC-RELATION-INTEGRITY')

			expect((await command(root, ['relation', 'remove', firstArtifact.id, oldArtifact.id, '--type', 'supersedes'])).exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'retire', firstArtifact.id])).exitCode)
				.toBe(0)
			expect((await command(root, ['validate'])).exitCode)
				.toBe(0)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('enforces relation kind and active-target rules while preserving historical edges', async () => {
		const root = await initializedWorkspace()
		try {
			const decision = await command(root, ['artifact', 'create', '--kind', 'decision', '--title', 'Decision'])
			const requirement = await command(root, ['artifact', 'create', '--kind', 'requirement', '--title', 'Requirement'])
			const activeBody = await command(root, ['artifact', 'update', requirement.json.artifact.id, '--body', bodyFor('requirement')])
			expect(activeBody.exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'activate', requirement.json.artifact.id])).exitCode)
				.toBe(0)
			expect((await command(root, ['relation', 'add', decision.json.artifact.id, requirement.json.artifact.id, '--type', 'addresses'])).exitCode)
				.toBe(0)
			expect((await command(root, ['lifecycle', 'retire', requirement.json.artifact.id])).exitCode)
				.toBe(0)
			const listed = await command(root, ['relation', 'list', '--artifact', decision.json.artifact.id])
			expect(listed.json.relations)
				.toContainEqual({ source: decision.json.artifact.id, type: 'addresses', target: requirement.json.artifact.id })

			const invalidRefines = await command(root, ['relation', 'add', decision.json.artifact.id, requirement.json.artifact.id, '--type', 'refines'])
			expect(invalidRefines.exitCode)
				.toBe(1)
			const policy = await command(root, ['artifact', 'create', '--kind', 'policy', '--title', 'Policy'])
			const governed = await command(root, ['relation', 'add', decision.json.artifact.id, policy.json.artifact.id, '--type', 'governed-by'])
			expect(governed.exitCode)
				.toBe(1)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('spec-native Resource mutations', () => {
	it('supports local and https descriptors and rejects traversal, symlinks, cross-owner paths, and URL reads', async () => {
		const root = await initializedWorkspace()
		try {
			const first = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'First'])
			const second = await command(root, ['artifact', 'create', '--kind', 'story', '--title', 'Second'])
			const firstId = first.json.artifact.id
			const secondId = second.json.artifact.id
			const firstDir = join(root, '.spec', 'resources', firstId)
			const secondDir = join(root, '.spec', 'resources', secondId)
			await mkdir(firstDir, { recursive: true })
			await mkdir(secondDir, { recursive: true })
			await writeFile(join(firstDir, 'note.txt'), 'resource text\n')
			await writeFile(join(secondDir, 'other.txt'), 'other\n')
			const location = `.spec/resources/${firstId}/note.txt`
			expect((await command(root, ['resource', 'add', firstId, '--location', location, '--role', 'evidence', '--media-type', 'text/plain', '--description', 'A note'])).exitCode)
				.toBe(0)
			const read = await command(root, ['resource', 'read', firstId, location])
			expect(read.exitCode)
				.toBe(0)
			expect(read.json.content)
				.toBe('resource text\n')

			const traversal = await command(root, ['resource', 'add', firstId, '--location', `.spec/resources/${firstId}/../${secondId}/other.txt`, '--role', 'evidence', '--media-type', 'text/plain'])
			expect(traversal.exitCode)
				.toBe(1)
			const crossOwner = await command(root, ['resource', 'add', firstId, '--location', `.spec/resources/${secondId}/other.txt`, '--role', 'evidence', '--media-type', 'text/plain'])
			expect(crossOwner.exitCode)
				.toBe(1)

			const outside = join(root, 'outside.txt')
			await writeFile(outside, 'outside\n')
			await symlink(outside, join(firstDir, 'escape.txt'))
			const symlinkResult = await command(root, ['resource', 'add', firstId, '--location', `.spec/resources/${firstId}/escape.txt`, '--role', 'evidence', '--media-type', 'text/plain'])
			expect(symlinkResult.exitCode)
				.toBe(1)

			const url = 'https://example.com/spec.json'
			const urlAdded = await command(root, ['resource', 'add', firstId, '--location', url, '--role', 'reference', '--media-type', 'application/json'])
			expect(urlAdded.exitCode)
				.toBe(0)
			const urlRead = await command(root, ['resource', 'read', firstId, url])
			expect(urlRead.exitCode)
				.toBe(1)
			expect(urlRead.json)
				.toMatchObject({ diagnostics: [{ code: 'SPEC-RESOURCE-REMOTE' }] })
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
