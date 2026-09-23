import type {
	DeleteRequest,
	FeatureCreateRequest,
	FeatureResource,
	FeatureUpdateRequest,
	GraphResource,
	MutationResponse,
	NormalizedEdge,
	ReadResponse,
	RelationType,
	RuleCreateRequest,
	RuleReorderRequest,
	RuleReparentRequest,
	RuleResource,
	RuleUpdateRequest,
	ScenarioCreateRequest,
	ScenarioResource,
	ScenarioStep,
	ScenarioUpdateRequest,
	SetRelationTargetsRequest,
	StoryCreateRequest,
	StoryResource,
	StoryUpdateRequest,
	WorkspaceResource,
} from './types'
import type { WorkspaceSnapshot } from './workspace'
import { resolve } from 'node:path'
import {
	invalidRequest,
	notFound,
	referencedUnit,
	relationInvalid,
	revisionConflict,
} from './errors'
import { isUuidV7, newUuidV7 } from './identity'
import { deleteScenarioFromContainer, renderNewScenarioFile, updateScenarioInContainer } from './scenario'
import {
	compareText,
	encodeFeature,
	encodeStory,
	removeSemanticFile,
	replaceSemanticFiles,
	withSemanticMutationJournal,
	writeSemanticFile,
} from './storage'
import { initWorkspace, readSnapshot, validateWorkspace } from './workspace'
import { withWorkspaceWriteLock } from './write-lock'

const REVISIONS = /^[0-9a-f]{64}$/
const NODE_KINDS = ['story', 'feature', 'contract', 'scenario', 'rule', 'clause']
const RELATIONS = ['motivates', 'demonstrates', 'constrains']
const mutationQueues = new Map<string, Promise<void>>()

async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
	const key = resolve(root)
	const previous = mutationQueues.get(key) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((done) => {
		release = done
	})
	mutationQueues.set(key, current)
	await previous
	try {
		return await operation()
	}
	finally {
		release()
		if (mutationQueues.get(key) === current)
			mutationQueues.delete(key)
	}
}

function issue(path: string, reason: 'missing' | 'unexpected' | 'conflict' | 'unsupported' | 'invalid_format', message: string) {
	return { path, reason, message }
}

function fail(path: string, reason: 'missing' | 'unexpected' | 'conflict' | 'unsupported' | 'invalid_format', message: string): never {
	throw invalidRequest([issue(path, reason, message)])
}

function assertShape(
	value: unknown,
	keys: readonly string[],
	required: readonly string[] = keys,
	path = 'request',
): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		fail(path, 'invalid_format', 'Request must be a JSON object.')
	for (const key of Object.keys(value)) {
		if (!keys.includes(key))
			fail(`${path}.${key}`, 'unexpected', 'Unknown request field.')
	}
	for (const key of required) {
		if (!(key in value))
			fail(`${path}.${key}`, 'missing', 'Required request field is missing.')
	}
}

function assertText(value: unknown, path: string): asserts value is string {
	if (typeof value !== 'string' || !value.trim())
		fail(path, 'invalid_format', 'Required text must be a non-empty string.')
}

function assertScenarioLine(value: unknown, path: string): asserts value is string {
	assertText(value, path)
	if (/[\r\n\u2028\u2029]/u.test(value))
		fail(path, 'invalid_format', 'Gherkin titles and step text must fit on one line.')
}

function assertId(value: unknown, path: string): asserts value is string {
	if (!isUuidV7(value))
		fail(path, 'invalid_format', 'Semantic identity must be canonical lowercase UUIDv7.')
}

function assertRevision(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !REVISIONS.test(value))
		fail('expectedRevision', 'invalid_format', 'expectedRevision must be a lowercase SHA-256 hex digest.')
}

function assertRelations(value: unknown, path = 'targets'): asserts value is string[] {
	if (!Array.isArray(value) || !value.every(isUuidV7))
		fail(path, 'invalid_format', 'Relation targets must be an array of canonical UUIDv7 strings.')
}

