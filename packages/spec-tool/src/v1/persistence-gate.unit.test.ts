import type { ValidationIssue } from './types'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newUuidV7 } from './identity'
import { parseScenarioFile } from './scenario'
import { decodeContract, decodeFeature, decodeStory, encodeContract, encodeFeature, encodeStory } from './storage'
import { initWorkspace, validateWorkspace } from './workspace'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { force: true, recursive: true })))
})
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-persistence-gate-'))
	roots.push(root)
	await initWorkspace(root)
	return root
}
function invalid(text: string, kind: 'feature' | 'story' | 'contract', id: string) {
	const issues: ValidationIssue[] = []
	const path = `.spec/${kind === 'story' ? 'stories' : kind === 'contract' ? 'contracts' : 'features'}`
	const filename = `${path}/${id}.md`
	const decoded = kind === 'feature'
		? decodeFeature(filename, text, id, issues)
		: kind === 'story'
			? decodeStory(filename, text, id, issues)
			: decodeContract(filename, text, id, issues)
	expect(issues.length, `${kind} invalid persisted input should have diagnostics`)
		.toBeGreaterThan(0)
	expect(issues[0]!.source.path)
		.toBe(filename)
	return { issues, decoded }
}

describe('closed-world persisted YAML regression matrix', () => {
	it('reports malformed envelopes and every required Feature field/Rule schema boundary', () => {
		const id = newUuidV7()
		const rule = newUuidV7()
		const canonical = encodeFeature({ id, title: 'Search', summary: 'Find items', rules: [
			{ id: rule, statement: 'Return deterministic results' },
		] })
		for (const raw of [
			'',
			'---\nid: invalid\n',
			'---\n- not: a mapping\n---\n',
			'---\nid: one\nid: two\n---\n',
			canonical.replace('title: Search\n', 'title: Search\ntitle: Duplicate\n'),
			canonical.replace('title: Search\n', ''),
			canonical.replace('title: Search', 'title: []'),
			canonical.replace('title: Search', 'title: " "'),
			canonical.replace('summary: Find items\n', ''),
			canonical.replace('summary: Find items', 'summary: false'),
			canonical.replace('summary: Find items', 'summary: ""'),
			canonical.replace('rules:\n', 'rules: null\n# '),
			canonical.replace(/rules:\n[\s\S]*?(?=\n---)/u, 'rules: []\nextra: forbidden'),
			canonical.replace('rules:\n', 'rules:\n  - null\n# '),
			canonical.replace('rules:\n', 'rules:\n  - id: broken\n    statement: Text\n# '),
			canonical.replace('statement: Return deterministic results', 'statement: ""'),
			canonical.replace('statement: Return deterministic results', 'statement: false'),
			canonical.replace(`  - id: ${rule}`, `  - statement: Wrong order\n    id: ${rule}\n# `),
			canonical.replace(`id: ${id}`, 'id: wrong'),
			canonical.replace(`id: ${id}`, `id: ${newUuidV7()}`),
		]) {
			invalid(raw, 'feature', id)
		}
		const distinctRule = newUuidV7()
		const valid = decodeFeature(`.spec/features/${id}.md`, encodeFeature({ id, title: 'Search', summary: 'Find', rules: [
			{ id: rule, statement: 'Rule A' },
			{ id: distinctRule, statement: 'Rule B' },
		] }), id, [])
		expect(valid?.value.rules)
			.toHaveLength(2)
	})

	it('reports Story motivates cardinality, UUID, uniqueness, order and human text problems', () => {
		const id = newUuidV7()
		const [a, b] = [newUuidV7(), newUuidV7()].sort() as [string, string]
		const canonical = encodeStory({
			id,
			title: 'Find',
			actor: 'Buyer',
			goal: 'Locate items',
			value: 'Save time',
			motivates: [a, b],
		})
		for (const raw of [
			canonical.replace('motivates:\n', 'motivates: []\n# '),
			canonical.replace('motivates:\n', 'motivates: false\n# '),
			canonical.replace('motivates:\n', 'motivates: null\n# '),
			canonical.replace(`  - ${a}`, '  - invalid'),
			canonical.replace(`  - ${b}`, `  - ${a}`),
			canonical.replace(`  - ${a}\n  - ${b}`, `  - ${b}\n  - ${a}`),
			canonical.replace('actor: Buyer', 'actor: []'),
			canonical.replace('goal: Locate items', 'goal: ""'),
			canonical.replace('value: Save time\n', ''),
			canonical.replace(`id: ${id}`, 'id: upper-not-uuid'),
		]) {
			invalid(raw, 'story', id)
		}
	})

	it('reports Contract/Clause canonical field order, optional override and validity boundaries', () => {
		const id = newUuidV7()
		const target = newUuidV7()
		const clauseId = newUuidV7()
		const canonical = encodeContract({
			id,
			title: 'Shared',
			summary: 'Cross-boundary',
			clauses: [{ id: clauseId, statement: 'Shared obligation' }],
			constrains: [target],
		})
		const clause = `  - id: ${clauseId}\n    statement: Shared obligation`
		for (const raw of [
			canonical.replace('constrains:\n', 'constrains: []\n# '),
			canonical.replace('constrains:\n', 'constrains: false\n# '),
			canonical.replace('constrains:\n', 'constrains: null\n# '),
			canonical.replace(`  - ${target}`, '  - invalid'),
			canonical.replace(`constrains:\n  - ${target}`, `constrains:\n  - ${target}\n  - ${target}`),
			canonical.replace('clauses:\n', 'clauses: null\n# '),
			canonical.replace(clause, '  - null'),
			canonical.replace(clause, `  - statement: Text\n    id: ${clauseId}`),
			canonical.replace(`id: ${clauseId}`, 'id: invalid'),
			canonical.replace('statement: Shared obligation', 'statement: ""'),
			canonical.replace('statement: Shared obligation', 'statement: false'),
			canonical.replace(clause, `${clause}\n    constrains: []`),
			canonical.replace(clause, `${clause}\n    constrains: null`),
			canonical.replace(clause, `${clause}\n    constrains:\n      - invalid`),
			canonical.replace(clause, `${clause}\n    extra: forbidden`),
			canonical.replace('summary: Cross-boundary', 'summary: null'),
		]) {
			invalid(raw, 'contract', id)
		}
	})
})

