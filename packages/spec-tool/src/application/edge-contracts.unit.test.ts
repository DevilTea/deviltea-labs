import type { Artifact, ArtifactKind, RelationEntry, Status } from '../domain/model'
import type { ProjectSnapshot } from './snapshot'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMap, parseDocument } from 'yaml'
import { runCli } from '../cli/program'
import { decodeArtifact, decodeEnvelope, encodeArtifact, isCanonicalEnvelope } from '../domain/envelope'
import { generateUuidV7 } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { REQUIRED_SECTIONS, SCHEMA_BY_KIND } from '../domain/model'
import { decodeResources } from '../domain/resources'
import { parseFrontmatterDocument } from '../parsing/frontmatter'
import { extractSections, isMeaningful, isPlaceholderOnly } from '../parsing/markdown'
import { decodeConfig } from '../repository/config'
import { discoverWorkspaceFiles, readWorkspaceConfig, resolveWorkspaceRoot } from '../repository/discovery'
import { validateWorkspaceLayout } from '../repository/workspace'
import { initWorkspace } from './init'
import {
	activateArtifact,
	addRelation,
	addResource,
	completeArtifact,
	createArtifact,
	deleteArtifact,
	getArtifact,
	listArtifacts,
	listRelations,
	listResources,
	readResource,
	removeRelation,
	removeResource,
	retireArtifact,
	supersedeArtifacts,
	updateArtifact,
	validateRelationGraph,
	validateResourceIntegrity,
} from './mutations'
import { validateSnapshot } from './snapshot-validation'

const IDS = [
	'018f0f42-1234-7abc-8def-0123456789a1',
	'018f0f42-1234-7abc-8def-0123456789a2',
	'018f0f42-1234-7abc-8def-0123456789a3',
	'018f0f42-1234-7abc-8def-0123456789a4',
	'018f0f42-1234-7abc-8def-0123456789a5',
	'018f0f42-1234-7abc-8def-0123456789a6',
	'018f0f42-1234-7abc-8def-0123456789a7',
	'018f0f42-1234-7abc-8def-0123456789a8',
] as const

function bodyFor(kind: ArtifactKind): string {
	return REQUIRED_SECTIONS[kind].map(section => `## ${section}\nSubstantive content.`)
		.join('\n\n')
}

function artifact(kind: ArtifactKind, id: string, status: Status = kind === 'project' ? 'active' : 'draft', relations: RelationEntry[] = []): Artifact {
	return {
		schema: SCHEMA_BY_KIND[kind],
		kind,
		id,
		title: `${kind} ${id.at(-1)}`,
		status,
		relations,
		resources: [],
		body: bodyFor(kind),
		path: `.spec/${kind === 'story' ? 'stories' : `${kind}s`}/${id}.md`,
	}
}

function codes(result: { diagnostics: Array<{ code: string }> }): string[] {
	return result.diagnostics.map(item => item.code)
}

async function initializedWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spec-coverage-'))
	const result = await initWorkspace(root, { title: 'Coverage contracts' })
	expect(result.ok)
		.toBe(true)
	return root
}

