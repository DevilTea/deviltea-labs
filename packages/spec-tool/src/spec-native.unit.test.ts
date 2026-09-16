import type { ArtifactKind, Status } from './domain/model'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initWorkspace } from './application/init'
import { loadSnapshotFromWorkingTree } from './application/snapshot'
import { validateSnapshot } from './application/snapshot-validation'
import { runCli } from './cli/program'
import { validateBody } from './domain/body-schemas'
import { aggregateDiagnostics, diagnostic, sortDiagnostics } from './domain/diagnostics'
import { decodeArtifact, encodeArtifact, encodeEnvelope } from './domain/envelope'
import { generateUuidV7, isUuidV7, validateUuidV7 } from './domain/identity'
import { isStatusAllowed, requiresCompleteBody, validateStatus } from './domain/lifecycle'
import { ALLOWED_STATUSES, ARTIFACT_KINDS, PLURAL_DIRECTORY_BY_KIND, REQUIRED_SECTIONS, SCHEMA_BY_KIND } from './domain/model'
import { decodeRelations } from './domain/relations'
import { decodeResources } from './domain/resources'
import { parseFrontmatterDocument, splitFrontmatter } from './parsing/frontmatter'
import { extractSections, isMeaningful, isPlaceholderOnly } from './parsing/markdown'
import { decodeConfig, encodeConfig } from './repository/config'
import { resolveWorkspaceRoot } from './repository/discovery'
import { canonicalArtifactPath, isCanonicalArtifactPath, parseArtifactPath } from './repository/layout'

const ID = '018f0f42-1234-7abc-8def-0123456789ab'
const OTHER_ID = '018f0f42-1234-7abc-8def-0123456789ac'

function bodyFor(kind: typeof ARTIFACT_KINDS[number], value = 'Substantive content.'): string {
	return REQUIRED_SECTIONS[kind].map(section => `## ${section}\n${value}`)
		.join('\n\n')
}

function artifact(kind: ArtifactKind, status: Status = 'active', id = ID) {
	return {
		schema: SCHEMA_BY_KIND[kind],
		kind,
		id,
		title: `${kind} title`,
		status,
		relations: [],
		resources: [],
		body: bodyFor(kind),
	}
}

