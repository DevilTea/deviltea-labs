import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecClient } from './client'
import { newUuidV7 } from './identity'

const roots: string[] = []
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'spec-v1-client-gate-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	const a = await client.feature.create({
		title: 'Alpha',
		summary: 'Alpha',
		expectedRevision: (await client.graph.export()).revision,
	})
	const featureA = a.changedNodes[0]!.id
	const b = await client.feature.create({
		title: 'Beta',
		summary: 'Beta',
		expectedRevision: a.revision,
	})
	const featureB = b.changedNodes[0]!.id
	const rule = await client.rule.create({
		ownerId: featureA,
		statement: 'Local obligation',
		expectedRevision: b.revision,
	})
	const ruleId = rule.changedNodes[0]!.id
	const story = await client.story.create({
		title: 'Buyer intent',
		actor: 'Buyer',
		goal: 'Find items',
		value: 'Save time',
		motivates: [featureA],
		expectedRevision: rule.revision,
	})
	const storyId = story.changedNodes[0]!.id
	const contract = await client.contract.create({
		title: 'Shared policy',
		summary: 'Shared authority',
		constrains: [featureB],
		expectedRevision: story.revision,
	})
	const contractId = contract.changedNodes[0]!.id
	const clause = await client.clause.create({
		ownerId: contractId,
		statement: 'Applies to Rule',
		constrains: [ruleId],
		expectedRevision: contract.revision,
	})
	const clauseId = clause.changedNodes[0]!.id
	const scenario = await client.scenario.create({
		title: 'Verify Rule',
		steps: [
			{ type: 'given', text: 'Items exist' },
			{ type: 'when', text: 'I search' },
			{ type: 'then', text: 'I see matches' },
		],
		demonstrates: [ruleId],
		expectedRevision: clause.revision,
	})
	const scenarioId = scenario.changedNodes[0]!.id
	return {
		client,
		featureA,
		featureB,
		ruleId,
		storyId,
		contractId,
		clauseId,
		scenarioId,
		revision: scenario.revision,
	}
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('semantic request guards, illegal graph transitions and no-op invariants', () => {
	it('rejects malformed request shapes, semantic text, UUIDs and revisions before mutation', async () => {
		const { client, revision, featureA, contractId, ruleId, scenarioId } = await setup()
		const cases: Array<[string, () => Promise<unknown>, string]> = [
			['request not object', () => client.feature.create(null as never), 'invalid_request'],
			['request array', () => client.feature.create([] as never), 'invalid_request'],
			['extra feature field', () => client.feature.create({
				title: 'Invalid',
				summary: 'Invalid',
				expectedRevision: revision,
				extra: true,
			} as never), 'invalid_request'],
			['missing required revision', () => client.feature.create({
				title: 'Invalid',
				summary: 'Invalid',
			} as never), 'invalid_request'],
			['blank feature title', () => client.feature.create({
				title: '  ',
				summary: 'Invalid',
				expectedRevision: revision,
			}), 'invalid_request'],
			['non-string summary', () => client.feature.create({
				title: 'Invalid',
				summary: [] as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['uppercase revision', () => client.feature.update({
				id: featureA,
				changes: { title: 'Invalid' },
				expectedRevision: revision.toUpperCase(),
			}), 'invalid_request'],
			['short revision', () => client.feature.update({
				id: featureA,
				changes: {},
				expectedRevision: 'bad',
			}), 'invalid_request'],
			['invalid update ID', () => client.feature.update({
				id: 'not-uuid',
				changes: {},
				expectedRevision: revision,
			}), 'invalid_request'],
			['unexpected change field', () => client.feature.update({
				id: featureA,
				changes: { unexpected: 'no' } as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid changes object', () => client.feature.update({
				id: featureA,
				changes: null as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid story motives', () => client.story.create({
				title: 'Intent',
				actor: 'Buyer',
				goal: 'Find',
				value: 'Save time',
				motivates: ['not-uuid'],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Clause override UUID', () => client.clause.create({
				ownerId: contractId,
				statement: 'Invalid',
				constrains: ['bad'],
				expectedRevision: revision,
			}), 'invalid_request'],
			['malformed demonstrates array', () => client.scenario.create({
				title: 'Invalid',
				steps: [
					{ type: 'when', text: 'I query' },
					{ type: 'then', text: 'result' },
				],
				demonstrates: null as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin title line separator', () => client.scenario.create({
				title: 'Invalid\u2029Scenario',
				steps: [
					{ type: 'when', text: 'I query' },
					{ type: 'then', text: 'result' },
				],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin empty steps', () => client.scenario.create({
				title: 'Invalid',
				steps: [],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin step object', () => client.scenario.create({
				title: 'Invalid',
				steps: [null as never],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin phase', () => client.scenario.create({
				title: 'Invalid',
				steps: [
					{ type: 'And' as never, text: 'wrong' },
					{ type: 'then', text: 'result' },
				],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin phase order', () => client.scenario.create({
				title: 'Invalid',
				steps: [
					{ type: 'then', text: 'premature' },
					{ type: 'when', text: 'late' },
				],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin missing Then', () => client.scenario.create({
				title: 'Invalid',
				steps: [{ type: 'when', text: 'only action' }],
				demonstrates: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Gherkin after Then', () => client.scenario.update({
				id: scenarioId,
				changes: { steps: [
					{ type: 'when', text: 'action' },
					{ type: 'then', text: 'result' },
					{ type: 'when', text: 'late action' },
				] },
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid graph ID', () => client.graph.get({ id: 'invalid' }), 'invalid_request'],
			['invalid graph kind', () => client.graph.list({ kind: 'unknown' as never }), 'invalid_request'],
			['invalid graph edge type', () => client.graph.incoming({
				id: featureA,
				type: 'refines' as never,
			}), 'invalid_request'],
			['invalid graph outgoing ID', () => client.graph.outgoing({
				id: 'wrong',
			}), 'invalid_request'],
			['unsupported relation type', () => client.graph.setRelationTargets({
				sourceId: featureA,
				type: 'references' as never,
				targets: [ruleId],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid relation target type', () => client.graph.setRelationTargets({
				sourceId: scenarioId,
				type: 'demonstrates',
				targets: 'not-array' as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['null for Scenario demonstrates', () => client.graph.setRelationTargets({
				sourceId: scenarioId,
				type: 'demonstrates',
				targets: null,
				expectedRevision: revision,
			}), 'invalid_request'],
		]
		for (const [name, action, code] of cases) {
			await expect(action(), name).rejects.toMatchObject({ code })
			expect((await client.graph.export()).revision, name)
				.toBe(revision)
		}
	})

	it('rejects wrong semantic relation kinds, duplicate targets, missing nodes and invalid ownership', async () => {
		const { client, revision, featureA, featureB, ruleId, storyId, contractId, clauseId, scenarioId } = await setup()
		const missing = newUuidV7()
		const steps = [{ type: 'when' as const, text: 'I query' }, { type: 'then' as const, text: 'result' }]
		const candidates: Array<[string, () => Promise<unknown>, string]> = [
			['empty motives', () => client.story.create({
				title: 'Bad',
				actor: 'A',
				goal: 'G',
				value: 'V',
				motivates: [],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['duplicate motives', () => client.story.create({
				title: 'Bad',
				actor: 'A',
				goal: 'G',
				value: 'V',
				motivates: [featureA, featureA],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['wrong motives kind', () => client.story.create({
				title: 'Bad',
				actor: 'A',
				goal: 'G',
				value: 'V',
				motivates: [ruleId],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing motives target', () => client.story.create({
				title: 'Bad',
				actor: 'A',
				goal: 'G',
				value: 'V',
				motivates: [missing],
				expectedRevision: revision,
			}), 'not_found'],
			['empty Contract constraints', () => client.contract.create({
				title: 'Bad',
				summary: 'Bad',
				constrains: [],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['duplicate Contract constraints', () => client.contract.create({
				title: 'Bad',
				summary: 'Bad',
				constrains: [featureA, featureA],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['wrong Contract kind', () => client.contract.create({
				title: 'Bad',
				summary: 'Bad',
				constrains: [ruleId],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing Contract target', () => client.contract.create({
				title: 'Bad',
				summary: 'Bad',
				constrains: [missing],
				expectedRevision: revision,
			}), 'not_found'],
			['empty demonstrates', () => client.scenario.create({
				title: 'Bad',
				steps,
				demonstrates: [],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['duplicate demonstrates', () => client.scenario.create({
				title: 'Bad',
				steps,
				demonstrates: [featureA, featureA],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['wrong demonstrates kind', () => client.scenario.create({
				title: 'Bad',
				steps,
				demonstrates: [storyId],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing demonstrates target', () => client.scenario.create({
				title: 'Bad',
				steps,
				demonstrates: [missing],
				expectedRevision: revision,
			}), 'not_found'],
			['wrong Clause scope kind', () => client.clause.create({
				ownerId: contractId,
				statement: 'Bad',
				constrains: [storyId],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing Clause scope target', () => client.clause.create({
				ownerId: contractId,
				statement: 'Bad',
				constrains: [missing],
				expectedRevision: revision,
			}), 'not_found'],
			['duplicate Clause override', () => client.clause.create({
				ownerId: contractId,
				statement: 'Bad',
				constrains: [featureB, featureB],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['wrong Rule owner kind', () => client.rule.create({
				ownerId: contractId,
				statement: 'Bad',
				expectedRevision: revision,
			}), 'not_found'],
			['wrong Clause owner kind', () => client.clause.create({
				ownerId: featureA,
				statement: 'Bad',
				expectedRevision: revision,
			}), 'not_found'],
			['wrong relation source kind', () => client.graph.setRelationTargets({
				sourceId: featureA,
				type: 'motivates',
				targets: [featureB],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing relation source', () => client.graph.setRelationTargets({
				sourceId: missing,
				type: 'motivates',
				targets: [featureA],
				expectedRevision: revision,
			}), 'not_found'],
			['null Contract constrains', () => client.graph.setRelationTargets({
				sourceId: contractId,
				type: 'constrains',
				targets: null,
				expectedRevision: revision,
			}), 'invalid_request'],
			['empty Clause constraints', () => client.graph.setRelationTargets({
				sourceId: clauseId,
				type: 'constrains',
				targets: [],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['wrong Clause constrains kind', () => client.graph.setRelationTargets({
				sourceId: clauseId,
				type: 'constrains',
				targets: [contractId],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing Clause scope', () => client.graph.setRelationTargets({
				sourceId: clauseId,
				type: 'constrains',
				targets: [missing],
				expectedRevision: revision,
			}), 'not_found'],
			['duplicate Clause scope', () => client.graph.setRelationTargets({
				sourceId: clauseId,
				type: 'constrains',
				targets: [featureA, featureA],
				expectedRevision: revision,
			}), 'relation_invalid'],
			['missing graph get', () => client.graph.get({ id: missing }), 'not_found'],
			['missing graph incoming', () => client.graph.incoming({ id: missing }), 'not_found'],

			['missing feature update', () => client.feature.update({
				id: missing,
				changes: { title: 'Unknown' },
				expectedRevision: revision,
			}), 'not_found'],
			['missing feature delete', () => client.feature.delete({
				id: missing,
				expectedRevision: revision,
			}), 'not_found'],
			['missing Contract delete', () => client.contract.delete({
				id: missing,
				expectedRevision: revision,
			}), 'not_found'],
			['missing Clause delete', () => client.clause.delete({
				id: missing,
				expectedRevision: revision,
			}), 'not_found'],
			['missing Story delete', () => client.story.delete({
				id: missing,
				expectedRevision: revision,
			}), 'not_found'],
			['invalid Feature compound child IDs', () => client.feature.deleteWithChildren({
				ownerId: featureA,
				childIds: null as never,
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid Contract compound child IDs', () => client.contract.deleteWithChildren({
				ownerId: contractId,
				childIds: ['bad'],
				expectedRevision: revision,
			}), 'invalid_request'],
			['missing Rule reorder owner', () => client.rule.reorder({
				ownerId: missing,
				orderedIds: [],
				expectedRevision: revision,
			}), 'not_found'],
			['missing Clause reorder owner', () => client.clause.reorder({
				ownerId: missing,
				orderedIds: [],
				expectedRevision: revision,
			}), 'not_found'],
			['missing rule update', () => client.rule.update({
				id: missing,
				changes: { statement: 'Unknown' },
				expectedRevision: revision,
			}), 'not_found'],
			['missing scenario update', () => client.scenario.update({
				id: missing,
				changes: { title: 'Unknown' },
				expectedRevision: revision,
			}), 'not_found'],
			['missing Contract update', () => client.contract.update({
				id: missing,
				changes: { title: 'Unknown' },
				expectedRevision: revision,
			}), 'not_found'],
			['missing Clause update', () => client.clause.update({
				id: missing,
				changes: { statement: 'Unknown' },
				expectedRevision: revision,
			}), 'not_found'],
			['referenced Feature', () => client.feature.delete({ id: featureA, expectedRevision: revision }), 'referenced_unit'],
			['referenced Rule', () => client.rule.delete({ id: ruleId, expectedRevision: revision }), 'referenced_unit'],
			['Contract with Clause children', () => client.contract.delete({
				id: contractId,
				expectedRevision: revision,
			}), 'invalid_request'],
			['incomplete Feature child set', () => client.feature.deleteWithChildren({
				ownerId: featureA,
				childIds: [],
				expectedRevision: revision,
			}), 'invalid_request'],
			['incomplete Contract child set', () => client.contract.deleteWithChildren({
				ownerId: contractId,
				childIds: [],
				expectedRevision: revision,
			}), 'invalid_request'],
			['invalid reparent Rule', () => client.rule.reparent({
				id: ruleId,
				newOwnerId: contractId,
				expectedRevision: revision,
			}), 'not_found'],
			['invalid reparent Clause', () => client.clause.reparent({
				id: clauseId,
				newOwnerId: featureA,
				expectedRevision: revision,
			}), 'not_found'],
			['wrong Graph relation source', () => client.graph.setRelationTargets({
				sourceId: scenarioId,
				type: 'constrains',
				targets: [featureA],
				expectedRevision: revision,
			}), 'relation_invalid'],
		]
		for (const [name, action, code] of candidates) {
			await expect(action(), name).rejects.toMatchObject({ code })
			expect((await client.graph.export()).revision, name)
				.toBe(revision)
		}
	})

	it('returns empty change sets for idempotent updates, relations, reorder and same-owner reparent', async () => {
		const { client, revision, featureA, featureB, ruleId, storyId, contractId, clauseId, scenarioId } = await setup()
		const steps = [
			{ type: 'given' as const, text: 'Items exist' },
			{ type: 'when' as const, text: 'I search' },
			{ type: 'then' as const, text: 'I see matches' },
		]
		const actions = [
			() => client.feature.update({ id: featureA, changes: {}, expectedRevision: revision }),
			() => client.story.update({ id: storyId, changes: {}, expectedRevision: revision }),
			() => client.rule.update({ id: ruleId, changes: {}, expectedRevision: revision }),
			() => client.contract.update({ id: contractId, changes: {}, expectedRevision: revision }),
			() => client.clause.update({ id: clauseId, changes: {}, expectedRevision: revision }),
			() => client.scenario.update({ id: scenarioId, changes: { steps }, expectedRevision: revision }),
			() => client.rule.reorder({ ownerId: featureA, orderedIds: [ruleId], expectedRevision: revision }),
			() => client.clause.reorder({ ownerId: contractId, orderedIds: [clauseId], expectedRevision: revision }),
			() => client.rule.reparent({ id: ruleId, newOwnerId: featureA, expectedRevision: revision }),
			() => client.clause.reparent({ id: clauseId, newOwnerId: contractId, expectedRevision: revision }),
			() => client.graph.setRelationTargets({
				sourceId: storyId,
				type: 'motivates',
				targets: [featureA],
				expectedRevision: revision,
			}),
			() => client.graph.setRelationTargets({
				sourceId: scenarioId,
				type: 'demonstrates',
				targets: [ruleId],
				expectedRevision: revision,
			}),
			() => client.graph.setRelationTargets({
				sourceId: contractId,
				type: 'constrains',
				targets: [featureB],
				expectedRevision: revision,
			}),
			() => client.graph.setRelationTargets({
				sourceId: clauseId,
				type: 'constrains',
				targets: [ruleId],
				expectedRevision: revision,
			}),
		]
		for (const action of actions) {
			expect(await action())
				.toEqual({
					revision,
					changedNodes: [],
					deletedIds: [],
					changedEdges: { added: [], removed: [] },
				})
		}
		expect((await client.graph.export()).revision)
			.toBe(revision)
	})
})
