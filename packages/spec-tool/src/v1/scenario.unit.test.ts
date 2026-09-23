import type { ScenarioStep } from './types'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runV1Cli } from './cli'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'
import { parseScenarioFile, renderNewScenarioFile } from './scenario'
import { writeSemanticFile } from './storage'

const roots: string[] = []
const steps: ScenarioStep[] = [
	{ type: 'given', text: 'searchable items exist' },
	{ type: 'when', text: 'I look up an item' },
	{ type: 'then', text: 'I see matching items' },
]

async function setup(): Promise<SpecClient> {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-scenario-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return client
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})
async function feature(client: SpecClient, title: string) {
	return client.feature.create({ title, summary: title, expectedRevision: (await client.graph.export()).revision })
}

describe('frozen v1 restricted Gherkin Scenario', () => {
	it('creates a one-Scenario container and derives normalized Scenario node and demonstrates edges', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const featureId = f.changedNodes[0]!.id
		const r = await client.rule.create({ ownerId: featureId, statement: 'Search results visible', expectedRevision: f.revision })
		const ruleId = r.changedNodes[0]!.id
		const created = await client.scenario.create({
			title: 'Find an item',
			steps,
			demonstrates: [ruleId, featureId],
			expectedRevision: r.revision,
		})
		expect(created.changedNodes)
			.toEqual([expect.objectContaining({
				kind: 'scenario',
				title: 'Find an item',
				steps,
			})])
		expect(created.changedEdges.added)
			.toHaveLength(2)
		const node = created.changedNodes[0]!
		expect((await client.graph.get({ id: node.id })).data)
			.toEqual(node)
		expect((await client.graph.list({ kind: 'scenario' })).data)
			.toEqual([
				{ id: node.id, kind: 'scenario', title: 'Find an item' },
			])
		const path = node.source.path
		expect(path)
			.toMatch(/^\.spec\/scenarios\/[0-9a-f-]+\.feature$/)
		expect(path).not.toContain(node.id)
		const raw = await readFile(join(client.root, path), 'utf8')
		expect(raw)
			.toContain(`Feature: Find an item\n  @spec:id:${node.id}`)
		expect(raw)
			.toContain('    Given searchable items exist\n    When I look up an item\n    Then I see matching items\n')
		expect((await client.graph.incoming({ id: ruleId, type: 'demonstrates' })).data)
			.toHaveLength(1)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('updates Scenario semantic fields while preserving Feature label, comments and normalized And/But', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const target = f.changedNodes[0]!.id
		const created = await client.scenario.create({ title: 'Find', steps, demonstrates: [target], expectedRevision: f.revision })
		const node = created.changedNodes[0]!
		const path = join(client.root, node.source.path)
		const raw = await readFile(path, 'utf8')
		await writeFile(path, raw
			.replace('Feature: Find', 'Feature: Nonsemantic display label')
			.replace('    When I look up an item', '    # Retain between steps\n    When I look up an item\n    And I refine the query')
			.replace('    Then I see matching items', '    Then I see matching items\n    But I do not see unrelated items'))
		const normalized = await client.graph.get({ id: node.id })
		expect(normalized.revision).not.toBe(created.revision)
		expect(normalized.data)
			.toMatchObject({ steps: [
				steps[0],
				steps[1],
				{ type: 'when', text: 'I refine the query' },
				steps[2],
				{ type: 'then', text: 'I do not see unrelated items' },
			] })
		const stable = (await client.graph.get({ id: node.id })).revision
		await writeFile(path, (await readFile(path, 'utf8')).replace('Feature: Nonsemantic display label', 'Feature: Another arbitrary label')
			.replace('    # Retain between steps', '    # Reworded comment'))
		expect((await client.graph.get({ id: node.id })).revision)
			.toBe(stable)
		const updated = await client.scenario.update({
			id: node.id,
			changes: { title: 'Find updated', steps: [
				{ type: 'when', text: 'I request all items' },
				{ type: 'then', text: 'I receive results' },
			] },
			expectedRevision: stable,
		})
		expect(updated.changedNodes)
			.toEqual([expect.objectContaining({ id: node.id, title: 'Find updated' })])
		const content = await readFile(path, 'utf8')
		expect(content)
			.toContain('Feature: Another arbitrary label')
		expect(content)
			.toContain('    # Reworded comment')
		expect(content)
			.toContain('    When I request all items\n    Then I receive results')
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('enforces demonstrates legality/cardinality and protects referenced Rules and Features', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const r = await client.rule.create({ ownerId: fid, statement: 'Rule', expectedRevision: f.revision })
		const rid = r.changedNodes[0]!.id
		const s = await client.story.create({
			title: 'Intent',
			actor: 'User',
			goal: 'Search',
			value: 'Speed',
			motivates: [fid],
			expectedRevision: r.revision,
		})
		await expect(client.scenario.create({ title: 'Invalid', steps, demonstrates: [], expectedRevision: s.revision }))
			.rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		await expect(client.scenario.create({ title: 'Invalid', steps, demonstrates: [fid, fid], expectedRevision: s.revision }))
			.rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'duplicate_target' } })
		await expect(client.scenario.create({
			title: 'Invalid',
			steps,
			demonstrates: [s.changedNodes[0]!.id],
			expectedRevision: s.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'target_kind' } })
		const c = await client.scenario.create({ title: 'Valid', steps, demonstrates: [rid], expectedRevision: s.revision })
		const id = c.changedNodes[0]!.id
		await expect(client.rule.delete({ id: rid, expectedRevision: c.revision }))
			.rejects.toMatchObject({ code: 'referenced_unit' })
		const n = await client.graph.setRelationTargets({
			sourceId: id,
			type: 'demonstrates',
			targets: [fid, rid],
			expectedRevision: c.revision,
		})
		expect(n.changedEdges.added)
			.toEqual([{ from: id, type: 'demonstrates', to: fid }])
		const noOp = await client.graph.setRelationTargets({
			sourceId: id,
			type: 'demonstrates',
			targets: [rid, fid],
			expectedRevision: n.revision,
		})
		expect(noOp)
			.toEqual({ revision: n.revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } })
		await expect(client.graph.setRelationTargets({
			sourceId: id,
			type: 'demonstrates',
			targets: [],
			expectedRevision: n.revision,
		})).rejects.toMatchObject({ code: 'relation_invalid', details: { reason: 'cardinality' } })
		const path = c.changedNodes[0]!.source.path
		const removed = await client.scenario.delete({ id, expectedRevision: n.revision })
		expect(removed.deletedIds)
			.toEqual([id])
		expect(removed.changedEdges.removed)
			.toHaveLength(2)
		expect(existsSync(join(client.root, path)))
			.toBe(false)
		expect((await client.workspace.validate()).valid)
			.toBe(true)
	})

	it('supports multiple Scenarios per manually authored container and preserves an unaffected sibling', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const one = { id: newUuidV7(), title: 'First', steps, demonstrates: [fid] }
		const two = { id: newUuidV7(), title: 'Second', steps, demonstrates: [fid] }
		const sibling = renderNewScenarioFile(two)
			.split('\n')
			.slice(1)
			.join('\n')
			.replace('    Then I see matching items', '    # Sibling comment\n    Then I see matching items')
		const path = `.spec/scenarios/${newUuidV7()}.feature`
		await writeSemanticFile(client.root, path, `${renderNewScenarioFile(one)
			.trimEnd()}\n\n# Sibling preamble\n${sibling}`)
		const before = await client.graph.export()
		expect(before.data.nodes.filter(n => n.kind === 'scenario'))
			.toHaveLength(2)
		const updated = await client.scenario.update({
			id: one.id,
			changes: { title: 'First updated' },
			expectedRevision: before.revision,
		})
		const raw = await readFile(join(client.root, path), 'utf8')
		expect(raw)
			.toContain('  Scenario: First updated')
		expect(raw)
			.toContain('  Scenario: Second\n    Given')
		expect(raw)
			.toContain('    # Sibling comment')
		expect((await client.scenario.delete({ id: one.id, expectedRevision: updated.revision })).deletedIds)
			.toEqual([one.id])
		expect((await client.workspace.validate()).valid)
			.toBe(true)
		expect((await client.graph.get({ id: two.id })).data)
			.toMatchObject({ title: 'Second' })
		expect(await readFile(join(client.root, path), 'utf8'))
			.toContain('Sibling comment')
		expect(await readFile(join(client.root, path), 'utf8'))
			.toContain('# Sibling preamble')
	})

	it('rejects unsupported Gherkin grammar, incorrect metadata and illegal step phases', () => {
		const target = newUuidV7()
		const example = { id: newUuidV7(), title: 'Search', steps, demonstrates: [target] }
		const valid = renderNewScenarioFile(example)
		const variants = [
			valid.replace('Feature: Search', 'Feature: '),
			valid.replace('  @spec:id:', '  @other:id:'),
			valid.replace('  @spec:id:', '  @spec:demonstrates:'),
			valid.replace('  Scenario: Search', '\n  Scenario: Search'),
			valid.replace('    Given searchable items exist', '\n    Given searchable items exist'),
			valid.replace('    When I look up an item', '    Background: unsupported'),
			valid.replace('    When I look up an item', '    Scenario Outline: bad'),
			valid.replace('    When I look up an item', '    Then results'),
			valid.replace('    Given searchable items exist', '    And cannot be first'),
			valid.replace('    Then I see matching items', '    Given invalid backwards step'),
			valid.replace('    Then I see matching items', '    """\n    unsupported\n    """'),
			valid.replace('    Then I see matching items', '    | table |'),
			valid.replace('  Scenario: Search', '  Scenario: Search\n  Description prose'),
			valid.replace(`  @spec:demonstrates:${target}`, '  @ordinary:tag'),
			valid.replace(`  @spec:demonstrates:${target}`, `  @spec:demonstrates:${target}\n  @spec:demonstrates:${target}`),
		]
		for (const raw of variants) {
			const issues: import('./types').ValidationIssue[] = []
			expect(parseScenarioFile('.spec/scenarios/test.feature', raw, issues))
				.toBeNull()
			expect(issues.length)
				.toBeGreaterThan(0)
		}
		expect(parseScenarioFile('.spec/scenarios/test.feature', valid, [])?.entries)
			.toHaveLength(1)
	})

	it('rejects multiline Gherkin title and step injection without changing persistence', async () => {
		const client = await setup()
		const owner = await feature(client, 'Safe Feature')
		const featureId = owner.changedNodes[0]!.id
		const before = await client.graph.export()
		const newline = String.fromCharCode(10)
		for (const invalid of [
			{ title: `Unsafe${newline}Scenario: injected`, steps },
			{ title: 'Safe', steps: [
				steps[0]!,
				{ type: 'when' as const, text: `input${newline}    Then injected result` },
				steps[2]!,
			] },
		]) {
			await expect(client.scenario.create({
				...invalid,
				demonstrates: [featureId],
				expectedRevision: before.revision,
			})).rejects.toMatchObject({ code: 'invalid_request' })
			expect(await client.graph.export())
				.toEqual(before)
		}
		const valid = await client.scenario.create({
			title: 'Safe',
			steps,
			demonstrates: [featureId],
			expectedRevision: before.revision,
		})
		const id = valid.changedNodes[0]!.id
		const path = join(client.root, valid.changedNodes[0]!.source.path)
		const original = await readFile(path, 'utf8')
		await expect(client.scenario.update({
			id,
			changes: { title: `Unsafe${String.fromCharCode(13)}header` },
			expectedRevision: valid.revision,
		})).rejects.toMatchObject({ code: 'invalid_request' })
		expect(await readFile(path, 'utf8'))
			.toBe(original)
		expect((await client.graph.export()).revision)
			.toBe(valid.revision)
	})

	it('rejects Unicode line separators and diagnoses malformed demonstrates without persisting a file', async () => {
		const client = await setup()
		const owner = await feature(client, 'Safe Feature')
		const featureId = owner.changedNodes[0]!.id
		const before = await client.graph.export()
		for (const separator of [String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
			await expect(client.scenario.create({
				title: `Unsafe${separator}Scenario`,
				steps,
				demonstrates: [featureId],
				expectedRevision: before.revision,
			})).rejects.toMatchObject({ code: 'invalid_request' })
			await expect(client.scenario.create({
				title: 'Safe',
				steps: [steps[0]!, { type: 'when', text: `bad${separator}Then forged` }, steps[2]!],
				demonstrates: [featureId],
				expectedRevision: before.revision,
			})).rejects.toMatchObject({ code: 'invalid_request' })
		}
		const malformed = await runV1Cli(['scenario', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({
				title: 'Safe',
				steps,
				demonstrates: ['not-a-uuid'],
				expectedRevision: before.revision,
			}),
		})
		expect(malformed.exitCode)
			.toBe(1)
		expect(JSON.parse(malformed.stderr).details.issues[0].path)
			.toBe('demonstrates')
		expect(await client.graph.export())
			.toEqual(before)
	})

	it('makes Scenario resource commands available through JSON-stdin CLI', async () => {
		const client = await setup()
		const f = await feature(client, 'Search')
		const fid = f.changedNodes[0]!.id
		const request = { title: 'Via CLI', steps, demonstrates: [fid], expectedRevision: f.revision }
		const created = await runV1Cli(['scenario', 'create', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify(request),
		})
		expect(created.exitCode)
			.toBe(0)
		expect(created.stderr)
			.toBe('')
		const result = JSON.parse(created.stdout) as { revision: string, changedNodes: Array<{ id: string }> }
		const id = result.changedNodes[0]!.id
		expect((await client.graph.get({ id })).data)
			.toMatchObject({ title: 'Via CLI' })
		const bad = await runV1Cli(['scenario', 'update', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({ id, changes: { steps: [] }, expectedRevision: result.revision }),
		})
		expect(bad.exitCode)
			.toBe(1)
		expect(bad.stdout)
			.toBe('')
		expect(JSON.parse(bad.stderr).code)
			.toBe('invalid_request')
		const removed = await runV1Cli(['scenario', 'delete', '--root', client.root], {
			cwd: client.root,
			stdin: JSON.stringify({ id, expectedRevision: result.revision }),
		})
		expect(JSON.parse(removed.stdout).deletedIds)
			.toEqual([id])
	})
})