describe('strict Gherkin parser and workspace layout edge cases', () => {
	it('diagnoses invalid Gherkin metadata, step phases, separators and unsupported language', () => {
		const a = newUuidV7()
		const b = newUuidV7()
		const [first, second] = [a, b].sort()
		const identity = newUuidV7()
		const header = `Feature: Search\n  @spec:id:${identity}\n  @spec:demonstrates:${first}`
		const valid = `${header}\n  Scenario: Find\n    When I query\n    Then I see results\n`
		expect(parseScenarioFile('test.feature', valid, [])?.entries)
			.toHaveLength(1)
		for (const raw of [
			'',
			valid.replaceAll('\n', '\r\n'),
			'Scenario: No Feature\n',
			`Feature: \n${valid.slice(valid.indexOf('  @spec:id:'))}`,
			'Feature: Empty\n',
			valid.replace(`@spec:id:${identity}`, '@spec:id:invalid'),
			valid.replace(`  @spec:demonstrates:${first}\n`, ''),
			valid.replace(`  @spec:demonstrates:${first}`, '  @spec:demonstrates:broken'),
			`${header.replace(`  @spec:demonstrates:${first}`, `  @spec:demonstrates:${second}\n  @spec:demonstrates:${first}`)
			}\n  Scenario: Find\n    When I query\n    Then I see results\n`,
			valid.replace('  Scenario: Find', '  Scenario: '),
			valid.replace('    When I query', '    And I query'),
			valid.replace('    When I query', '    Then I query'),
			valid.replace('    When I query', '    Given I query'),
			valid.replace('    Then I see results', '    Given I see results'),
			valid.replace('    Then I see results', '    When I query again'),
			valid.replace('    Then I see results', '    Background: invalid'),
			valid.replace('    Then I see results', '    Then '),
			valid.replace('    When I query', '    '),
			valid.replace('  Scenario: Find\n    When I query', '  Scenario: Find\n\n    When I query'),
			valid.replace('  Scenario: Find\n', '  Scenario: Find\n    # comment\n    But before any phase\n'),
			`${valid}\n\n${valid.slice('Feature: Search\n'.length)}`,
		]) {
			const issues: ValidationIssue[] = []
			const parsed = parseScenarioFile('test.feature', raw, issues)
			expect(parsed, 'malformed Gherkin should fail')
				.toBeNull()
			expect(issues.length)
				.toBeGreaterThan(0)
		}
		const normalized = parseScenarioFile('test.feature', `${header}\n  Scenario: Find\n    Given data exists\n    And valid\n    When I query\n    But also sort\n    Then I see results\n    And ordering\n`, [])
		expect(normalized?.entries[0]?.value.steps.map(step => step.type))
			.toEqual(['given', 'given', 'when', 'when', 'then', 'then'])
	})

	it('rejects invalid workspace manifest, root layout, nested entries and cross-kind relationships', async () => {
		const root = await setup()
		const manifest = join(root, '.spec', 'spec.yaml')
		for (const value of [
			'',
			'[]\n',
			'formatVersion: 2\n',
			'schema: legacy\n',
			'formatVersion: 1\nextra: false\n',
			'formatVersion: 1\nformatVersion: 1\n',
			'formatVersion: null\n',
		]) {
			await writeFile(manifest, value)
			expect((await validateWorkspace(root)).valid)
				.toBe(false)
		}
		await writeFile(manifest, 'formatVersion: 1\n')
		const features = join(root, '.spec', 'features')
		await mkdir(features)
		await mkdir(join(features, 'nested'))
		expect((await validateWorkspace(root)).valid)
			.toBe(false)
		await rm(join(features, 'nested'), { recursive: true })
		const id = newUuidV7()
		const fPath = join(features, `${id}.md`)
		await writeFile(fPath, encodeFeature({ id, title: 'Feature', summary: 'Feature', rules: [] }))
		const contractId = newUuidV7()
		const contractRoot = join(root, '.spec', 'contracts')
		await mkdir(contractRoot)
		await writeFile(join(contractRoot, `${contractId}.md`), encodeContract({
			id: contractId,
			title: 'Contract',
			summary: 'Shared',
			clauses: [],
			constrains: [contractId],
		}))
		expect((await validateWorkspace(root)).issues)
			.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'constrains', reason: 'invariant' })]))
		await writeFile(join(contractRoot, `${contractId}.md`), encodeContract({
			id: contractId,
			title: 'Contract',
			summary: 'Shared',
			clauses: [{ id: newUuidV7(), statement: 'Must work', constrains: [newUuidV7()] }],
			constrains: [id],
		}))
		expect((await validateWorkspace(root)).issues)
			.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'clauses.constrains', reason: 'unresolved' })]))
		await symlink(join(root, '.spec', 'spec.yaml'), join(root, '.spec', 'scenarios'))
		expect((await validateWorkspace(root)).valid)
			.toBe(false)
	})
})