function assertScenarioSteps(value: unknown): asserts value is ScenarioStep[] {
	if (!Array.isArray(value) || !value.length)
		fail('steps', 'invalid_format', 'steps must be a non-empty normalized ScenarioStep array.')
	let phase: ScenarioStep['type'] | null = null
	let whenCount = 0
	let thenCount = 0
	for (const [index, step] of value.entries()) {
		const path = `steps[${index}]`
		assertShape(step, ['type', 'text'], ['type', 'text'], path)
		if (step.type !== 'given' && step.type !== 'when' && step.type !== 'then')
			fail(`${path}.type`, 'invalid_format', 'Step phase must be given, when or then.')
		assertScenarioLine(step.text, `${path}.text`)
		if ((step.type === 'given' && phase !== null && phase !== 'given')
			|| (step.type === 'when' && phase === 'then')
			|| (step.type === 'then' && !whenCount)) {
			fail(`${path}.type`, 'invalid_format', 'Steps must follow Given* -> When+ -> Then+.')
		}
		phase = step.type
		if (step.type === 'when')
			whenCount++
		if (step.type === 'then')
			thenCount++
	}
	if (!whenCount || !thenCount)
		fail('steps', 'invalid_format', 'A Scenario requires at least one When and one Then step.')
}

function assertDemonstrates(snapshot: WorkspaceSnapshot, sourceId: string, targets: string[]): string[] {
	if (targets.length === 0)
		throw relationInvalid('cardinality', sourceId, 'demonstrates', targets)
	if (new Set(targets).size !== targets.length)
		throw relationInvalid('duplicate_target', sourceId, 'demonstrates', targets)
	for (const id of targets) {
		if (!snapshot.features.has(id) && !snapshot.rules.has(id)) {
			if (snapshot.ir.nodes.some(node => node.id === id))
				throw relationInvalid('target_kind', sourceId, 'demonstrates', targets)
			throw notFound(id)
		}
	}
	return [...targets].sort(compareText)
}

function assertSourceExists(snapshot: WorkspaceSnapshot, id: string): void {
	if (!snapshot.ir.nodes.some(node => node.id === id))
		throw notFound(id)
}

function assertMotivates(snapshot: WorkspaceSnapshot, sourceId: string, targets: string[]): string[] {
	if (targets.length === 0)
		throw relationInvalid('cardinality', sourceId, 'motivates', targets)
	if (new Set(targets).size !== targets.length)
		throw relationInvalid('duplicate_target', sourceId, 'motivates', targets)
	for (const id of targets) {
		if (!snapshot.features.has(id)) {
			if (snapshot.ir.nodes.some(node => node.id === id))
				throw relationInvalid('target_kind', sourceId, 'motivates', targets)
			throw notFound(id, 'feature')
		}
	}
	return [...targets].sort(compareText)
}

function sameTargets(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index])
}

function emptyMutation(revision: string): MutationResponse {
	return { revision, changedNodes: [], deletedIds: [], changedEdges: { added: [], removed: [] } }
}

function edgeKey(edge: NormalizedEdge): string {
	return [edge.from, edge.type, edge.to].join(':')
}

function delta(before: WorkspaceSnapshot, after: WorkspaceSnapshot): MutationResponse {
	const priorNodes = new Map(before.ir.nodes.map(node => [node.id, node]))
	const currentNodes = new Map(after.ir.nodes.map(node => [node.id, node]))
	const priorEdges = new Set(before.ir.edges.map(edgeKey))
	const currentEdges = new Set(after.ir.edges.map(edgeKey))
	return {
		revision: after.revision,
		changedNodes: after.ir.nodes.filter(node => JSON.stringify(priorNodes.get(node.id)) !== JSON.stringify(node)),
		deletedIds: [...priorNodes.keys()].filter(id => !currentNodes.has(id))
			.sort(compareText),
		changedEdges: {
			added: after.ir.edges.filter(edge => !priorEdges.has(edgeKey(edge))),
			removed: before.ir.edges.filter(edge => !currentEdges.has(edgeKey(edge))),
		},
	}
}