describe('spec-native model', () => {
	it('defines the exact kinds, schemas, directories, and status applicability', () => {
		expect(ARTIFACT_KINDS)
			.toEqual(['project', 'prd', 'story', 'use-case', 'feature', 'requirement', 'decision', 'policy', 'change'])
		expect(Object.values(SCHEMA_BY_KIND))
			.toEqual(ARTIFACT_KINDS.map(kind => `spec/${kind}@1`))
		expect(Object.values(PLURAL_DIRECTORY_BY_KIND))
			.toEqual(['projects', 'prds', 'stories', 'use-cases', 'features', 'requirements', 'decisions', 'policies', 'changes'])
		expect(ALLOWED_STATUSES.project)
			.toEqual(['active'])
		expect(ALLOWED_STATUSES.change)
			.toEqual(['draft', 'completed', 'retired'])
		expect(isStatusAllowed('story', 'active'))
			.toBe(true)
		expect(isStatusAllowed('story', 'retired'))
			.toBe(true)
		expect(requiresCompleteBody('project', 'active'))
			.toBe(true)
		expect(requiresCompleteBody('change', 'completed'))
			.toBe(true)
		expect(requiresCompleteBody('story', 'draft'))
			.toBe(false)
		expect(requiresCompleteBody('story', 'retired'))
			.toBe(false)
	})

	it('generates and validates opaque UUIDv7 identities', () => {
		const generated = generateUuidV7(0x018F0F421234)
		expect(isUuidV7(generated))
			.toBe(true)
		expect(generated.slice(0, 13))
			.toBe('018f0f42-1234')
		expect(validateUuidV7(generated))
			.toEqual([])
		expect(isUuidV7('018f0f42-1234-6abc-8def-0123456789ab'))
			.toBe(false)
		expect(validateUuidV7('not-an-id', '.spec/stories/bad.md')[0]?.code)
			.toBe('SPEC-IDENTITY-INVALID')
		expect(isUuidV7(null))
			.toBe(false)
	})

	it('validates kind/status pairs without importing transition rules', () => {
		expect(validateStatus('project', 'draft', 'project.md', ID)[0]?.code)
			.toBe('SPEC-STATUS-INVALID')
		expect(validateStatus('change', 'active', 'change.md', ID)[0]?.message)
			.toContain('not allowed')
		expect(validateStatus('change', 'completed'))
			.toEqual([])
	})

	it('checks required body sections deterministically by lifecycle', () => {
		for (const kind of ARTIFACT_KINDS) {
			expect(validateBody(kind, kind === 'change' ? 'completed' : 'active', bodyFor(kind)))
				.toEqual([])
		}
		expect(validateBody('story', 'draft', ''))
			.toEqual([])
		expect(validateBody('story', 'retired', ''))
			.toEqual([])
		const missing = validateBody('story', 'active', '## Actor\nTODO\n\n## Goal\n\n## Value\nDone.')
		expect(missing.map(item => item.section))
			.toEqual(['Actor', 'Goal'])
		expect(missing.some(item => item.message.includes('placeholder-only')))
			.toBe(true)
		expect(isMeaningful('<!-- comment -->\n\n'))
			.toBe(false)
		expect(isPlaceholderOnly(' - **TBD**! '))
			.toBe(true)
		expect(isPlaceholderOnly('TBD\nA real sentence.'))
			.toBe(false)
		expect(extractSections('```md\n## Hidden\nTODO\n```\n\n## Visible\nText.'))
			.toEqual([{ heading: 'Visible', line: 6, content: 'Text.\n' }])
	})

	it('decodes and encodes the exact common envelope and owned descriptors', () => {
		const source = encodeArtifact({
			...artifact('story'),
			relations: [{ type: 'refines', target: OTHER_ID }],
			resources: [{ location: 'schemas/story.json', role: 'contract', mediaType: 'application/json', description: 'Contract schema.' }],
		})
		const decoded = decodeArtifact(source, `.spec/stories/${ID}.md`)
		expect(decoded.diagnostics)
			.toEqual([])
		expect(decoded.artifact)
			.toMatchObject({ kind: 'story', id: ID, relations: [{ type: 'refines', target: OTHER_ID }] })
		expect(source)
			.toContain(`relations:\n  - type: refines\n    target: ${OTHER_ID}`)
		expect(source).not.toMatch(/summary:|tags:/)
		const empty = encodeEnvelope(artifact('story'))
		expect(empty)
			.toContain('relations: []')
		expect(empty)
			.toContain('resources: []')
	})

	it('rejects unknown fields, incompatible schemas/statuses, and malformed descriptors', () => {
		const invalid = `---\nschema: spec/prd@1\nkind: story\nid: ${ID}\ntitle: Bad\nstatus: completed\nsummary: old\nrelations:\n  - type: refines\n    target: bad\nresources:\n  - location: x\n    role: ''\n    mediaType: text/plain\n---\n`
		const result = decodeArtifact(invalid, `.spec/stories/${ID}.md`)
		expect(result.artifact)
			.toBeNull()
		expect(result.diagnostics.map(item => item.code))
			.toEqual(expect.arrayContaining(['SPEC-ENVELOPE-INVALID', 'SPEC-SCHEMA-INVALID', 'SPEC-STATUS-INVALID', 'SPEC-RELATION-INVALID', 'SPEC-RESOURCE-INVALID']))
		const malformed = decodeArtifact('no frontmatter', '.spec/stories/x.md')
		expect(malformed.diagnostics[0]?.code)
			.toBe('SPEC-ARTIFACT-PARSE')
		const numericDescriptorKey = decodeArtifact(`---\nschema: spec/story@1\nkind: story\nid: ${ID}\ntitle: Bad nested key\nstatus: draft\nrelations: []\nresources:\n  - location: a.txt\n    role: evidence\n    mediaType: text/plain\n    description: ''\n    1: extra\n---\n`, `.spec/stories/${ID}.md`)
		expect(numericDescriptorKey.diagnostics.map(item => item.code))
			.toContain('SPEC-ARTIFACT-PARSE')
	})

	it('supports structural relation/resource decoding and rejects unknown fields', () => {
		expect(decodeRelations([{ type: 'references', target: ID }]).diagnostics)
			.toEqual([])
		expect(decodeRelations([null, { type: '', target: 'bad', extra: true }]).diagnostics.length)
			.toBeGreaterThan(2)
		expect(decodeResources([{ location: 'a.txt', role: 'evidence', mediaType: 'text/plain', description: '' }]).diagnostics)
			.toEqual([])
		expect(decodeResources([{ location: '', role: 'x', mediaType: 1, description: 'd', extra: true }]).diagnostics.length)
			.toBeGreaterThan(2)
	})

	it('does not allow prototype keys to smuggle inherited Resource fields', () => {
		const source = `---\nschema: spec/story@1\nkind: story\nid: ${ID}\ntitle: Proto\nstatus: draft\nrelations: []\nresources:\n  - __proto__:\n      location: hidden.txt\n      role: evidence\n      mediaType: text/plain\n      description: hidden\n---\n`
		const result = decodeArtifact(source, `.spec/stories/${ID}.md`)
		expect(result.artifact)
			.toBeNull()
		expect(result.diagnostics.map(item => item.code))
			.toContain('SPEC-RESOURCE-INVALID')
	})
})