describe('relation graph edge contracts', () => {
	it('covers invalid relation types, missing targets, kind rules, cycles, and replacement currentness', () => {
		const story = artifact('story', IDS[0], 'active')
		const useCase = artifact('use-case', IDS[1], 'active')
		const feature = artifact('feature', IDS[2], 'active')
		const requirement = artifact('requirement', IDS[3], 'active')
		const decision = artifact('decision', IDS[4], 'active')
		const policy = artifact('policy', IDS[5], 'active')

		expect(validateRelationGraph([{ ...story, relations: [{ type: 'unknown', target: useCase.id }] }, useCase])
			.map(item => item.code))
			.toContain('SPEC-RELATION-INVALID')
		expect(validateRelationGraph([{ ...story, relations: [{ type: 'references', target: IDS[7] }] }])
			.map(item => item.code))
			.toContain('SPEC-RELATION-INTEGRITY')
		expect(validateRelationGraph([{ ...story, relations: [{ type: 'references', target: useCase.id }, { type: 'references', target: useCase.id }] }, useCase])
			.map(item => item.code))
			.toContain('SPEC-RELATION-DUPLICATE')

		for (const source of [
			{ ...story, relations: [{ type: 'refines', target: useCase.id }] },
			{ ...story, relations: [{ type: 'addresses', target: requirement.id }] },
			{ ...decision, relations: [{ type: 'governed-by', target: requirement.id }] },
			{ ...story, relations: [{ type: 'supersedes', target: useCase.id }] },
		]) {
			expect(validateRelationGraph([source, story, useCase, requirement, decision, policy])
				.some(item => item.code === 'SPEC-RELATION-KIND'))
				.toBe(true)
		}

		expect(validateRelationGraph([
			story,
			{ ...useCase, relations: [{ type: 'refines', target: story.id }] },
			{ ...feature, relations: [{ type: 'refines', target: useCase.id }] },
			{ ...requirement, relations: [{ type: 'refines', target: feature.id }] },
			{ ...decision, relations: [{ type: 'addresses', target: requirement.id }, { type: 'governed-by', target: policy.id }] },
			policy,
		]))
			.toEqual([])

		expect(validateRelationGraph([{ ...story, relations: [{ type: 'supersedes', target: story.id }] }])
			.map(item => item.code))
			.toContain('SPEC-RELATION-CYCLE')

		const old = artifact('story', IDS[6], 'superseded')
		const replacement = { ...story, relations: [{ type: 'supersedes', target: old.id }] }
		expect(validateRelationGraph([replacement, old]))
			.toEqual([])
		expect(validateRelationGraph([{ ...replacement, status: 'draft' }, old])
			.map(item => item.code))
			.toContain('SPEC-RELATION-INTEGRITY')
		expect(validateRelationGraph([replacement, { ...old, status: 'active' }]))
			.toEqual([])
		expect(validateRelationGraph([replacement, { ...old, status: 'retired' }])
			.map(item => item.code))
			.toContain('SPEC-RELATION-INTEGRITY')
		expect(validateRelationGraph([old])
			.map(item => item.code))
			.toContain('SPEC-RELATION-INTEGRITY')

		const first = artifact('story', IDS[0], 'active', [{ type: 'supersedes', target: IDS[1] }])
		const second = artifact('story', IDS[1], 'superseded', [{ type: 'supersedes', target: IDS[0] }])
		expect(validateRelationGraph([first, second])
			.map(item => item.code))
			.toContain('SPEC-RELATION-CYCLE')
	})
})