async function mutate(
	root: string,
	expectedRevision: unknown,
	change: (snapshot: WorkspaceSnapshot) => Promise<boolean>,
): Promise<MutationResponse> {
	assertRevision(expectedRevision)
	return serialized(root, () => withWorkspaceWriteLock(root, async () => {
		const before = await readSnapshot(root, true)
		if (before.revision !== expectedRevision)
			throw revisionConflict(expectedRevision, before.revision)
		return withSemanticMutationJournal(root, async () => {
			const changed = await change(before)
			return changed ? delta(before, await readSnapshot(root, true)) : emptyMutation(before.revision)
		})
	}))
}

function featurePath(id: string): string {
	return `.spec/features/${id}.md`
}

function scenarioPath(storageId: string): string {
	return `.spec/scenarios/${storageId}.feature`
}

function storyPath(id: string): string {
	return `.spec/stories/${id}.md`
}

function createId(snapshot: WorkspaceSnapshot): string {
	let id: string
	do {
		id = newUuidV7()
	} while (snapshot.features.has(id) || snapshot.stories.has(id) || snapshot.rules.has(id) || snapshot.scenarios.has(id))
	return id
}

export class SpecClient {
	readonly root: string
	readonly workspace: WorkspaceResource
	readonly graph: GraphResource
	readonly story: StoryResource
	readonly feature: FeatureResource
	readonly rule: RuleResource
	readonly scenario: ScenarioResource

	constructor(root: string) {
		if (typeof root !== 'string' || !root.trim())
			fail('root', 'invalid_format', 'Repository root must be a non-empty path.')
		this.root = resolve(root)
		this.workspace = {
			init: () => initWorkspace(this.root),
			validate: () => validateWorkspace(this.root),
		}
		this.graph = {
			export: async () => {
				const snapshot = await readSnapshot(this.root)
				return { revision: snapshot.revision, data: snapshot.ir }
			},
			get: async (request) => {
				assertShape(request, ['id'])
				assertId(request.id, 'id')
				const snapshot = await readSnapshot(this.root)
				const node = snapshot.ir.nodes.find(node => node.id === request.id)
				if (!node)
					throw notFound(request.id)
				return { revision: snapshot.revision, data: node }
			},
			list: async (request = {}) => {
				assertShape(request, ['kind'], [])
				if (request.kind !== undefined && !NODE_KINDS.includes(request.kind as string))
					fail('kind', 'unsupported', 'Unsupported node kind.')
				const snapshot = await readSnapshot(this.root)
				return {
					revision: snapshot.revision,
					data: snapshot.ir.nodes
						.filter(node => request.kind === undefined || node.kind === request.kind)
						.map(node => 'title' in node
							? { id: node.id, kind: node.kind, title: node.title }
							: { id: node.id, kind: node.kind }),
				}
			},
			incoming: request => this.readEdges(request, 'incoming'),
			outgoing: request => this.readEdges(request, 'outgoing'),
			setRelationTargets: request => this.setRelationTargets(request),
		}
		this.feature = {
			create: request => this.createFeature(request),
			update: request => this.updateFeature(request),
			delete: request => this.deleteFeature(request),
		}
		this.story = {
			create: request => this.createStory(request),
			update: request => this.updateStory(request),
			delete: request => this.deleteStory(request),
		}
		this.rule = {
			create: request => this.createRule(request),
			update: request => this.updateRule(request),
			delete: request => this.deleteRule(request),
			reorder: request => this.reorderRules(request),
			reparent: request => this.reparentRule(request),
		}
		this.scenario = {
			create: request => this.createScenario(request),
			update: request => this.updateScenario(request),
			delete: request => this.deleteScenario(request),
		}
	}

	private async readEdges(
		request: { id: string, type?: RelationType },
		direction: 'incoming' | 'outgoing',
	): Promise<ReadResponse<NormalizedEdge[]>> {
		assertShape(request, ['id', 'type'], ['id'])
		assertId(request.id, 'id')
		if (request.type !== undefined && !RELATIONS.includes(request.type))
			fail('type', 'unsupported', 'Unsupported relation type.')
		const snapshot = await readSnapshot(this.root)
		assertSourceExists(snapshot, request.id)
		const data = snapshot.ir.edges.filter(edge =>
			(direction === 'incoming' ? edge.to : edge.from) === request.id
			&& (request.type === undefined || edge.type === request.type))
		return { revision: snapshot.revision, data }
	}