describe('frontmatter, config, and layout', () => {
	it('parses frontmatter boundaries and reports forbidden YAML structure', () => {
		const split = splitFrontmatter('---\na: b\n---\nbody')
		expect(split)
			.toMatchObject({ ok: true, bodyText: 'body', bodyStartLine: 4 })
		expect(splitFrontmatter('a: b').ok)
			.toBe(false)
		expect(splitFrontmatter('---\na: b').ok)
			.toBe(false)
		const parsed = parseFrontmatterDocument('schema: &s spec/story@1\ncopy: *s\n<<: nope\nschema: again\n', '.spec/x.md')
		expect(parsed.mapping)
			.toBeDefined()
		expect(parsed.diagnostics.length)
			.toBeGreaterThan(0)
		expect(parsed.locate(0)?.line)
			.toBe(1)
	})

	it('accepts only the exact one-field config', () => {
		expect(encodeConfig())
			.toBe('schema: spec/config@1\n')
		expect(decodeConfig(encodeConfig()).config)
			.toEqual({ schema: 'spec/config@1' })
		expect(decodeConfig('schema: spec/config@2\n').config)
			.toBeNull()
		expect(decodeConfig('schema: spec/config@1\nextra: true\n').diagnostics[0]?.code)
			.toBe('SPEC-CONFIG-INVALID')
		expect(decodeConfig('schema: spec/config@1\n1: extra\n').diagnostics[0]?.code)
			.toBe('SPEC-CONFIG-INVALID')
		expect(decodeConfig('- nope\n').config)
			.toBeNull()
	})

	it('constructs and parses canonical paths', () => {
		const path = canonicalArtifactPath('use-case', ID)
		expect(path)
			.toBe(`.spec/use-cases/${ID}.md`)
		expect(parseArtifactPath(path))
			.toEqual({ directory: '.spec/use-cases', id: ID })
		expect(parseArtifactPath('.spec/use-cases/not-an-id.md'))
			.toBeUndefined()
		expect(isCanonicalArtifactPath(path, 'use-case', ID))
			.toBe(true)
	})
})

