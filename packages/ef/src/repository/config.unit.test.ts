import { describe, expect, it } from 'vitest'
import { analyzeLinkedRepositoryPath, decodeConfig, isValidGitBranchName, isValidIntegrationRef, pathsOverlap } from './config'

const PATH = '.engineering/ef.yaml'

function codes(diagnostics: { code: string }[]): string[] {
	return diagnostics.map(d => d.code)
}

const SINGLE_REPO_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const COMPOSITE_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/project-be
    role: implementation
    required: true
  - id: frontend
    path: repos/project-fe
    role: implementation
    required: true
  - id: management
    path: repos/project-mgmt
    role: management
    required: true
schemas:
  artifact_write_major: 1
`

describe('decodeConfig', () => {
	describe('valid spec examples', () => {
		it('accepts the single-repository example with no diagnostics', () => {
			const result = decodeConfig(SINGLE_REPO_YAML, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config)
				.toEqual({
					schema: 'ef/config@1',
					repository: { integrationRef: 'refs/heads/main' },
					linkedRepositories: [],
					schemas: { artifactWriteMajor: 1 },
				})
		})

		it('accepts the composite workspace example with three sorted linked repositories', () => {
			const result = decodeConfig(COMPOSITE_YAML, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config?.linkedRepositories)
				.toEqual([
					{ id: 'backend', path: 'repos/project-be', role: 'implementation', required: true },
					{ id: 'frontend', path: 'repos/project-fe', role: 'implementation', required: true },
					{ id: 'management', path: 'repos/project-mgmt', role: 'management', required: true },
				])
		})
	})

	describe('structural YAML rules', () => {
		it('rejects a document that is not a single top-level mapping', () => {
			const result = decodeConfig('- a\n- b\n', PATH)
			expect(result.config)
				.toBeNull()
			expect(codes(result.diagnostics))
				.toContain('EF-FS-001')
		})

		it('rejects a duplicate top-level key', () => {
			const yaml = `schema: ef/config@1
schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			const duplicate = result.diagnostics.find(d => d.message.includes('Duplicate mapping key'))
			expect(duplicate)
				.toBeDefined()
			expect(duplicate?.code)
				.toBe('EF-FS-001')
			expect(duplicate?.related)
				.toEqual([
					expect.objectContaining({ message: expect.stringContaining('First occurrence') }),
				])
		})

		it('rejects a YAML anchor', () => {
			const yaml = `schema: ef/config@1
repository: &r
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.message.includes('anchor')))
				.toBe(true)
		})

		it('rejects a YAML alias', () => {
			const yaml = `schema: ef/config@1
repository: &r
  integration_ref: refs/heads/main
linked_repositories: []
schemas: *r
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.message.includes('alias')))
				.toBe(true)
		})

		it('rejects a custom YAML tag', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: !custom refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.message.includes('custom tag')))
				.toBe(true)
		})

		it('rejects a merge key', () => {
			const yaml = `schema: ef/config@1
defaults: &d
  integration_ref: refs/heads/main
repository:
  <<: *d
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.message.includes('merge key')))
				.toBe(true)
		})
	})

	describe('top-level field rules', () => {
		it('reports every missing required top-level field', () => {
			const result = decodeConfig('schema: ef/config@1\n', PATH)
			expect(result.config)
				.toBeNull()
			const messages = result.diagnostics.map(d => d.message)
			expect(messages.some(m => m.includes('repository')))
				.toBe(true)
			expect(messages.some(m => m.includes('linked_repositories')))
				.toBe(true)
			expect(messages.some(m => m.includes('schemas')))
				.toBe(true)
		})

		it('rejects an unknown top-level field', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
extra: true
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'extra'))
				.toBe(true)
		})

		it('silently ignores a non-string top-level mapping key (not registered as a field name)', () => {
			const yaml = `${SINGLE_REPO_YAML}123: extra\n`
			const result = decodeConfig(yaml, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config)
				.toEqual({
					schema: 'ef/config@1',
					repository: { integrationRef: 'refs/heads/main' },
					linkedRepositories: [],
					schemas: { artifactWriteMajor: 1 },
				})
		})

		it('warns (not errors) on non-canonical top-level field order', () => {
			const yaml = `schema: ef/config@1
linked_repositories: []
repository:
  integration_ref: refs/heads/main
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config).not.toBeNull()
			expect(result.diagnostics)
				.toHaveLength(1)
			expect(result.diagnostics[0])
				.toMatchObject({ code: 'EF-FS-002', severity: 'warning' })
		})

		it('rejects a non-exact schema value', () => {
			const yaml = SINGLE_REPO_YAML.replace('ef/config@1', 'ef/config@2')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'schema'))
				.toBe(true)
		})

		it('rejects a schema value that is not a string at all', () => {
			const yaml = SINGLE_REPO_YAML.replace('schema: ef/config@1', 'schema: 1')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'schema', message: 'Field \'schema\' must be exactly \'ef/config@1\'.' }),
				])
		})
	})

	describe('structural edge cases', () => {
		it('treats an entirely empty document as missing the required top-level mapping', () => {
			const result = decodeConfig('', PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({
						code: 'EF-FS-001',
						message: 'Configuration must contain exactly one top-level YAML mapping.',
						location: { line: 1, column: 1 },
					}),
				])
		})

		it('computes diagnostic locations correctly across CRLF line endings', () => {
			const yaml = SINGLE_REPO_YAML
				.replace('refs/heads/main', 'not-a-valid-ref')
				.replace(/\n/g, '\r\n')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			const diagnostic = result.diagnostics.find(d => d.field === 'repository.integration_ref')
			expect(diagnostic?.location)
				.toEqual({ line: 3, column: 20 })
		})

		it('does not fail when an explicit-key mapping entry has no value node at all', () => {
			const yaml = `${SINGLE_REPO_YAML}? extra\n`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'extra', message: 'Unknown top-level field \'extra\'.' }),
				])
		})
	})

	describe('repository.integration_ref rules', () => {
		it.each([
			'refs/tags/main',
			'refs/remotes/origin/main',
			'main',
			'HEAD',
			'refs/heads/',
		])('rejects %s as integration_ref', (ref) => {
			const yaml = SINGLE_REPO_YAML.replace('refs/heads/main', ref)
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'repository.integration_ref'))
				.toBe(true)
		})

		it('accepts a hierarchical branch name', () => {
			const yaml = SINGLE_REPO_YAML.replace('refs/heads/main', 'refs/heads/release/1.0')
			const result = decodeConfig(yaml, PATH)
			expect(result.config?.repository.integrationRef)
				.toBe('refs/heads/release/1.0')
		})

		it('rejects an unknown field inside repository', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
  extra: 1
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'repository.extra'))
				.toBe(true)
		})

		it('rejects repository being a non-mapping scalar value', () => {
			const yaml = `schema: ef/config@1
repository: not-a-map
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'repository', message: 'Field \'repository\' must be a mapping.' }),
				])
		})

		it('silently ignores a non-string mapping key inside repository (not registered as a field name)', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
  123: extra
linked_repositories: []
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config?.repository)
				.toEqual({ integrationRef: 'refs/heads/main' })
		})
	})

	describe('linked_repositories rules', () => {
		it('rejects linked_repositories being a non-array scalar value', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: not-a-seq
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories', message: 'Field \'linked_repositories\' must be an array.' }),
				])
		})

		it('rejects a linked_repositories entry that is not a mapping', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - oops
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[0]', message: 'linked_repositories[0] must be a mapping.' }),
				])
		})

		it('silently ignores a non-string mapping key inside a linked_repositories entry', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/be
    role: implementation
    required: true
    123: extra
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config?.linkedRepositories)
				.toEqual([{ id: 'backend', path: 'repos/be', role: 'implementation', required: true }])
		})

		it('reports every missing required field on an entirely empty entry', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/be
    role: implementation
    required: true
  - {}
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[1].id' }),
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[1].path' }),
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[1].required' }),
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[1].role' }),
				])
		})

		it('rejects a path value that is not a string at all', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: 123
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'linked_repositories[0].path', message: 'Field \'linked_repositories[0].path\' must be a string.' }),
				])
		})

		it('rejects an invalid id', () => {
			const yaml = COMPOSITE_YAML.replace('id: backend', 'id: Backend')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'linked_repositories[0].id'))
				.toBe(true)
		})

		it('rejects a duplicate id', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/be
    role: implementation
    required: true
  - id: backend
    path: repos/be2
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			const dup = result.diagnostics.find(d => d.message.includes('Duplicate linked repository id'))
			expect(dup)
				.toBeDefined()
			expect(dup?.code)
				.toBe('EF-FS-001')
		})

		it('rejects overlapping paths', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: alpha
    path: repos/fe
    role: implementation
    required: true
  - id: beta
    path: repos/fe/nested
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.message.includes('overlap')))
				.toBe(true)
		})

		it('does not flag sibling paths sharing only a string prefix as overlapping', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: alpha
    path: repos/fe
    role: implementation
    required: true
  - id: beta
    path: repos/fe-2
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.diagnostics.some(d => d.message.includes('overlap')))
				.toBe(false)
			expect(result.config).not.toBeNull()
		})

		it.each([
			['/abs/path', 'absolute'],
			[`repos${String.fromCharCode(92)}fe`, 'backslash'],
			['c:/repos', 'colon'],
			['~/repos', 'tilde'],
			['repos/..', 'segment'],
			['repos/.', 'segment'],
			['repos//fe', 'segment'],
			['', 'empty'],
		])('rejects path %s (%s)', (path) => {
			// single-quoted YAML scalar: no backslash-escape interpretation, so the
			// literal path text (including a real backslash) round-trips exactly.
			const escaped = path.replace(/'/g, '\'\'')
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: alpha
    path: '${escaped}'
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'linked_repositories[0].path'))
				.toBe(true)
		})

		it('rejects an invalid role', () => {
			const yaml = COMPOSITE_YAML.replace('role: implementation', 'role: bogus')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'linked_repositories[0].role'))
				.toBe(true)
		})

		it('rejects a non-boolean required value', () => {
			const yaml = COMPOSITE_YAML.replace('required: true', 'required: "true"')
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'linked_repositories[0].required'))
				.toBe(true)
		})

		it('warns (not errors) when descriptors are not sorted by id', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: frontend
    path: repos/fe
    role: implementation
    required: true
  - id: backend
    path: repos/be
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config).not.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-002', severity: 'warning', field: 'linked_repositories' }),
				])
		})

		it('warns (not errors) when descriptor fields are not in canonical order', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - path: repos/be
    id: backend
    role: implementation
    required: true
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config).not.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-002', field: 'linked_repositories[0]' }),
				])
		})

		it('rejects an unknown field on a linked repository descriptor', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories:
  - id: backend
    path: repos/be
    role: implementation
    required: true
    extra: 1
schemas:
  artifact_write_major: 1
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'linked_repositories[0].extra'))
				.toBe(true)
		})
	})

	describe('schemas rules', () => {
		it('rejects artifact_write_major values other than the integer 1', () => {
			for (const value of ['2', '"1"', '1.5']) {
				const yaml = SINGLE_REPO_YAML.replace('artifact_write_major: 1', `artifact_write_major: ${value}`)
				const result = decodeConfig(yaml, PATH)
				expect(result.config)
					.toBeNull()
				expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'schemas.artifact_write_major'))
					.toBe(true)
			}
		})

		it('rejects an unknown field inside schemas', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
  extra: true
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics.some(d => d.code === 'EF-FS-001' && d.field === 'schemas.extra'))
				.toBe(true)
		})

		it('silently ignores a non-string mapping key inside schemas', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
  123: extra
`
			const result = decodeConfig(yaml, PATH)
			expect(result.diagnostics)
				.toEqual([])
			expect(result.config?.schemas)
				.toEqual({ artifactWriteMajor: 1 })
		})

		it('rejects an entirely empty schemas mapping as missing artifact_write_major', () => {
			const yaml = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas: {}
`
			const result = decodeConfig(yaml, PATH)
			expect(result.config)
				.toBeNull()
			expect(result.diagnostics)
				.toEqual([
					expect.objectContaining({ code: 'EF-FS-001', field: 'schemas.artifact_write_major', message: 'Missing required field \'schemas.artifact_write_major\'.' }),
				])
		})
	})

	describe('diagnostic shape', () => {
		it('always sets path on reported diagnostics', () => {
			const result = decodeConfig('not: valid\n', PATH)
			expect(result.diagnostics.length)
				.toBeGreaterThan(0)
			for (const diagnostic of result.diagnostics) {
				expect(diagnostic.path)
					.toBe(PATH)
			}
		})
	})
})

describe('isValidGitBranchName', () => {
	it.each([
		'main',
		'feature/foo-bar',
		'release/1.0',
	])('accepts %s', (name) => {
		expect(isValidGitBranchName(name))
			.toBe(true)
	})

	it.each([
		['', 'empty'],
		['@', 'bare at-sign'],
		['/main', 'leading slash'],
		['main/', 'trailing slash'],
		['a//b', 'double slash'],
		['a..b', 'double dot'],
		['a@{1}', 'at-brace sequence'],
		['main.', 'trailing dot'],
		['.hidden', 'leading dot component'],
		['a.lock', 'lock suffix component'],
		['fe ature', 'embedded space'],
		['fe~ature', 'tilde'],
		['fe^ature', 'caret'],
		['fe:ature', 'colon'],
		['fe?ature', 'question mark'],
		['fe*ature', 'asterisk'],
		['fe[ature', 'open bracket'],
		[`fe${String.fromCharCode(92)}ature`, 'backslash'],
		[`fe${String.fromCharCode(1)}ature`, 'control character'],
	])('rejects %s (%s)', (name) => {
		expect(isValidGitBranchName(name))
			.toBe(false)
	})
})

describe('isValidIntegrationRef', () => {
	it('accepts a full local branch ref', () => {
		expect(isValidIntegrationRef('refs/heads/main'))
			.toBe(true)
	})

	it.each([
		'refs/tags/v1',
		'refs/remotes/origin/main',
		'main',
		'HEAD',
	])('rejects %s', (ref) => {
		expect(isValidIntegrationRef(ref))
			.toBe(false)
	})
})

describe('analyzeLinkedRepositoryPath', () => {
	it('accepts a normalized relative path and returns its segments', () => {
		const result = analyzeLinkedRepositoryPath('repos/project-fe')
		expect(result)
			.toEqual({ valid: true, segments: ['repos', 'project-fe'] })
	})

	it.each([
		['', 'empty'],
		['/abs', 'absolute'],
		['a\\b', 'backslash'],
		['c:/x', 'colon'],
		['~/x', 'tilde'],
		['a/./b', 'segment'],
		['a/../b', 'segment'],
		['a//b', 'segment'],
	])('rejects %s as %s', (path, violation) => {
		const result = analyzeLinkedRepositoryPath(path)
		expect(result)
			.toEqual({ valid: false, violation })
	})
})

describe('pathsOverlap', () => {
	it('is true for identical segment paths', () => {
		expect(pathsOverlap(['repos', 'fe'], ['repos', 'fe']))
			.toBe(true)
	})

	it('is true when one path is a directory prefix of another', () => {
		expect(pathsOverlap(['repos', 'fe'], ['repos', 'fe', 'nested']))
			.toBe(true)
	})

	it('is false for sibling paths', () => {
		expect(pathsOverlap(['repos', 'fe'], ['repos', 'be']))
			.toBe(false)
	})

	it('is false for paths sharing only a string (not segment) prefix', () => {
		expect(pathsOverlap(['repos', 'fe'], ['repos', 'fe-2']))
			.toBe(false)
	})
})
