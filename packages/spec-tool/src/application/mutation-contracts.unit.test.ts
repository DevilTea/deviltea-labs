import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../cli/program'
import { REQUIRED_SECTIONS } from '../domain/model'
import { initWorkspace } from './init'
import { loadSnapshotFromWorkingTree } from './snapshot'

function bodyFor(kind: keyof typeof REQUIRED_SECTIONS): string {
	return REQUIRED_SECTIONS[kind].map(section => `## ${section}\nSubstantive content.`)
		.join('\n\n')
}

async function initializedWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-contracts-'))
	const result = await initWorkspace(root, { title: 'Contract tests' })
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

async function create(root: string, kind: string, title = kind): Promise<any> {
	return (await jsonCommand(root, ['artifact', 'create', '--kind', kind, '--title', title])).json.artifact
}

async function activate(root: string, artifact: any, kind: keyof typeof REQUIRED_SECTIONS): Promise<void> {
	expect((await jsonCommand(root, ['artifact', 'update', artifact.id, '--body', bodyFor(kind)])).exitCode)
		.toBe(0)
	expect((await jsonCommand(root, ['lifecycle', 'activate', artifact.id])).exitCode)
		.toBe(0)
}

function diagnosticCodes(result: { json: any }): string[] {
	return result.json.diagnostics.map((item: { code: string }) => item.code)
}