describe('workspace persistence and validation', () => {
	it('initializes and validates a complete .spec workspace without Git', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-native-'))
		try {
			const initialized = await initWorkspace(root, { title: 'Demo', vision: 'A clear vision.' })
			expect(initialized.ok)
				.toBe(true)
			expect(initialized.plan?.artifact.kind)
				.toBe('project')
			expect(initialized.plan?.artifact.id).not.toBe('PROJECT')
			expect(await readFile(join(root, '.spec/config.yaml'), 'utf8'))
				.toBe('schema: spec/config@1\n')
			const loaded = await loadSnapshotFromWorkingTree(root)
			expect(validateSnapshot(loaded.snapshot))
				.toMatchObject({ valid: true, artifactCount: 1, projectCount: 1 })
			expect((await initWorkspace(root)).diagnostics[0]?.code)
				.toBe('SPEC-LAYOUT-INVALID')
			await mkdir(join(root, '.engineering'))
			await writeFile(join(root, '.engineering', 'ef.yaml'), 'schema: ef/config@1\n')
			expect(validateSnapshot((await loadSnapshotFromWorkingTree(root)).snapshot).valid)
				.toBe(true)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('rejects invalid project titles before publishing a workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-init-invalid-'))
		try {
			const initialized = await initWorkspace(root, { title: 'Bad\nTitle' })
			expect(initialized.ok)
				.toBe(false)
			expect(initialized.diagnostics[0]?.code)
				.toBe('SPEC-ENVELOPE-INVALID')
			await expect(readFile(join(root, '.spec', 'config.yaml'), 'utf8'))
				.rejects.toBeDefined()
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('refuses any pre-existing .spec entry without replacing a symlinked workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-init-symlink-'))
		const target = await mkdtemp(join(tmpdir(), 'spec-init-target-'))
		try {
			await writeFile(join(target, 'sentinel.txt'), 'keep\n')
			await symlink(target, join(root, '.spec'), process.platform === 'win32' ? 'junction' : 'dir')
			const initialized = await initWorkspace(root, { title: 'Must not replace' })
			expect(initialized.ok)
				.toBe(false)
			expect(initialized.diagnostics[0]?.code)
				.toBe('SPEC-LAYOUT-INVALID')
			expect((await lstat(join(root, '.spec'))).isSymbolicLink())
				.toBe(true)
			expect(await readFile(join(target, 'sentinel.txt'), 'utf8'))
				.toBe('keep\n')
		}
		finally {
			await rm(root, { recursive: true, force: true })
			await rm(target, { recursive: true, force: true })
		}
	})

	it('reports id duplication, path placement, body incompleteness, and project count', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-invalid-'))
		try {
			await initWorkspace(root)
			const projectId = (await loadSnapshotFromWorkingTree(root)).snapshot.artifacts.find(item => item.kind === 'project')!.id
			await writeFile(join(root, '.spec', 'stories', `${ID}.md`), encodeArtifact({ ...artifact('story', 'active'), id: projectId, path: undefined }))
			await writeFile(join(root, '.spec', 'prds', `${OTHER_ID}.md`), encodeArtifact({ ...artifact('prd', 'draft', OTHER_ID), body: '' }))
			await writeFile(join(root, '.spec', 'prds', `${ID}.md`), encodeArtifact({ ...artifact('project', 'active', ID) }))
			const validation = validateSnapshot((await loadSnapshotFromWorkingTree(root)).snapshot)
			expect(validation.valid)
				.toBe(false)
			expect(validation.projectCount)
				.toBe(2)
			expect(validation.diagnostics.map(item => item.code))
				.toEqual(expect.arrayContaining(['SPEC-IDENTITY-DUPLICATE']))
			await unlink(join(root, '.spec', 'projects', `${projectId}.md`))
			await unlink(join(root, '.spec', 'prds', `${ID}.md`))
			expect(validateSnapshot((await loadSnapshotFromWorkingTree(root)).snapshot).projectCount)
				.toBe(0)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('resolves a workspace from a nested directory and fails outside one', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-root-'))
		try {
			await initWorkspace(root)
			const nested = join(root, 'src', 'nested')
			await mkdir(nested, { recursive: true })
			expect((await resolveWorkspaceRoot(nested)).root)
				.toBe(root)
			expect((await resolveWorkspaceRoot(root, '.')).root)
				.toBe(root)
			const outside = await mkdtemp(join(tmpdir(), 'spec-outside-'))
			try {
				expect((await resolveWorkspaceRoot(outside)).root)
					.toBeUndefined()
			}
			finally {
				await rm(outside, { recursive: true, force: true })
			}
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('cLI', () => {
	it('initializes, validates, versions, and rejects unknown commands', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-cli-'))
		try {
			const initialized = await runCli(['init', '--format', 'json', '--no-input'], { cwd: root }, { version: '9.9.9' })
			expect(initialized.exitCode)
				.toBe(0)
			expect(JSON.parse(initialized.stdout))
				.toMatchObject({ schema: 'spec/init-result@1', ok: true })
			const validated = await runCli(['validate', '--format', 'json', '--no-input'], { cwd: root }, { version: '9.9.9' })
			expect(validated.exitCode)
				.toBe(0)
			expect(JSON.parse(validated.stdout))
				.toMatchObject({ schema: 'spec/validation-result@1', valid: true })
			expect((await runCli(['version', '--format', 'json'], { cwd: root }, { version: '9.9.9' })).stdout)
				.toContain('spec/version-result@1')
			expect((await runCli(['bogus'], { cwd: root }, { version: '9.9.9' })).exitCode)
				.toBe(2)
			const jsonUsageError = await runCli(['artifact', 'create', '--format', 'json'], { cwd: root }, { version: '9.9.9' })
			expect(jsonUsageError.exitCode)
				.toBe(2)
			expect(jsonUsageError.stderr)
				.toBe('')
			expect(JSON.parse(jsonUsageError.stdout))
				.toMatchObject({ schema: 'spec/error-result@1', ok: false, diagnostics: [{ code: 'SPEC-CLI-INVALID' }] })
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('renders human output and invalid workspace results', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-cli-human-'))
		try {
			expect((await runCli(['init'], { cwd: root }, { version: '1.0.0' })).stdout)
				.toContain('Initialized .spec/')
			expect((await runCli(['validate'], { cwd: root }, { version: '1.0.0' })).stdout)
				.toContain('Spec validation: valid')
			const invalid = await runCli(['validate', '--project', join(root, 'missing'), '--format', 'json'], { cwd: root }, { version: '1.0.0' })
			expect(invalid.exitCode)
				.toBe(2)
			expect(JSON.parse(invalid.stdout).complete)
				.toBe(false)
		}
		finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('diagnostic ordering', () => {
	it('deduplicates and sorts deterministic diagnostics', () => {
		const first = diagnostic('SPEC-Z', 'z', { path: 'b' })
		const duplicate = diagnostic('SPEC-Z', 'z', { path: 'b' })
		const second = diagnostic('SPEC-A', 'a', { path: 'a' })
		expect(aggregateDiagnostics([first, duplicate, second]))
			.toEqual([second, first])
		expect(sortDiagnostics([{ ...first, severity: 'warning' }, first])[0]?.severity)
			.toBe('error')
	})
})