	private async createFeature(request: FeatureCreateRequest): Promise<MutationResponse> {
		assertShape(request, ['title', 'summary', 'expectedRevision'])
		assertText(request.title, 'title')
		assertText(request.summary, 'summary')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const id = createId(snapshot)
			await writeSemanticFile(this.root, featurePath(id), encodeFeature({
				id,
				title: request.title,
				summary: request.summary,
				rules: [],
			}))
			return true
		})
	}

	private async updateFeature(request: FeatureUpdateRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'changes', 'expectedRevision'])
		assertId(request.id, 'id')
		assertShape(request.changes, ['title', 'summary'], [])
		if ('title' in request.changes)
			assertText(request.changes.title, 'changes.title')
		if ('summary' in request.changes)
			assertText(request.changes.summary, 'changes.summary')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.features.get(request.id)
			if (!stored)
				throw notFound(request.id, 'feature')
			const updated = { ...stored.value, ...request.changes }
			if (updated.title === stored.value.title && updated.summary === stored.value.summary)
				return false
			await writeSemanticFile(this.root, stored.path, encodeFeature(updated, stored.body))
			return true
		})
	}

	private async deleteFeature(request: DeleteRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'expectedRevision'])
		assertId(request.id, 'id')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.features.get(request.id)
			if (!stored)
				throw notFound(request.id, 'feature')
			const inbound = snapshot.ir.edges.filter(edge => edge.to === request.id)
			if (inbound.length > 0)
				throw referencedUnit(request.id, inbound)
			if (stored.value.rules.length > 0)
				fail('id', 'conflict', 'Feature with Rule children cannot be ordinary-deleted.')
			await removeSemanticFile(this.root, stored.path)
			return true
		})
	}

	private async createRule(request: RuleCreateRequest): Promise<MutationResponse> {
		assertShape(request, ['ownerId', 'statement', 'expectedRevision'])
		assertId(request.ownerId, 'ownerId')
		assertText(request.statement, 'statement')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const feature = snapshot.features.get(request.ownerId)
			if (!feature)
				throw notFound(request.ownerId, 'feature')
			const rule = { id: createId(snapshot), statement: request.statement }
			await writeSemanticFile(this.root, feature.path, encodeFeature({
				...feature.value,
				rules: [...feature.value.rules, rule],
			}, feature.body))
			return true
		})
	}

	private async updateRule(request: RuleUpdateRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'changes', 'expectedRevision'])
		assertId(request.id, 'id')
		assertShape(request.changes, ['statement'], [])
		if ('statement' in request.changes)
			assertText(request.changes.statement, 'changes.statement')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.rules.get(request.id)
			if (!stored)
				throw notFound(request.id, 'rule')
			if (request.changes.statement === undefined || request.changes.statement === stored.value.statement)
				return false
			const feature = snapshot.features.get(stored.ownerId)!
			await writeSemanticFile(this.root, feature.path, encodeFeature({
				...feature.value,
				rules: feature.value.rules.map(rule => rule.id === request.id
					? { ...rule, statement: request.changes.statement! }
					: rule),
			}, feature.body))
			return true
		})
	}

	private async deleteRule(request: DeleteRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'expectedRevision'])
		assertId(request.id, 'id')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.rules.get(request.id)
			if (!stored)
				throw notFound(request.id, 'rule')
			const inbound = snapshot.ir.edges.filter(edge => edge.to === request.id)
			if (inbound.length > 0)
				throw referencedUnit(request.id, inbound)
			const feature = snapshot.features.get(stored.ownerId)!
			await writeSemanticFile(this.root, feature.path, encodeFeature({
				...feature.value,
				rules: feature.value.rules.filter(rule => rule.id !== request.id),
			}, feature.body))
			return true
		})
	}

	private async reorderRules(request: RuleReorderRequest): Promise<MutationResponse> {
		assertShape(request, ['ownerId', 'orderedIds', 'expectedRevision'])
		assertId(request.ownerId, 'ownerId')
		if (!Array.isArray(request.orderedIds) || !request.orderedIds.every(isUuidV7))
			fail('orderedIds', 'invalid_format', 'orderedIds must be a complete UUIDv7 array.')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const feature = snapshot.features.get(request.ownerId)
			if (!feature)
				throw notFound(request.ownerId, 'feature')
			const current = feature.value.rules
			if (request.orderedIds.length !== current.length
				|| new Set(request.orderedIds).size !== current.length
				|| request.orderedIds.some(id => !current.some(rule => rule.id === id))) {
				fail('orderedIds', 'conflict', 'orderedIds must contain exactly the current Rule IDs.')
			}
			if (request.orderedIds.every((id, index) => id === current[index]!.id))
				return false
			const byId = new Map(current.map(rule => [rule.id, rule]))
			await writeSemanticFile(this.root, feature.path, encodeFeature({
				...feature.value,
				rules: request.orderedIds.map(id => byId.get(id)!),
			}, feature.body))
			return true
		})
	}

	private async reparentRule(request: RuleReparentRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'newOwnerId', 'expectedRevision'])
		assertId(request.id, 'id')
		assertId(request.newOwnerId, 'newOwnerId')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.rules.get(request.id)
			if (!stored)
				throw notFound(request.id, 'rule')
			const target = snapshot.features.get(request.newOwnerId)
			if (!target)
				throw notFound(request.newOwnerId, 'feature')
			if (stored.ownerId === request.newOwnerId)
				return false
			const source = snapshot.features.get(stored.ownerId)!
			await replaceSemanticFiles(this.root, [
				{
					path: source.path,
					content: encodeFeature({
						...source.value,
						rules: source.value.rules.filter(rule => rule.id !== stored.value.id),
					}, source.body),
				},
				{
					path: target.path,
					content: encodeFeature({
						...target.value,
						rules: [...target.value.rules, stored.value],
					}, target.body),
				},
			], async () => { await readSnapshot(this.root, true) })
			return true
		})
	}

	private async createScenario(request: ScenarioCreateRequest): Promise<MutationResponse> {
		assertShape(request, ['title', 'steps', 'demonstrates', 'expectedRevision'])
		assertScenarioLine(request.title, 'title')
		assertScenarioSteps(request.steps)
		assertRelations(request.demonstrates, 'demonstrates')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const id = createId(snapshot)
			const demonstrates = assertDemonstrates(snapshot, id, request.demonstrates)
			const storageId = newUuidV7()
			await writeSemanticFile(this.root, scenarioPath(storageId), renderNewScenarioFile({
				id,
				title: request.title,
				steps: request.steps,
				demonstrates,
			}))
			return true
		})
	}

	private async updateScenario(request: ScenarioUpdateRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'changes', 'expectedRevision'])
		assertId(request.id, 'id')
		assertShape(request.changes, ['title', 'steps'], [])
		if ('title' in request.changes)
			assertScenarioLine(request.changes.title, 'changes.title')
		if ('steps' in request.changes)
			assertScenarioSteps(request.changes.steps)
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.scenarios.get(request.id)
			if (!stored)
				throw notFound(request.id, 'scenario')
			const title = request.changes.title === undefined ? stored.value.title : request.changes.title
			const steps = request.changes.steps === undefined ? stored.value.steps : request.changes.steps
			const titleChanged = title !== stored.value.title
			const stepsChanged = JSON.stringify(steps) !== JSON.stringify(stored.value.steps)
			if (!titleChanged && !stepsChanged)
				return false
			const raw = updateScenarioInContainer(stored.container, stored.entry, {
				...stored.value,
				title,
				steps,
			}, { title: titleChanged, steps: stepsChanged })
			await writeSemanticFile(this.root, stored.path, raw)
			return true
		})
	}

	private async deleteScenario(request: DeleteRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'expectedRevision'])
		assertId(request.id, 'id')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.scenarios.get(request.id)
			if (!stored)
				throw notFound(request.id, 'scenario')
			const inbound = snapshot.ir.edges.filter(edge => edge.to === request.id)
			if (inbound.length > 0)
				throw referencedUnit(request.id, inbound)
			if (stored.container.entries.length === 1) {
				await removeSemanticFile(this.root, stored.path)
			}
			else {
				await writeSemanticFile(this.root, stored.path, deleteScenarioFromContainer(stored.container, stored.entry))
			}
			return true
		})
	}

	private async createStory(request: StoryCreateRequest): Promise<MutationResponse> {
		assertShape(request, ['title', 'actor', 'goal', 'value', 'motivates', 'expectedRevision'])
		for (const key of ['title', 'actor', 'goal', 'value'] as const)
			assertText(request[key], key)
		if (!Array.isArray(request.motivates) || !request.motivates.every(isUuidV7))
			fail('motivates', 'invalid_format', 'motivates must contain canonical UUIDv7 strings.')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const id = createId(snapshot)
			const targets = assertMotivates(snapshot, id, request.motivates)
			await writeSemanticFile(this.root, storyPath(id), encodeStory({
				id,
				title: request.title,
				actor: request.actor,
				goal: request.goal,
				value: request.value,
				motivates: targets,
			}))
			return true
		})
	}

	private async updateStory(request: StoryUpdateRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'changes', 'expectedRevision'])
		assertId(request.id, 'id')
		assertShape(request.changes, ['title', 'actor', 'goal', 'value'], [])
		for (const key of ['title', 'actor', 'goal', 'value'] as const) {
			if (key in request.changes)
				assertText(request.changes[key], `changes.${key}`)
		}
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.stories.get(request.id)
			if (!stored)
				throw notFound(request.id, 'story')
			const updated = { ...stored.value, ...request.changes }
			if (updated.title === stored.value.title && updated.actor === stored.value.actor
				&& updated.goal === stored.value.goal && updated.value === stored.value.value) {
				return false
			}
			await writeSemanticFile(this.root, stored.path, encodeStory(updated, stored.body))
			return true
		})
	}

	private async deleteStory(request: DeleteRequest): Promise<MutationResponse> {
		assertShape(request, ['id', 'expectedRevision'])
		assertId(request.id, 'id')
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			const stored = snapshot.stories.get(request.id)
			if (!stored)
				throw notFound(request.id, 'story')
			const inbound = snapshot.ir.edges.filter(edge => edge.to === request.id)
			if (inbound.length > 0)
				throw referencedUnit(request.id, inbound)
			await removeSemanticFile(this.root, stored.path)
			return true
		})
	}

	private async setRelationTargets(request: SetRelationTargetsRequest): Promise<MutationResponse> {
		assertShape(request, ['sourceId', 'type', 'targets', 'expectedRevision'])
		assertId(request.sourceId, 'sourceId')
		if (!RELATIONS.includes(request.type))
			fail('type', 'unsupported', 'Unsupported relation type.')
		assertRelations(request.targets)
		return mutate(this.root, request.expectedRevision, async (snapshot) => {
			assertSourceExists(snapshot, request.sourceId)
			const story = snapshot.stories.get(request.sourceId)
			if (request.type === 'motivates' && story) {
				const targets = assertMotivates(snapshot, request.sourceId, request.targets)
				if (sameTargets(story.value.motivates, targets))
					return false
				await writeSemanticFile(this.root, story.path, encodeStory({
					...story.value,
					motivates: targets,
				}, story.body))
				return true
			}
			const scenario = snapshot.scenarios.get(request.sourceId)
			if (request.type === 'demonstrates' && scenario) {
				const targets = assertDemonstrates(snapshot, request.sourceId, request.targets)
				if (sameTargets(scenario.value.demonstrates, targets))
					return false
				await writeSemanticFile(this.root, scenario.path, updateScenarioInContainer(
					scenario.container,
					scenario.entry,
					{ ...scenario.value, demonstrates: targets },
					{ demonstrates: true },
				))
				return true
			}
			throw relationInvalid('source_kind', request.sourceId, request.type, request.targets)
		})
	}
}

export function createSpecClient(root: string): SpecClient {
	return new SpecClient(root)
}