describe('spec-native mutation failure contracts', () => {
	it('rejects invalid artifact inputs and lifecycle transitions', async () => {
		const root = await initializedWorkspace()
		try {
			for (const [args, code] of [
				[['artifact', 'create', '--kind', 'unknown', '--title', 'Bad'], 'SPEC-CLI-INVALID'],
				[['artifact', 'create', '--kind', 'story', '--title', 'Bad', '--status', 'wat'], 'SPEC-CLI-INVALID'],
				[['artifact', 'create', '--kind', 'story', '--title', 'Bad', '--status', 'active', '--body', bodyFor('story')], 'SPEC-LIFECYCLE-INVALID'],
				[['artifact', 'get', 'missing'], 'SPEC-ARTIFACT-NOT-FOUND'],
				[['artifact', 'update', 'missing', '--title', 'x'], 'SPEC-ARTIFACT-NOT-FOUND'],
				[['artifact', 'delete', 'missing'], 'SPEC-ARTIFACT-NOT-FOUND'],
				[['artifact', 'list', '--kind', 'unknown'], 'SPEC-CLI-INVALID'],
				[['artifact', 'list', '--status', 'unknown'], 'SPEC-CLI-INVALID'],
			] as Array<[string[], string]>) {
				const result = await jsonCommand(root, args)
				expect(result.exitCode)
					.not.toBe(0)
				expect(diagnosticCodes(result))
					.toContain(code)
			}

			const story = await create(root, 'story', 'Story')
			const noUpdate = await jsonCommand(root, ['artifact', 'update', story.id])
			expect(diagnosticCodes(noUpdate))
				.toContain('SPEC-CLI-INVALID')
			const invalidTitle = await jsonCommand(root, ['artifact', 'update', story.id, '--title', ''])
			expect(diagnosticCodes(invalidTitle))
				.toContain('SPEC-ENVELOPE-INVALID')
			const conflictingBody = await jsonCommand(root, ['artifact', 'update', story.id, '--body', 'x', '--body-file', 'missing.md'])
			expect(diagnosticCodes(conflictingBody))
				.toContain('SPEC-CLI-INVALID')
			const missingBodyFile = await jsonCommand(root, ['artifact', 'update', story.id, '--body-file', 'missing.md'])
			expect(diagnosticCodes(missingBodyFile))
				.toContain('SPEC-IO-ERROR')

			const incomplete = await jsonCommand(root, ['lifecycle', 'activate', story.id])
			expect(incomplete.exitCode)
				.toBe(1)
			expect(diagnosticCodes(incomplete))
				.toContain('SPEC-BODY-INCOMPLETE')

			const change = await create(root, 'change', 'Change')
			const activateChange = await jsonCommand(root, ['lifecycle', 'activate', change.id])
			expect(diagnosticCodes(activateChange))
				.toContain('SPEC-LIFECYCLE-INVALID')
			const incompleteComplete = await jsonCommand(root, ['lifecycle', 'complete', change.id])
			expect(diagnosticCodes(incompleteComplete))
				.toContain('SPEC-BODY-INCOMPLETE')
			expect((await jsonCommand(root, ['artifact', 'update', change.id, '--body', bodyFor('change')])).exitCode)
				.toBe(0)
			const completed = await jsonCommand(root, ['lifecycle', 'complete', change.id])
			expect(completed.exitCode)
				.toBe(0)
			expect(completed.json.artifact.status)
				.toBe('completed')
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'complete', change.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'complete', story.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')

			const snapshot = await loadSnapshotFromWorkingTree(root)
			const project = snapshot.snapshot.artifacts.find(item => item.kind === 'project')!
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'activate', project.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'retire', project.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')

			const retiredDraft = await create(root, 'feature', 'Retire me')
			expect((await jsonCommand(root, ['lifecycle', 'retire', retiredDraft.id])).exitCode)
				.toBe(0)
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'retire', retiredDraft.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(diagnosticCodes(await jsonCommand(root, ['artifact', 'delete', retiredDraft.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')

			await activate(root, story, 'story')
			expect(diagnosticCodes(await jsonCommand(root, ['artifact', 'delete', story.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'activate', story.id])))
				.toContain('SPEC-LIFECYCLE-INVALID')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('fails every mutation family deterministically outside a Spec workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-no-workspace-'))
		try {
			for (const args of [
				['artifact', 'create', '--kind', 'story', '--title', 'Story'],
				['artifact', 'get', 'missing'],
				['artifact', 'update', 'missing', '--title', 'Story'],
				['artifact', 'delete', 'missing'],
				['artifact', 'list'],
				['relation', 'add', 'source', 'target', '--type', 'references'],
				['relation', 'remove', 'source', 'target', '--type', 'references'],
				['relation', 'list'],
				['lifecycle', 'activate', 'missing'],
				['lifecycle', 'retire', 'missing'],
				['lifecycle', 'supersede', 'replacement', 'replaced'],
				['resource', 'add', 'missing', '--location', 'https://example.com/a', '--role', 'reference', '--media-type', 'text/plain'],
				['resource', 'remove', 'missing', 'https://example.com/a'],
				['resource', 'list'],
				['resource', 'read', 'missing', 'https://example.com/a'],
			] as string[][]) {
				const result = await jsonCommand(root, args)
				expect(result.exitCode)
					.toBe(2)
				expect(diagnosticCodes(result))
					.toContain('SPEC-LAYOUT-INVALID')
			}
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects invalid supersession candidates', async () => {
		const root = await initializedWorkspace()
		try {
			const old = await create(root, 'story', 'Old')
			await activate(root, old, 'story')
			const replacement = await create(root, 'story', 'Replacement')
			const useCase = await create(root, 'use-case', 'Use case')

			for (const args of [
				['lifecycle', 'supersede', old.id, old.id],
				['lifecycle', 'supersede', useCase.id, old.id],
				['lifecycle', 'supersede', replacement.id, old.id],
			]) {
				const result = await jsonCommand(root, args)
				expect(result.exitCode)
					.toBe(1)
			}
			expect(diagnosticCodes(await jsonCommand(root, ['lifecycle', 'supersede'])))
				.toContain('SPEC-CLI-INVALID')

			await activate(root, replacement, 'story')
			const draftOld = await create(root, 'story', 'Draft old')
			const inactiveTarget = await jsonCommand(root, ['lifecycle', 'supersede', replacement.id, draftOld.id])
			expect(diagnosticCodes(inactiveTarget))
				.toContain('SPEC-LIFECYCLE-INVALID')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('spec-native relation command contracts', () => {
	it('enforces relation compatibility, target currentness, directions, and broad dependency cycles', async () => {
		const root = await initializedWorkspace()
		try {
			const story = await create(root, 'story', 'Story')
			const useCase = await create(root, 'use-case', 'Use case')
			const feature = await create(root, 'feature', 'Feature')
			const requirement = await create(root, 'requirement', 'Requirement')
			const decision = await create(root, 'decision', 'Decision')
			const policy = await create(root, 'policy', 'Policy')

			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', 'missing', story.id, '--type', 'references'])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', story.id, 'missing', '--type', 'references'])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', story.id, useCase.id, '--type', 'unknown'])))
				.toContain('SPEC-CLI-INVALID')

			for (const [source, target] of [[useCase, story], [feature, useCase], [requirement, feature]]) {
				expect((await jsonCommand(root, ['relation', 'add', source.id, target.id, '--type', 'refines'])).exitCode)
					.toBe(0)
			}
			expect((await jsonCommand(root, ['relation', 'add', story.id, useCase.id, '--type', 'refines'])).exitCode)
				.toBe(1)
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', useCase.id, story.id, '--type', 'refines'])))
				.toContain('SPEC-RELATION-DUPLICATE')

			const outgoing = await jsonCommand(root, ['relation', 'list', '--artifact', useCase.id, '--direction', 'outgoing'])
			const incoming = await jsonCommand(root, ['relation', 'list', '--artifact', story.id, '--direction', 'incoming'])
			const all = await jsonCommand(root, ['relation', 'list', '--artifact', story.id, '--direction', 'all'])
			expect(outgoing.json.relations)
				.toHaveLength(1)
			expect(incoming.json.relations)
				.toHaveLength(1)
			expect(all.json.relations)
				.toHaveLength(1)
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'list', '--artifact', 'missing'])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'list', '--direction', 'sideways'])))
				.toContain('SPEC-CLI-INVALID')
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'list', '--type', 'unknown'])))
				.toContain('SPEC-CLI-INVALID')

			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', decision.id, requirement.id, '--type', 'addresses'])))
				.toContain('SPEC-RELATION-INTEGRITY')
			await activate(root, requirement, 'requirement')
			expect((await jsonCommand(root, ['relation', 'add', decision.id, requirement.id, '--type', 'addresses'])).exitCode)
				.toBe(0)

			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'add', decision.id, policy.id, '--type', 'governed-by'])))
				.toContain('SPEC-RELATION-INTEGRITY')
			await activate(root, policy, 'policy')
			expect((await jsonCommand(root, ['relation', 'add', decision.id, policy.id, '--type', 'governed-by'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['lifecycle', 'retire', policy.id])).exitCode)
				.toBe(0)
			const historical = await jsonCommand(root, ['relation', 'list', '--artifact', decision.id])
			expect(historical.json.relations)
				.toContainEqual({ source: decision.id, type: 'governed-by', target: policy.id })
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'remove', decision.id, policy.id, '--type', 'governed-by'])))
				.toContain('SPEC-RELATION-INTEGRITY')
			expect((await jsonCommand(root, ['lifecycle', 'retire', requirement.id])).exitCode)
				.toBe(0)
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'remove', decision.id, requirement.id, '--type', 'addresses'])))
				.toContain('SPEC-RELATION-INTEGRITY')

			const depA = await create(root, 'story', 'A')
			const depB = await create(root, 'story', 'B')
			expect((await jsonCommand(root, ['relation', 'add', depA.id, depB.id, '--type', 'depends-on'])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['relation', 'add', depB.id, depA.id, '--type', 'depends-on'])).exitCode)
				.toBe(0)
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'remove', depA.id, story.id, '--type', 'references'])))
				.toContain('SPEC-RELATION-INTEGRITY')
			expect(diagnosticCodes(await jsonCommand(root, ['relation', 'remove', depA.id, depB.id, '--type', 'unknown'])))
				.toContain('SPEC-CLI-INVALID')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('spec-native resource command contracts', () => {
	it('validates descriptors, ownership, local paths, and removal/list/read behavior', async () => {
		const root = await initializedWorkspace()
		try {
			const owner = await create(root, 'story', 'Owner')
			const other = await create(root, 'story', 'Other')
			const ownerDir = join(root, '.spec', 'resources', owner.id)
			await mkdir(ownerDir, { recursive: true })
			await writeFile(join(ownerDir, 'ok.txt'), 'ok\n')
			const location = `.spec/resources/${owner.id}/ok.txt`

			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'add', 'missing', '--location', 'https://example.com/a', '--role', 'reference', '--media-type', 'text/plain'])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			for (const [fieldArgs, code] of [
				[['--location', '', '--role', 'evidence', '--media-type', 'text/plain'], 'SPEC-RESOURCE-INVALID'],
				[['--location', location, '--role', '', '--media-type', 'text/plain'], 'SPEC-RESOURCE-INVALID'],
				[['--location', location, '--role', 'evidence', '--media-type', ''], 'SPEC-RESOURCE-INVALID'],
				[['--location', 'http://example.com/a', '--role', 'reference', '--media-type', 'text/plain'], 'SPEC-RESOURCE-INVALID'],
				[['--location', '/tmp/outside', '--role', 'evidence', '--media-type', 'text/plain'], 'SPEC-RESOURCE-PATH'],
				[['--location', `.spec\\resources\\${owner.id}\\ok.txt`, '--role', 'evidence', '--media-type', 'text/plain'], 'SPEC-RESOURCE-PATH'],
				[['--location', `.spec/resources/${owner.id}/missing.txt`, '--role', 'evidence', '--media-type', 'text/plain'], 'SPEC-RESOURCE-NOT-FOUND'],
				[['--location', `.spec/resources/${other.id}/whatever.txt`, '--role', 'evidence', '--media-type', 'text/plain'], 'SPEC-RESOURCE-PATH'],
			] as Array<[string[], string]>) {
				const result = await jsonCommand(root, ['resource', 'add', owner.id, ...fieldArgs])
				expect(diagnosticCodes(result))
					.toContain(code)
			}

			const added = await jsonCommand(root, ['resource', 'add', owner.id, '--location', location, '--role', 'evidence', '--media-type', 'text/plain'])
			expect(added.exitCode)
				.toBe(0)
			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'add', owner.id, '--location', location, '--role', 'evidence', '--media-type', 'text/plain'])))
				.toContain('SPEC-RESOURCE-INVALID')
			const listed = await jsonCommand(root, ['resource', 'list', '--artifact', owner.id])
			expect(listed.json.resources)
				.toHaveLength(1)
			const read = await jsonCommand(root, ['resource', 'read', owner.id, location])
			expect(read.json.content)
				.toBe('ok\n')
			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'read', owner.id, `.spec/resources/${owner.id}/unknown.txt`])))
				.toContain('SPEC-RESOURCE-NOT-FOUND')
			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'remove', owner.id, `.spec/resources/${owner.id}/unknown.txt`])))
				.toContain('SPEC-RESOURCE-NOT-FOUND')
			expect((await jsonCommand(root, ['resource', 'remove', owner.id, location])).exitCode)
				.toBe(0)
			expect((await jsonCommand(root, ['resource', 'list', '--artifact', owner.id])).json.resources)
				.toHaveLength(0)
			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'list', '--artifact', 'missing'])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')

			const terminal = await create(root, 'story', 'Terminal')
			expect((await jsonCommand(root, ['lifecycle', 'retire', terminal.id])).exitCode)
				.toBe(0)
			expect(diagnosticCodes(await jsonCommand(root, ['resource', 'add', terminal.id, '--location', 'https://example.com/a', '--role', 'reference', '--media-type', 'text/plain'])))
				.toContain('SPEC-ARTIFACT-IMMUTABLE')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('spec-native mutation human output', () => {
	it('renders success and failure results without requiring JSON parsing', async () => {
		const root = await initializedWorkspace()
		try {
			const created = await humanCommand(root, ['artifact', 'create', '--kind', 'story', '--title', 'Human story'])
			expect(created.exitCode)
				.toBe(0)
			expect(created.stdout)
				.toContain('Created Artifact')
			const missing = await humanCommand(root, ['artifact', 'get', 'missing'])
			expect(missing.exitCode)
				.toBe(1)
			expect(missing.stdout)
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			const relations = await humanCommand(root, ['relation', 'list'])
			expect(relations.exitCode)
				.toBe(0)
			expect(relations.stdout)
				.toBe('')
			const resources = await humanCommand(root, ['resource', 'list'])
			expect(resources.exitCode)
				.toBe(0)
			expect(resources.stdout)
				.toBe('')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('renders non-empty artifact, relation, lifecycle, and Resource results', async () => {
		const root = await initializedWorkspace()
		try {
			const story = await create(root, 'story', 'Human source')
			const target = await create(root, 'story', 'Human target')
			const get = await humanCommand(root, ['artifact', 'get', story.id])
			expect(get.stdout)
				.toContain(`Artifact ${story.id}`)
			const updated = await humanCommand(root, ['artifact', 'update', story.id, '--title', 'Human updated'])
			expect(updated.stdout)
				.toContain('Updated Artifact')
			const list = await humanCommand(root, ['artifact', 'list', '--kind', 'story'])
			expect(list.stdout)
				.toContain('Human updated')

			const relation = await humanCommand(root, ['relation', 'add', story.id, target.id, '--type', 'references'])
			expect(relation.stdout)
				.toContain('\treferences\t')
			const relationList = await humanCommand(root, ['relation', 'list', '--artifact', story.id])
			expect(relationList.stdout)
				.toContain('\treferences\t')
			const relationFailure = await humanCommand(root, ['relation', 'remove', story.id, target.id, '--type', 'depends-on'])
			expect(relationFailure.stdout)
				.toContain('SPEC-RELATION-INTEGRITY')
			expect((await humanCommand(root, ['relation', 'remove', story.id, target.id, '--type', 'references'])).exitCode)
				.toBe(0)

			expect((await jsonCommand(root, ['artifact', 'update', story.id, '--body', bodyFor('story')])).exitCode)
				.toBe(0)
			const activated = await humanCommand(root, ['lifecycle', 'activate', story.id])
			expect(activated.stdout)
				.toContain('is now active')
			const activationFailure = await humanCommand(root, ['lifecycle', 'activate', story.id])
			expect(activationFailure.stdout)
				.toContain('SPEC-LIFECYCLE-INVALID')

			const resourceDir = join(root, '.spec', 'resources', story.id)
			await mkdir(resourceDir, { recursive: true })
			await writeFile(join(resourceDir, 'human.txt'), 'human resource\n')
			const location = `.spec/resources/${story.id}/human.txt`
			const resourceAdded = await humanCommand(root, ['resource', 'add', story.id, '--location', location, '--role', 'example', '--media-type', 'text/plain'])
			expect(resourceAdded.stdout)
				.toContain(`${location}\texample\ttext/plain`)
			const resourceList = await humanCommand(root, ['resource', 'list', '--artifact', story.id])
			expect(resourceList.stdout)
				.toContain(location)
			const resourceRead = await humanCommand(root, ['resource', 'read', story.id, location])
			expect(resourceRead.stdout)
				.toBe('human resource\n')
			const resourceReadFailure = await humanCommand(root, ['resource', 'read', story.id, 'https://example.com/missing'])
			expect(resourceReadFailure.stdout)
				.toContain('SPEC-RESOURCE-NOT-FOUND')
			const resourceRemoved = await humanCommand(root, ['resource', 'remove', story.id, location])
			expect(resourceRemoved.stdout)
				.toContain(location)

			const draft = await create(root, 'feature', 'Delete human')
			const deleted = await humanCommand(root, ['artifact', 'delete', draft.id])
			expect(deleted.stdout)
				.toContain('Deleted Artifact')
			const deleteFailure = await humanCommand(root, ['artifact', 'delete', draft.id])
			expect(deleteFailure.stdout)
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