describe('direct mutation API edge contracts', () => {
	it('covers CRUD defaults, filters, lifecycle failures, and relation list modes', async () => {
		const root = await initializedWorkspace()
		try {
			const created = await createArtifact(root, { kind: 'story', title: 'Story', id: IDS[0] })
			expect(created.ok)
				.toBe(true)
			expect(created.value?.status)
				.toBe('draft')
			expect((await createArtifact(root, { kind: 'story', title: 'Duplicate', id: IDS[0] })).ok)
				.toBe(false)
			expect((await createArtifact(root, { kind: 'story', title: 'Bad status', status: 'active', id: IDS[1], body: bodyFor('story') })).ok)
				.toBe(false)
			expect((await createArtifact(root, { kind: 'project', title: 'Second project', id: IDS[2], body: bodyFor('project') })).ok)
				.toBe(false)

			expect((await getArtifact(root, IDS[0])).value?.id)
				.toBe(IDS[0])
			expect(codes(await getArtifact(root, IDS[7])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect((await listArtifacts(root)).value?.some(item => item.id === IDS[0]))
				.toBe(true)
			expect((await listArtifacts(root, { kind: 'story' })).value)
				.toHaveLength(1)
			expect((await listArtifacts(root, { status: 'draft' })).value)
				.toHaveLength(1)
			expect(codes(await listArtifacts(root, { kind: 'bogus' as ArtifactKind })))
				.toContain('SPEC-CLI-INVALID')
			expect(codes(await listArtifacts(root, { status: 'bogus' as Status })))
				.toContain('SPEC-CLI-INVALID')

			expect(codes(await updateArtifact(root, { id: IDS[7], title: 'Missing' })))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await updateArtifact(root, { id: IDS[0] })))
				.toContain('SPEC-CLI-INVALID')
			expect(codes(await updateArtifact(root, { id: IDS[0], title: 'bad\nname' })))
				.toContain('SPEC-ENVELOPE-INVALID')
			expect((await updateArtifact(root, { id: IDS[0], body: bodyFor('story') })).ok)
				.toBe(true)
			expect((await activateArtifact(root, IDS[0])).ok)
				.toBe(true)
			expect(codes(await activateArtifact(root, IDS[0])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(codes(await deleteArtifact(root, IDS[0])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect((await retireArtifact(root, IDS[0])).value?.status)
				.toBe('retired')
			expect(codes(await updateArtifact(root, { id: IDS[0], title: 'terminal' })))
				.toContain('SPEC-ARTIFACT-IMMUTABLE')

			expect((await createArtifact(root, { kind: 'change', title: 'Change', id: IDS[1] })).ok)
				.toBe(true)
			expect(codes(await completeArtifact(root, IDS[1])))
				.toContain('SPEC-BODY-INCOMPLETE')
			expect((await updateArtifact(root, { id: IDS[1], body: bodyFor('change') })).ok)
				.toBe(true)
			expect((await completeArtifact(root, IDS[1])).value?.status)
				.toBe('completed')
			expect(codes(await completeArtifact(root, IDS[1])))
				.toContain('SPEC-LIFECYCLE-INVALID')
			expect(codes(await completeArtifact(root, IDS[7])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')

			expect((await createArtifact(root, { kind: 'story', title: 'Source', id: IDS[2] })).ok)
				.toBe(true)
			expect((await createArtifact(root, { kind: 'story', title: 'Target', id: IDS[3] })).ok)
				.toBe(true)
			expect(codes(await addRelation(root, IDS[2], IDS[7], 'references')))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await addRelation(root, IDS[7], IDS[3], 'references')))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await addRelation(root, IDS[2], IDS[3], 'bogus' as any)))
				.toContain('SPEC-CLI-INVALID')
			expect((await addRelation(root, IDS[2], IDS[3], 'references')).ok)
				.toBe(true)
			expect(codes(await addRelation(root, IDS[2], IDS[3], 'references')))
				.toContain('SPEC-RELATION-DUPLICATE')
			expect((await listRelations(root)).value)
				.toHaveLength(1)
			expect((await listRelations(root, { artifactId: IDS[2], direction: 'outgoing' })).value)
				.toHaveLength(1)
			expect((await listRelations(root, { artifactId: IDS[3], direction: 'incoming' })).value)
				.toHaveLength(1)
			expect((await listRelations(root, { artifactId: IDS[2], direction: 'all' })).value)
				.toHaveLength(1)
			expect(codes(await listRelations(root, { artifactId: IDS[7] })))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await listRelations(root, { type: 'bogus' as any })))
				.toContain('SPEC-CLI-INVALID')
			expect(codes(await removeRelation(root, IDS[2], IDS[3], 'bogus' as any)))
				.toContain('SPEC-CLI-INVALID')
			expect((await removeRelation(root, IDS[2], IDS[3], 'references')).ok)
				.toBe(true)
			expect(codes(await removeRelation(root, IDS[2], IDS[3], 'references')))
				.toContain('SPEC-RELATION-INTEGRITY')
			expect((await deleteArtifact(root, IDS[2])).ok)
				.toBe(true)
			expect(codes(await deleteArtifact(root, IDS[2])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('covers supersession candidate rejection and successful active replacement retry', async () => {
		const root = await initializedWorkspace()
		try {
			for (const [id, kind] of [[IDS[0], 'story'], [IDS[1], 'story'], [IDS[2], 'use-case']] as const) {
				expect((await createArtifact(root, { kind, title: kind, id, body: bodyFor(kind) })).ok)
					.toBe(true)
			}
			expect((await activateArtifact(root, IDS[0])).ok)
				.toBe(true)
			expect(codes(await supersedeArtifacts(root, IDS[7], IDS[0])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await supersedeArtifacts(root, IDS[1], IDS[7])))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await supersedeArtifacts(root, IDS[0], IDS[0])))
				.toContain('SPEC-RELATION-CYCLE')
			expect(codes(await supersedeArtifacts(root, IDS[2], IDS[0])))
				.toContain('SPEC-RELATION-KIND')
			expect((await supersedeArtifacts(root, IDS[1], IDS[0])).ok)
				.toBe(true)
			expect(codes(await supersedeArtifacts(root, IDS[1], IDS[0])))
				.toContain('SPEC-LIFECYCLE-INVALID')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

it('covers direct envelope decoding fallbacks and canonical checks', () => {
	const missingMapping = decodeEnvelope({ mapping: undefined }, 'missing.md')
	expect(codes(missingMapping))
		.toContain('SPEC-ENVELOPE-INVALID')

	const document = parseDocument(`
1: numeric-key
schema: 123
kind: 456
id: 789
title: []
status: draft
relations:
  nested: value
resources:
  1: numeric-nested-key
`)
	expect(isMap(document.contents))
		.toBe(true)
	const decoded = decodeEnvelope({ mapping: isMap(document.contents) ? document.contents : undefined }, 'direct.md')
	expect(decoded.envelope)
		.toBeNull()
	expect(decoded.diagnostics.map(item => item.code))
		.toEqual(expect.arrayContaining(['SPEC-ENVELOPE-INVALID', 'SPEC-SCHEMA-INVALID', 'SPEC-IDENTITY-INVALID']))

	const partial = parseDocument(`schema: spec/story@1\nkind: bogus\nid: ${IDS[0]}\ntitle: ''\nstatus: draft\n`)
	expect(isMap(partial.contents))
		.toBe(true)
	const partialResult = decodeEnvelope({ mapping: isMap(partial.contents) ? partial.contents : undefined }, 'partial.md')
	expect(partialResult.envelope)
		.toBeNull()
	expect(partialResult.candidateId)
		.toBe(IDS[0])
	expect(partialResult.candidateKind)
		.toBe('bogus')

	const valid = artifact('story', IDS[0])
	expect(isCanonicalEnvelope(valid))
		.toBe(true)
	expect(isCanonicalEnvelope({ ...valid, schema: 'spec/story@999' }))
		.toBe(false)
	expect(isCanonicalEnvelope({ ...valid, id: 'not-an-id' }))
		.toBe(false)
})

describe('yAML, Markdown, and workspace discovery edge contracts', () => {
	it('covers aliases, anchors, custom tags, non-mapping documents, and missing envelope fields', () => {
		for (const source of [
			'schema: &s spec/config@1\ncopy: *s\n',
			'schema: !custom spec/config@1\n',
			'1: value\n',
			'<<: value\n',
			'schema: spec/config@1\nschema: spec/config@1\n',
			'[]\n',
			'\n',
			'not: [valid\n',
		]) {
			expect(decodeConfig(source).config)
				.toBeNull()
		}

		const parsed = parseFrontmatterDocument('root: &r\n  nested: value\ncopy: *r\ntagged: !custom x\n1: numeric\n', 'x.md')
		expect(parsed.diagnostics.length)
			.toBeGreaterThan(0)
		expect(parseFrontmatterDocument('- item\n', 'x.md').mapping)
			.toBeUndefined()
		expect(parseFrontmatterDocument('', 'x.md').mapping)
			.toBeUndefined()
		expect(parseFrontmatterDocument('x: [\n', 'x.md').diagnostics.length)
			.toBeGreaterThan(0)

		const missingFields = decodeArtifact(`---\nkind: story\nid: ${IDS[0]}\ntitle: Story\nstatus: draft\n---\n`, `.spec/stories/${IDS[0]}.md`)
		expect(missingFields.artifact)
			.toBeNull()
		expect(codes(missingFields))
			.toContain('SPEC-ENVELOPE-INVALID')
	})

	it('covers Markdown fence, heading, comments, code, and placeholder branches', () => {
		expect(extractSections('## One ###\nA\n\n### Child\nB\n\n~~~\n## Hidden\n~~~\n\n## Two\t###\nC\n')
			.map(section => section.heading))
			.toEqual(['One', 'Two'])
		expect(extractSections('##   \nignored\n'))
			.toEqual([])
		expect(isMeaningful('<!-- only -->\n# Heading\n'))
			.toBe(false)
		expect(isMeaningful('```ts\nconst x = 1\n```'))
			.toBe(true)
		expect(isPlaceholderOnly('```txt\nTODO\n```'))
			.toBe(false)
		expect(isPlaceholderOnly('**TODO**'))
			.toBe(true)
		expect(isPlaceholderOnly('TODO plus real text'))
			.toBe(false)
	})

	it('covers explicit/ancestor resolution plus unexpected, nested, symlink, resource-root, and config entries', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-discovery-'))
		try {
			expect((await resolveWorkspaceRoot(root, 'explicit')).root)
				.toBe(join(root, 'explicit'))
			expect(codes(await resolveWorkspaceRoot(root)))
				.toContain('SPEC-LAYOUT-INVALID')

			await mkdir(join(root, '.spec', 'stories'), { recursive: true })
			await mkdir(join(root, '.spec', 'resources'), { recursive: true })
			await writeFile(join(root, '.spec', 'config.yaml'), 'schema: spec/config@1\n')
			const nested = join(root, 'a', 'b')
			await mkdir(nested, { recursive: true })
			expect((await resolveWorkspaceRoot(nested)).root)
				.toBe(root)

			await writeFile(join(root, '.spec', 'unexpected.txt'), 'x')
			await writeFile(join(root, '.spec', 'stories', 'unexpected.txt'), 'x')
			await mkdir(join(root, '.spec', 'stories', 'nested'))
			await symlink(join(root, '.spec', 'config.yaml'), join(root, '.spec', 'stories', 'link.md'))
			expect((await discoverWorkspaceFiles(root)).diagnostics.map(item => item.code))
				.toContain('SPEC-LAYOUT-INVALID')

			expect((await readWorkspaceConfig(root)).config)
				.toEqual({ schema: 'spec/config@1' })
			await rm(join(root, '.spec', 'config.yaml'))
			await mkdir(join(root, '.spec', 'config.yaml'))
			expect(codes(await readWorkspaceConfig(root)))
				.toContain('SPEC-LAYOUT-INVALID')

			await rm(join(root, '.spec', 'resources'), { recursive: true })
			await writeFile(join(root, '.spec', 'resources'), 'not a directory')
			expect((await discoverWorkspaceFiles(root)).diagnostics.map(item => item.code))
				.toContain('SPEC-LAYOUT-INVALID')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('resource path and descriptor edge contracts', () => {
	it('covers descriptor validation and local path containment branches', async () => {
		const root = await initializedWorkspace()
		try {
			expect((await createArtifact(root, { kind: 'story', title: 'Owner', id: IDS[0] })).ok)
				.toBe(true)
			const ownerDir = join(root, '.spec', 'resources', IDS[0])
			await mkdir(ownerDir, { recursive: true })
			await writeFile(join(ownerDir, 'note.txt'), 'note\n')
			const location = `.spec/resources/${IDS[0]}/note.txt`

			for (const input of [
				{ location: '', role: 'evidence', mediaType: 'text/plain', description: '' },
				{ location, role: '', mediaType: 'text/plain', description: '' },
				{ location, role: 'evidence', mediaType: '', description: '' },
				{ location, role: 'evidence', mediaType: 'text/plain', description: 1 as any },
			]) {
				expect(codes(await addResource(root, { artifactId: IDS[0], ...input })))
					.toContain('SPEC-RESOURCE-INVALID')
			}

			for (const badLocation of [
				`.spec\\resources\\${IDS[0]}\\note.txt`,
				'/absolute/path.txt',
				`.spec/resources/${IDS[0]}/../note.txt`,
				`.spec/resources/${IDS[0]}/./note.txt`,
				`.spec/resources/${IDS[0]}//note.txt`,
				`.spec/resources/${IDS[1]}/note.txt`,
			]) {
				const result = await addResource(root, { artifactId: IDS[0], location: badLocation, role: 'evidence', mediaType: 'text/plain', description: '' })
				expect(result.ok)
					.toBe(false)
				expect(result.diagnostics.some(item => item.code === 'SPEC-RESOURCE-PATH'))
					.toBe(true)
			}

			expect(codes(await addResource(root, { artifactId: IDS[0], location: 'ftp://example.com/file', role: 'reference', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-INVALID')
			expect(codes(await addResource(root, { artifactId: IDS[0], location: 'https://[', role: 'reference', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-INVALID')
			expect(codes(await addResource(root, { artifactId: IDS[0], location: `.spec/resources/${IDS[0]}/missing.txt`, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-NOT-FOUND')

			await mkdir(join(ownerDir, 'folder'))
			expect(codes(await addResource(root, { artifactId: IDS[0], location: `.spec/resources/${IDS[0]}/folder`, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-PATH')
			await writeFile(join(ownerDir, 'component'), 'file')
			expect(codes(await addResource(root, { artifactId: IDS[0], location: `.spec/resources/${IDS[0]}/component/child.txt`, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-PATH')
			await symlink(join(ownerDir, 'note.txt'), join(ownerDir, 'link.txt'))
			expect(codes(await addResource(root, { artifactId: IDS[0], location: `.spec/resources/${IDS[0]}/link.txt`, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-PATH')

			expect(codes(await addResource(root, { artifactId: IDS[7], location, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect((await addResource(root, { artifactId: IDS[0], location, role: 'evidence', mediaType: 'text/plain', description: '' })).ok)
				.toBe(true)
			expect(codes(await addResource(root, { artifactId: IDS[0], location, role: 'evidence', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-RESOURCE-INVALID')
			expect((await listResources(root)).value)
				.toHaveLength(1)
			expect((await listResources(root, { artifactId: IDS[0] })).value)
				.toHaveLength(1)
			expect(codes(await listResources(root, { artifactId: IDS[7] })))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect((await readResource(root, IDS[0], location)).value?.encoding)
				.toBe('utf8')
			expect(codes(await readResource(root, IDS[7], location)))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await readResource(root, IDS[0], 'missing')))
				.toContain('SPEC-RESOURCE-NOT-FOUND')
			expect(codes(await removeResource(root, IDS[7], location)))
				.toContain('SPEC-ARTIFACT-NOT-FOUND')
			expect(codes(await removeResource(root, IDS[0], 'missing')))
				.toContain('SPEC-RESOURCE-NOT-FOUND')
			expect((await removeResource(root, IDS[0], location)).ok)
				.toBe(true)

			const terminal = await createArtifact(root, { kind: 'story', title: 'Terminal owner', id: IDS[1] })
			expect(terminal.ok)
				.toBe(true)
			expect((await retireArtifact(root, IDS[1])).ok)
				.toBe(true)
			expect(codes(await addResource(root, { artifactId: IDS[1], location: 'https://example.com/x', role: 'reference', mediaType: 'text/plain', description: '' })))
				.toContain('SPEC-ARTIFACT-IMMUTABLE')
			expect(codes(await removeResource(root, IDS[1], 'https://example.com/x')))
				.toContain('SPEC-ARTIFACT-IMMUTABLE')
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('covers descriptor decoder and integrity duplicate/fallback branches', async () => {
		expect(decodeResources('not-an-array').diagnostics[0]?.code)
			.toBe('SPEC-RESOURCE-INVALID')
		expect(decodeResources([null, { location: '', role: '', mediaType: '', description: 1, extra: true }]).diagnostics.length)
			.toBeGreaterThan(5)
		expect(decodeResources([{ location: 'x', role: 'evidence', mediaType: 'text/plain', description: '' }]).resources)
			.toHaveLength(1)

		const root = await mkdtemp(join(tmpdir(), 'spec-resource-integrity-'))
		try {
			const invalid = artifact('story', IDS[0])
			invalid.resources = [
				{ location: 'ftp://example.com/x', role: '', mediaType: '', description: 1 as any },
				{ location: 'ftp://example.com/x', role: 'reference', mediaType: 'text/plain', description: '' },
			]
			const result = await validateResourceIntegrity(root, [invalid])
			expect(result.filter(item => item.code === 'SPEC-RESOURCE-INVALID').length)
				.toBeGreaterThan(2)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('covers remote read branches from structurally valid persisted descriptors', async () => {
		const root = await initializedWorkspace()
		try {
			const created = await createArtifact(root, { kind: 'story', title: 'Remote owner', id: IDS[0] })
			const owner = created.value!
			for (const remote of ['https://example.com/x', 'ftp://example.com/x']) {
				await writeFile(join(root, owner.path!), encodeArtifact({
					...owner,
					resources: [{ location: remote, role: 'reference', mediaType: 'text/plain', description: '' }],
				}))
				expect(codes(await readResource(root, owner.id, remote)))
					.toContain('SPEC-RESOURCE-REMOTE')
			}
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('snapshot, layout, identity, and CLI branch contracts', () => {
	it('covers snapshot placement, duplicate identity, malformed file, and missing project branches', () => {
		const project = artifact('project', IDS[0], 'active')
		const story = artifact('story', IDS[1], 'active')
		const snapshot: ProjectSnapshot = {
			root: '/tmp/spec',
			config: { schema: 'spec/config@1' },
			files: [
				{ path: `.spec/stories/${IDS[0]}.md`, absolutePath: '/tmp/1', artifact: { ...story, id: IDS[0] }, candidateId: IDS[0], diagnostics: [] },
				{ path: `.spec/features/${IDS[0]}.md`, absolutePath: '/tmp/2', artifact: { ...story, id: IDS[0] }, candidateId: IDS[0], diagnostics: [] },
				{ path: '.spec/stories/not-a-uuid.md', absolutePath: '/tmp/3', artifact: story, candidateId: story.id, diagnostics: [] },
				{ path: '.spec/unknown/file.md', absolutePath: '/tmp/4', artifact: null, diagnostics: [] },
				{ path: '.spec/stories/no-extension', absolutePath: '/tmp/5', artifact: null, diagnostics: [] },
			],
			artifacts: [story],
			diagnostics: [],
			complete: false,
		}
		const result = validateSnapshot(snapshot)
		expect(result.valid)
			.toBe(false)
		expect(result.complete)
			.toBe(false)
		expect(result.diagnostics.map(item => item.code))
			.toEqual(expect.arrayContaining(['SPEC-PATH-INVALID', 'SPEC-IDENTITY-DUPLICATE', 'SPEC-PROJECT-COUNT']))

		const validProjectSnapshot: ProjectSnapshot = { ...snapshot, files: [], artifacts: [project], complete: true }
		expect(validateSnapshot(validProjectSnapshot).projectCount)
			.toBe(1)
	})

	it('covers workspace layout wrong-type and missing entry branches', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-layout-'))
		try {
			await writeFile(join(root, '.spec'), 'not a directory')
			expect(codes(await validateWorkspaceLayout(root)))
				.toContain('SPEC-LAYOUT-INVALID')
			await rm(join(root, '.spec'))

			await mkdir(join(root, '.spec'))
			await writeFile(join(root, '.spec', 'stories'), 'not a directory')
			await writeFile(join(root, '.spec', 'resources'), 'not a directory')
			await mkdir(join(root, '.spec', 'config.yaml'))
			const result = await validateWorkspaceLayout(root)
			expect(result.diagnostics.filter(item => item.code === 'SPEC-LAYOUT-INVALID').length)
				.toBeGreaterThan(3)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('covers UUID timestamp clamping and human Commander error/help paths', async () => {
		expect(validateStatus('story', 'not-a-status')[0]?.code)
			.toBe('SPEC-STATUS-INVALID')
		expect(generateUuidV7(-1)
			.startsWith('00000000-0000-7'))
			.toBe(true)
		expect(generateUuidV7(Number.MAX_SAFE_INTEGER)
			.startsWith('ffffffff-ffff-7'))
			.toBe(true)
		expect(generateUuidV7(Number.NaN))
			.toMatch(/^[0-9a-f-]+$/)

		const cwd = await mkdtemp(join(tmpdir(), 'spec-cli-branch-'))
		try {
			const bad = await runCli(['definitely-not-a-command'], { cwd }, { version: 'test' })
			expect(bad.exitCode)
				.toBe(2)
			expect(bad.stderr).not.toBe('')
			const help = await runCli(['--help'], { cwd }, { version: 'test' })
			expect(help.exitCode)
				.toBe(0)
		}
		finally {
			await rm(cwd, { recursive: true, force: true })
		}
	})
})
