export const WORKSPACE_FORMAT_VERSION = 1 as const
export const IR_FORMAT_VERSION = 1 as const

export type WorkspaceFormatVersion = typeof WORKSPACE_FORMAT_VERSION
export type IrFormatVersion = typeof IR_FORMAT_VERSION

export type NodeKind = 'story' | 'feature' | 'contract' | 'scenario' | 'rule' | 'clause'
export type SliceNodeKind = 'story' | 'feature' | 'rule' | 'scenario'
export type RelationType = 'motivates' | 'demonstrates' | 'constrains'

export interface SourceReference {
	path: string
}

export interface StoryNode {
	id: string
	kind: 'story'
	title: string
	actor: string
	goal: string
	value: string
	source: SourceReference
}

export interface FeatureNode {
	id: string
	kind: 'feature'
	title: string
	summary: string
	source: SourceReference
}

export interface ContractNode {
	id: string
	kind: 'contract'
	title: string
	summary: string
	source: SourceReference
}

export interface ScenarioStep {
	type: 'given' | 'when' | 'then'
	text: string
}

export interface ScenarioNode {
	id: string
	kind: 'scenario'
	title: string
	steps: ScenarioStep[]
	source: SourceReference
}

export interface RuleNode {
	id: string
	kind: 'rule'
	statement: string
	ownerId: string
	source: SourceReference
}

export interface ClauseNode {
	id: string
	kind: 'clause'
	statement: string
	ownerId: string
	source: SourceReference
}

export type NormalizedNode = StoryNode | FeatureNode | ContractNode | ScenarioNode | RuleNode | ClauseNode

export interface NormalizedEdge {
	from: string
	type: RelationType
	to: string
}

export interface NormalizedIr {
	formatVersion: IrFormatVersion
	nodes: NormalizedNode[]
	edges: NormalizedEdge[]
}

export interface ReadResponse<T> {
	revision: string
	data: T
}

export type ValidationReason = 'missing' | 'empty' | 'invalid_format' | 'unsupported' | 'duplicate' | 'unresolved' | 'invariant'

export interface ValidationIssue {
	source: SourceReference
	path: string
	reason: ValidationReason
	message: string
}

export interface ValidationResult {
	valid: boolean
	revision?: string
	issues: ValidationIssue[]
}

export interface ChangedEdges {
	added: NormalizedEdge[]
	removed: NormalizedEdge[]
}

export interface MutationResponse {
	revision: string
	changedNodes: NormalizedNode[]
	deletedIds: string[]
	changedEdges: ChangedEdges
}

export interface ExpectedRevisionRequest {
	expectedRevision: string
}

export interface StoryCreateRequest extends ExpectedRevisionRequest {
	title: string
	actor: string
	goal: string
	value: string
	motivates: string[]
}

export interface StoryUpdateChanges {
	title?: string
	actor?: string
	goal?: string
	value?: string
}

export interface StoryUpdateRequest extends ExpectedRevisionRequest {
	id: string
	changes: StoryUpdateChanges
}

export interface FeatureCreateRequest extends ExpectedRevisionRequest {
	title: string
	summary: string
}

export interface FeatureUpdateChanges {
	title?: string
	summary?: string
}

export interface FeatureUpdateRequest extends ExpectedRevisionRequest {
	id: string
	changes: FeatureUpdateChanges
}

export interface ScenarioCreateRequest extends ExpectedRevisionRequest {
	title: string
	steps: ScenarioStep[]
	demonstrates: string[]
}

export interface ScenarioUpdateRequest extends ExpectedRevisionRequest {
	id: string
	changes: { title?: string, steps?: ScenarioStep[] }
}

export interface RuleCreateRequest extends ExpectedRevisionRequest {
	ownerId: string
	statement: string
}

export interface RuleUpdateRequest extends ExpectedRevisionRequest {
	id: string
	changes: { statement?: string }
}

export interface RuleReorderRequest extends ExpectedRevisionRequest {
	ownerId: string
	orderedIds: string[]
}

export interface RuleReparentRequest extends ExpectedRevisionRequest {
	id: string
	newOwnerId: string
}

export interface DeleteRequest extends ExpectedRevisionRequest {
	id: string
}

export interface SetRelationTargetsRequest extends ExpectedRevisionRequest {
	sourceId: string
	type: RelationType
	targets: string[]
}

export interface WorkspaceResource {
	init: () => Promise<MutationResponse>
	validate: () => Promise<ValidationResult>
}

export interface GraphResource {
	export: () => Promise<ReadResponse<NormalizedIr>>
	get: (request: { id: string }) => Promise<ReadResponse<NormalizedNode>>
	list: (request?: { kind?: NodeKind }) => Promise<ReadResponse<Array<{ id: string, kind: NodeKind, title?: string }>>>
	incoming: (request: { id: string, type?: RelationType }) => Promise<ReadResponse<NormalizedEdge[]>>
	outgoing: (request: { id: string, type?: RelationType }) => Promise<ReadResponse<NormalizedEdge[]>>
	setRelationTargets: (request: SetRelationTargetsRequest) => Promise<MutationResponse>
}

export interface StoryResource {
	create: (request: StoryCreateRequest) => Promise<MutationResponse>
	update: (request: StoryUpdateRequest) => Promise<MutationResponse>
	delete: (request: DeleteRequest) => Promise<MutationResponse>
}

export interface FeatureResource {
	create: (request: FeatureCreateRequest) => Promise<MutationResponse>
	update: (request: FeatureUpdateRequest) => Promise<MutationResponse>
	delete: (request: DeleteRequest) => Promise<MutationResponse>
}

export interface RuleResource {
	create: (request: RuleCreateRequest) => Promise<MutationResponse>
	update: (request: RuleUpdateRequest) => Promise<MutationResponse>
	delete: (request: DeleteRequest) => Promise<MutationResponse>
	reorder: (request: RuleReorderRequest) => Promise<MutationResponse>
	reparent: (request: RuleReparentRequest) => Promise<MutationResponse>
}

export interface ScenarioResource {
	create: (request: ScenarioCreateRequest) => Promise<MutationResponse>
	update: (request: ScenarioUpdateRequest) => Promise<MutationResponse>
	delete: (request: DeleteRequest) => Promise<MutationResponse>
}
