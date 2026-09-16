import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../cli/program'
import { encodeArtifact } from '../domain/envelope'
import { compareBytewise } from '../domain/text'
import { initWorkspace } from './init'
import { loadSnapshotFromWorkingTree } from './snapshot'

async function initializedWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-query-'))
	const result = await initWorkspace(root, { title: 'Query tests' })
	expect(result.ok)
		.toBe(true)
	return root
}

async function jsonCommand(root: string, args: string[]): Promise<{ exitCode: number, json: any }> {
	const result = await runCli([...args, '--format', 'json'], { cwd: root }, { version: 'test' })
	return { exitCode: result.exitCode, json: JSON.parse(result.stdout) }
}

async function humanCommand(root: string, args: string[]): Promise<{ exitCode: number, stdout: string }> {
	const result = await runCli(args, { cwd: root }, { version: 'test' })
	return { exitCode: result.exitCode, stdout: result.stdout }
}

async function create(root: string, kind: string, title: string, body?: string): Promise<any> {
	const args = ['artifact', 'create', '--kind', kind, '--title', title]
	if (body !== undefined)
		args.push('--body', body)
	const result = await jsonCommand(root, args)
	expect(result.exitCode)
		.toBe(0)
	return result.json.artifact
}

describe('spec-native query and validation contracts', () => {
	it('searches title/body deterministically with filters and stable human/json results', async () => {
		const root = await initializedWorkspace()
		try {
			await create(root, 'feature', 'Needle in title', 'ordinary body')
			await create(root, 'story', 'Other title', 'Body contains NEEDLE here.')
			await create(root, 'story', 'Needle twice', 'needle also appears in this body')
			await create(root, 'story', 'Unrelated', 'nothing to see')

			const search = await jsonCommand(root, ['search', 'needle'])
			expect(search.exitCode)
				.toBe(0)
			expect(search.json.schema)
				.toBe('spec/search-result@1')
			expect(search.json.matches)
				.toHaveLength(3)
			expect(search.json.matches.map((match: any) => match.matchedFields))
				.toEqual([['title'], ['body'], ['title', 'body']])
			const paths = search.json.matches.map((match: any) => match.artifact.path)
			expect(paths)
				.toEqual([...paths].sort(compareBytewise))

			const filtered = await jsonCommand(root, ['search', 'needle', '--kind', 'story', '--status', 'draft'])
			expect(filtered.json.matches)
				.toHaveLength(2)
			expect(filtered.json.matches.every((match: any) => match.artifact.kind === 'story'))
				.toBe(true)
			expect(filtered.json.filters)
				.toEqual({ kind: 'story', status: 'draft' })

			const human = await humanCommand(root, ['search', 'needle', '--kind', 'story'])
			expect(human.exitCode)
				.toBe(0)
			expect(human.stdout)
				.toContain('\tbody\tOther title\n')

			const noMatches = await jsonCommand(root, ['search', 'definitely-absent'])
			expect(noMatches.exitCode)
				.toBe(0)
			expect(noMatches.json.matches)
				.toEqual([])

			const invalidStatus = await jsonCommand(root, ['search', 'needle', '--status', 'nope'])
			expect(invalidStatus.exitCode)
				.toBe(2)
			expect(invalidStatus.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-CLI-INVALID')

			const invalidKind = await jsonCommand(root, ['search', 'needle', '--kind', 'nope'])
			expect(invalidKind.exitCode)
				.toBe(2)
			expect(invalidKind.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-CLI-INVALID')
			const empty = await jsonCommand(root, ['search', '   '])
			expect(empty.exitCode)
				.toBe(2)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('traces only refines upward, downward, or both with deterministic graph results', async () => {
		const root = await initializedWorkspace()
		try {
			const story = await create(root, 'story', 'Story')
			const useCase = await create(root, 'use-case', 'Use case')
			const feature = await create(root, 'feature', 'Feature')
			const requirement = await create(root, 'requirement', 'Requirement')
			const decision = await create(root, 'decision', 'Decision')
			expect((await jsonCommand(root, ['relation', 'add', useCase.id, story.id, '--type', 'refines'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['relation', 'add', feature.id, useCase.id, '--type', 'refines'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['relation', 'add', requirement.id, feature.id, '--type', 'refines'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['relation', 'add', feature.id, decision.id, '--type', 'references'])).exitCode)
				.toBe(0)

			const up = await jsonCommand(root, ['trace', feature.id, '--direction', 'up'])
			expect(up.json.schema)
				.toBe('spec/trace-result@1')
			expect(new Set(up.json.artifacts.map((artifact: any) => artifact.id)))
				.toEqual(new Set([feature.id, useCase.id, story.id]))
			expect(up.json.relations)
				.toHaveLength(2)
			expect(up.json.relations.every((relation: any) => relation.type === 'refines'))
				.toBe(true)

			const down = await jsonCommand(root, ['trace', feature.id, '--direction', 'down'])
			expect(new Set(down.json.artifacts.map((artifact: any) => artifact.id)))
				.toEqual(new Set([feature.id, requirement.id]))
			expect(down.json.relations)
				.toEqual([{ source: requirement.id, type: 'refines', target: feature.id }])

			const both = await jsonCommand(root, ['trace', feature.id])
			expect(new Set(both.json.artifacts.map((artifact: any) => artifact.id)))
				.toEqual(new Set([story.id, useCase.id, feature.id, requirement.id]))
			expect(both.json.artifacts.map((artifact: any) => artifact.id))
				.not.toContain(decision.id)
			const artifactPaths = both.json.artifacts.map((artifact: any) => artifact.path)
			expect(artifactPaths)
				.toEqual([...artifactPaths].sort(compareBytewise))

			const human = await humanCommand(root, ['trace', feature.id, '--direction', 'down'])
			expect(human.stdout)
				.toContain(`Trace ${feature.id} (down)\nArtifacts:\n`)
			expect(human.stdout)
				.toContain('Relations:\n')

			const invalid = await jsonCommand(root, ['trace', feature.id, '--direction', 'sideways'])
			expect(invalid.exitCode)
				.toBe(2)
			expect(invalid.json.schema)
				.toBe('spec/trace-result@1')
			const missing = await jsonCommand(root, ['trace', '01990000-0000-7000-8000-000000000000'])
			expect(missing.exitCode)
				.toBe(1)
			expect(missing.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('keeps stable JSON envelopes when no Spec workspace can be resolved', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-query-missing-'))
		try {
			const search = await jsonCommand(root, ['search', 'anything'])
			expect(search.exitCode)
				.toBe(2)
			expect(search.json.schema)
				.toBe('spec/search-result@1')
			expect(search.json.ok)
				.toBe(false)

			const trace = await jsonCommand(root, ['trace', '01990000-0000-7000-8000-000000000000'])
			expect(trace.exitCode)
				.toBe(2)
			expect(trace.json.schema)
				.toBe('spec/trace-result@1')
			expect(trace.json.ok)
				.toBe(false)

			const validate = await jsonCommand(root, ['validate'])
			expect(validate.exitCode)
				.toBe(2)
			expect(validate.json.schema)
				.toBe('spec/validation-result@1')
			expect(validate.json.valid)
				.toBe(false)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects search and trace when the current relation graph is invalid', async () => {
		const root = await initializedWorkspace()
		try {
			const first = await create(root, 'story', 'First story')
			const second = await create(root, 'story', 'Second story')
			const loaded = await loadSnapshotFromWorkingTree(root)
			const firstArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === first.id)!
			await writeFile(join(root, firstArtifact.path!), encodeArtifact({
				...firstArtifact,
				relations: [{ type: 'refines', target: second.id }],
			}))

			const search = await jsonCommand(root, ['search', 'story'])
			expect(search.exitCode)
				.toBe(1)
			expect(search.json.matches)
				.toEqual([])
			expect(search.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-RELATION-KIND')

			const trace = await jsonCommand(root, ['trace', first.id])
			expect(trace.exitCode)
				.toBe(1)
			expect(trace.json.artifacts)
				.toEqual([])
			expect(trace.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-RELATION-KIND')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('validate integrates relation graph invariants while preserving replacement-first recovery', async () => {
		const root = await initializedWorkspace()
		try {
			const old = await create(root, 'story', 'Old', '## Actor\nA\n\n## Goal\nG\n\n## Value\nV')
			const replacement = await create(root, 'story', 'Replacement', '## Actor\nA\n\n## Goal\nG\n\n## Value\nV')
			expect((await jsonCommand(root, ['lifecycle', 'activate', old.id])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['lifecycle', 'activate', replacement.id])).exitCode)
				.toBe(0)
			const loaded = await loadSnapshotFromWorkingTree(root)
			const replacementArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === replacement.id)!
			await writeFile(join(root, replacementArtifact.path!), encodeArtifact({
				...replacementArtifact,
				relations: [{ type: 'supersedes', target: old.id }],
			}))
			const recovery = await jsonCommand(root, ['validate'])
			expect(recovery.exitCode)
				.toBe(0)
			expect(recovery.json.valid)
				.toBe(true)

			const oldArtifact = loaded.snapshot.artifacts.find(artifact => artifact.id === old.id)!
			await writeFile(join(root, oldArtifact.path!), encodeArtifact({
				...oldArtifact,
				relations: [{ type: 'refines', target: replacement.id }],
			}))
			const wrongKind = await jsonCommand(root, ['validate'])
			expect(wrongKind.exitCode)
				.toBe(1)
			expect(wrongKind.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-RELATION-KIND')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('validate checks local Resource existence/symlinks while accepting descriptor-only https Resources', async () => {
		const root = await initializedWorkspace()
		const outside = await mkdtemp(join(tmpdir(), 'spec-query-outside-'))
		try {
			const story = await create(root, 'story', 'Resource owner')
			const ownerDir = join(root, '.spec', 'resources', story.id)
			await mkdir(ownerDir, { recursive: true })
			const local = `.spec/resources/${story.id}/evidence.txt`
			await writeFile(join(root, local), 'evidence\n')
			expect((await jsonCommand(root, ['resource', 'add', story.id, '--location', local, '--role', 'evidence', '--media-type', 'text/plain'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['resource', 'add', story.id, '--location', 'https://example.com/reference', '--role', 'reference', '--media-type', 'text/html'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['validate'])).exitCode)
				.toBe(0)

			await unlink(join(root, local))
			const missing = await jsonCommand(root, ['validate'])
			expect(missing.exitCode)
				.toBe(1)
			expect(missing.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-RESOURCE-NOT-FOUND')

			await writeFile(join(outside, 'outside.txt'), 'outside\n')
			await symlink(join(outside, 'outside.txt'), join(root, local))
			const linked = await jsonCommand(root, ['validate'])
			expect(linked.exitCode)
				.toBe(1)
			expect(linked.json.diagnostics.map((item: any) => item.code))
				.toContain('SPEC-RESOURCE-PATH')
		}
		finally {
			await rm(root, { recursive: true, force: true })
			await rm(outside, { recursive: true, force: true })
		}
	})
})
