import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact, ArtifactKind, RelationEntry, ResourceDescriptor, Status } from '../domain/model'
import type { RelationType } from '../domain/relations'
import type { ProjectSnapshot } from './snapshot'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { validateBody } from '../domain/body-schemas'
import { aggregateDiagnostics, diagnostic } from '../domain/diagnostics'
import { encodeArtifact } from '../domain/envelope'
import { generateUuidV7, validateUuidV7 } from '../domain/identity'
import { isStatusAllowed } from '../domain/lifecycle'
import { ALLOWED_STATUSES, ARTIFACT_KINDS, isArtifactKind, isStatus, SCHEMA_BY_KIND } from '../domain/model'
import { isRelationType, RELATION_TYPES } from '../domain/relations'
import { compareBytewise } from '../domain/text'
import { canonicalArtifactPath, RESOURCE_ROOT } from '../repository/layout'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

export interface MutationResult<T> {
	ok: boolean
	applied: boolean
	value?: T
	diagnostics: Diagnostic[]
}

export interface ArtifactListFilters {
	kind?: ArtifactKind
	status?: Status
}

export interface RelationView {
	source: string
	type: RelationType
	target: string
}

export interface RelationListFilters {
	artifactId?: string
	direction?: 'incoming' | 'outgoing' | 'all'
	type?: RelationType
}

export interface ResourceListFilters {
	artifactId?: string
}

export interface ResourceReadValue {
	artifactId: string
	resource: ResourceDescriptor
	content: string
	encoding: 'utf8' | 'base64'
	bytes: number
}

interface MutationContext {
	root: string
	snapshot: ProjectSnapshot
	artifacts: Map<string, Artifact>
}

type ArtifactWriteMode = 'create' | 'replace'

const TERMINAL_STATUSES = new Set<Status>(['superseded', 'retired', 'completed'])

function failure<T>(diagnostics: Diagnostic[], applied = false): MutationResult<T> {
	return { ok: false, applied, diagnostics: aggregateDiagnostics(diagnostics) }
}

function success<T>(value: T, applied = true): MutationResult<T> {
	return { ok: true, applied, value, diagnostics: [] }
}

function pathFor(artifact: Artifact): string {
	return artifact.path ?? canonicalArtifactPath(artifact.kind, artifact.id)
}

function resultArtifact(artifact: Artifact): Artifact {
	return { ...artifact, relations: [...artifact.relations], resources: [...artifact.resources] }
}

function isTerminal(artifact: Artifact): boolean {
	return TERMINAL_STATUSES.has(artifact.status)
}

function notFound(id: string): Diagnostic {
	return diagnostic('SPEC-ARTIFACT-NOT-FOUND', `Artifact '${id}' was not found.`, { artifactId: id })
}

function immutable(artifact: Artifact): Diagnostic {
	return diagnostic('SPEC-ARTIFACT-IMMUTABLE', `Artifact '${artifact.id}' is terminal (${artifact.status}) and cannot be mutated.`, { artifactId: artifact.id, path: pathFor(artifact) })
}

function validateTitle(title: unknown): Diagnostic[] {
	return typeof title === 'string' && title.trim() !== '' && !/[\r\n]/.test(title)
		? []
		: [diagnostic('SPEC-ENVELOPE-INVALID', 'Artifact title must be a non-empty single-line string.', { field: 'title' })]
}

function validateArtifactForWrite(artifact: Artifact): Diagnostic[] {
	return aggregateDiagnostics([
		...validateUuidV7(artifact.id, pathFor(artifact), 'id'),
		...validateTitle(artifact.title),
		...(!isArtifactKind(artifact.kind) ? [diagnostic('SPEC-ENVELOPE-INVALID', `Unknown artifact kind ${JSON.stringify(artifact.kind)}.`, { field: 'kind' })] : []),
		...(isArtifactKind(artifact.kind) && !isStatusAllowed(artifact.kind, artifact.status)
			? [diagnostic('SPEC-STATUS-INVALID', `Status '${artifact.status}' is not allowed for kind '${artifact.kind}'.`, { artifactId: artifact.id, field: 'status' })]
			: []),
		...(isArtifactKind(artifact.kind) ? validateBody(artifact.kind, artifact.status, artifact.body, { path: pathFor(artifact) }) : []),
	])
}

async function loadMutationContext(root: string): Promise<MutationResult<MutationContext>> {
	const loaded = await loadSnapshotFromWorkingTree(root)
	const validation = validateSnapshot(loaded.snapshot)
	const diagnostics = aggregateDiagnostics([
		...loaded.diagnostics,
		...validation.diagnostics,
		...validateRelationGraph(loaded.snapshot.artifacts),
	])
	if (diagnostics.length > 0 || !validation.complete)
		return failure(diagnostics.length > 0 ? diagnostics : [diagnostic('SPEC-IO-ERROR', 'The Spec workspace could not be read completely.', { path: '.spec' })])
	const artifacts = new Map<string, Artifact>()
	for (const artifact of loaded.snapshot.artifacts)
		artifacts.set(artifact.id, artifact)
	return success({ root, snapshot: loaded.snapshot, artifacts }, false)
}

function artifactFromContext(context: MutationContext, id: string): Artifact | undefined {
	return context.artifacts.get(id)
}

function withResultPath(artifact: Artifact): Artifact {
	return { ...resultArtifact(artifact), path: pathFor(artifact) }
}

async function writeArtifactFile(root: string, artifact: Artifact, mode: ArtifactWriteMode): Promise<void> {
	const path = pathFor(artifact)
	const target = resolve(root, path)
	const targetDirectory = dirname(target)
	await mkdir(targetDirectory, { recursive: true })
	let existing
	try {
		existing = await lstat(target)
	}
	catch {
		existing = undefined
	}
	if (mode === 'create' && existing)
		throw new Error(`Artifact path '${path}' already exists.`)
	if (mode === 'replace' && (!existing || !existing.isFile() || existing.isSymbolicLink()))
		throw new Error(`Artifact path '${path}' is not a regular file.`)
	const temporary = join(resolve(root), `.spec-tool-write-${randomUUID()}.tmp`)
	try {
		await writeFile(temporary, encodeArtifact(artifact), { encoding: 'utf8', flag: 'wx' })
		if (mode === 'replace' && existing)
			await chmod(temporary, existing.mode & 0o7777)
		if (mode === 'create') {
			await link(temporary, target)
		}
		else {
			await rename(temporary, target)
		}
	}
	finally {
		await rm(temporary, { force: true })
			.catch(() => undefined)
	}
}

async function deleteArtifactFile(root: string, artifact: Artifact): Promise<void> {
	const target = resolve(root, pathFor(artifact))
	const stat = await lstat(target)
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`Artifact path '${pathFor(artifact)}' is not a regular file.`)
	await unlink(target)
}

function relationEntry(type: RelationType, target: string): RelationEntry {
	return { type, target }
}

function hasRelation(source: Artifact, type: RelationType, target: string): boolean {
	return source.relations.some(relation => relation.type === type && relation.target === target)
}

function kindRelationError(source: Artifact, relation: RelationEntry, target: Artifact): Diagnostic | undefined {
	if (relation.type === 'refines') {
		const valid = (source.kind === 'use-case' && target.kind === 'story')
			|| (source.kind === 'feature' && target.kind === 'use-case')
			|| (source.kind === 'requirement' && target.kind === 'feature')
		if (!valid)
			return diagnostic('SPEC-RELATION-KIND', `Relation 'refines' is not allowed from '${source.kind}' to '${target.kind}'.`, { artifactId: source.id, field: 'relations', related: [{ path: pathFor(target), message: `Target '${target.id}'.` }] })
	}
	if (relation.type === 'addresses' && (source.kind !== 'decision' || target.kind !== 'requirement'))
		return diagnostic('SPEC-RELATION-KIND', 'Relation \'addresses\' is only allowed from \'decision\' to \'requirement\'.', { artifactId: source.id, field: 'relations' })
	if (relation.type === 'governed-by' && target.kind !== 'policy')
		return diagnostic('SPEC-RELATION-KIND', 'Relation \'governed-by\' must target a \'policy\' Artifact.', { artifactId: source.id, field: 'relations' })
	if (relation.type === 'supersedes' && (source.kind !== target.kind || source.kind === 'project' || source.kind === 'change'))
		return diagnostic('SPEC-RELATION-KIND', 'Relation \'supersedes\' requires two Artifacts of the same non-project, non-change kind.', { artifactId: source.id, field: 'relations' })
	return undefined
}

function supersedesCycle(artifacts: Iterable<Artifact>, sourceId: string, targetId: string): boolean {
	const outgoing = new Map<string, string[]>()
	for (const artifact of artifacts) {
		outgoing.set(artifact.id, artifact.relations.filter(relation => relation.type === 'supersedes')
			.map(relation => relation.target))
	}
	const visited = new Set<string>()
	const pending = [targetId]
	while (pending.length > 0) {
		const current = pending.pop()!
		if (current === sourceId)
			return true
		if (visited.has(current))
			continue
		visited.add(current)
		pending.push(...(outgoing.get(current) ?? []))
	}
	return false
}

/** Validate the graph before a mutation and after a proposed in-memory change. */
export function validateRelationGraph(artifacts: readonly Artifact[]): Diagnostic[] {
	const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]))
	const diagnostics: Diagnostic[] = []
	for (const source of artifacts) {
		const seen = new Set<string>()
		for (const relation of source.relations) {
			if (!isRelationType(relation.type)) {
				diagnostics.push(diagnostic('SPEC-RELATION-INVALID', `Unknown relation type '${relation.type}'.`, { path: pathFor(source), artifactId: source.id, field: 'relations' }))
				continue
			}
			const key = `${relation.type}\u0000${relation.target}`
			if (seen.has(key))
				diagnostics.push(diagnostic('SPEC-RELATION-DUPLICATE', `Artifact '${source.id}' contains duplicate relation '${relation.type}' -> '${relation.target}'.`, { path: pathFor(source), artifactId: source.id, field: 'relations' }))
			seen.add(key)
			const target = byId.get(relation.target)
			if (!target) {
				diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', `Relation target '${relation.target}' does not exist.`, { path: pathFor(source), artifactId: source.id, field: 'relations' }))
				continue
			}
			const kindError = kindRelationError(source, relation, target)
			if (kindError)
				diagnostics.push(kindError)
			if (relation.type === 'supersedes' && (source.id === target.id || supersedesCycle(artifacts, source.id, target.id)))
				diagnostics.push(diagnostic('SPEC-RELATION-CYCLE', `Supersedes relation '${source.id}' -> '${target.id}' creates a cycle or self-reference.`, { path: pathFor(source), artifactId: source.id, field: 'relations' }))
			if (relation.type === 'supersedes' && source.status !== 'active')
				diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', `Supersedes source '${source.id}' must be an active replacement.`, { path: pathFor(source), artifactId: source.id, field: 'status' }))
			if (relation.type === 'supersedes' && target.status !== 'superseded' && !(source.status === 'active' && target.status === 'active'))
				diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', `Superseded target '${target.id}' must have status 'superseded'.`, { path: pathFor(source), artifactId: source.id, field: 'relations' }))
		}
	}
	for (const target of artifacts.filter(artifact => artifact.status === 'superseded')) {
		const replacementCount = artifacts.filter(source => source.status === 'active'
			&& source.kind === target.kind
			&& hasRelation(source, 'supersedes', target.id)).length
		if (replacementCount === 0)
			diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', `Superseded Artifact '${target.id}' must have an active same-kind replacement incoming.`, { path: pathFor(target), artifactId: target.id, field: 'status' }))
	}
	return aggregateDiagnostics(diagnostics)
}

function copyArtifacts(context: MutationContext): Artifact[] {
	return [...context.artifacts.values()].map(artifact => ({ ...artifact, relations: [...artifact.relations], resources: [...artifact.resources] }))
}

function proposedGraph(context: MutationContext, replacements: readonly Artifact[]): Diagnostic[] {
	const byId = new Map(copyArtifacts(context)
		.map(artifact => [artifact.id, artifact]))
	for (const artifact of replacements)
		byId.set(artifact.id, artifact)
	return validateRelationGraph([...byId.values()])
}

function relationView(source: Artifact, relation: RelationEntry): RelationView {
	return { source: source.id, type: relation.type as RelationType, target: relation.target }
}

function ioFailure<T>(error: unknown, path: string): MutationResult<T> {
	return failure([diagnostic('SPEC-IO-ERROR', `Could not mutate '${path}': ${(error as Error).message}.`, { path })])
}

export interface ArtifactCreateInput {
	kind: ArtifactKind
	title: string
	body?: string
	status?: Status
	id?: string
}

export async function createArtifact(root: string, input: ArtifactCreateInput): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const status = input.status ?? (input.kind === 'project' ? 'active' : 'draft')
	const id = input.id ?? generateUuidV7()
	const candidate: Artifact = {
		schema: SCHEMA_BY_KIND[input.kind],
		kind: input.kind,
		id,
		title: input.title,
		status,
		relations: [],
		resources: [],
		body: input.body ?? '',
		path: canonicalArtifactPath(input.kind, id),
	}
	const diagnostics = validateArtifactForWrite(candidate)
	if (context.artifacts.has(id))
		diagnostics.push(diagnostic('SPEC-IDENTITY-DUPLICATE', `Artifact id '${id}' already exists.`, { artifactId: id, field: 'id' }))
	if (candidate.kind === 'project' && [...context.artifacts.values()].some(artifact => artifact.kind === 'project'))
		diagnostics.push(diagnostic('SPEC-PROJECT-COUNT', 'Workspace may contain exactly one project Artifact.', { path: '.spec/projects' }))
	if (candidate.kind === 'project' && status !== 'active')
		diagnostics.push(diagnostic('SPEC-STATUS-INVALID', 'PROJECT Artifacts must use status \'active\'.', { artifactId: id, field: 'status' }))
	if (candidate.kind !== 'project' && status !== 'draft')
		diagnostics.push(diagnostic('SPEC-LIFECYCLE-INVALID', `New '${candidate.kind}' Artifacts must start in 'draft'; use an explicit lifecycle command for later transitions.`, { artifactId: id, field: 'status' }))
	if (diagnostics.length > 0)
		return failure(diagnostics)
	try {
		await writeArtifactFile(root, candidate, 'create')
		return success(withResultPath(candidate))
	}
	catch (error) {
		return ioFailure(error, pathFor(candidate))
	}
}

export async function getArtifact(root: string, id: string): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const artifact = artifactFromContext(contextResult.value, id)
	return artifact ? success(withResultPath(artifact), false) : failure([notFound(id)])
}

export async function listArtifacts(root: string, filters: ArtifactListFilters = {}): Promise<MutationResult<Artifact[]>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	if (filters.kind !== undefined && !isArtifactKind(filters.kind))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown artifact kind '${filters.kind}'.`, { field: 'kind' })])
	if (filters.status !== undefined && !isStatus(filters.status))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown artifact status '${filters.status}'.`, { field: 'status' })])
	const artifacts = [...contextResult.value.artifacts.values()]
		.filter(artifact => (filters.kind === undefined || artifact.kind === filters.kind) && (filters.status === undefined || artifact.status === filters.status))
		.sort((left, right) => compareBytewise(left.path!, right.path!))
		.map(withResultPath)
	return success(artifacts, false)
}

export interface ArtifactUpdateInput {
	id: string
	title?: string
	body?: string
}

export async function updateArtifact(root: string, input: ArtifactUpdateInput): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const current = artifactFromContext(contextResult.value, input.id)
	if (!current)
		return failure([notFound(input.id)])
	if (isTerminal(current))
		return failure([immutable(current)])
	if (input.title === undefined && input.body === undefined)
		return failure([diagnostic('SPEC-CLI-INVALID', 'Artifact update requires --title, --body, or --body-file.', { artifactId: current.id })])
	const candidate: Artifact = {
		...current,
		title: input.title ?? current.title,
		body: input.body ?? current.body,
		path: pathFor(current),
	}
	const diagnostics = validateArtifactForWrite(candidate)
	if (diagnostics.length > 0)
		return failure(diagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(withResultPath(candidate))
	}
	catch (error) {
		return ioFailure(error, pathFor(current))
	}
}

export async function deleteArtifact(root: string, id: string): Promise<MutationResult<{ id: string, path: string }>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const current = artifactFromContext(context, id)
	if (!current)
		return failure([notFound(id)])
	if (current.status !== 'draft')
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Only draft Artifacts may be physically deleted; '${id}' is '${current.status}'.`, { artifactId: id, path: pathFor(current), field: 'status' })])
	const incoming = [...context.artifacts.values()].flatMap(source => source.relations
		.filter(relation => relation.target === id)
		.map(relation => ({ source, relation })))
	if (incoming.length > 0)
		return failure([diagnostic('SPEC-ARTIFACT-DELETE-INTEGRITY', `Artifact '${id}' cannot be deleted while incoming relations exist.`, { artifactId: id, path: pathFor(current), related: incoming.map(item => ({ path: pathFor(item.source), field: 'relations', message: `${item.relation.type} from '${item.source.id}'.` })) })])
	try {
		await deleteArtifactFile(root, current)
		return success({ id, path: pathFor(current) })
	}
	catch (error) {
		return ioFailure(error, pathFor(current))
	}
}

function lifecycleCandidate(current: Artifact, status: Status): Artifact {
	return { ...current, status, path: pathFor(current), relations: [...current.relations], resources: [...current.resources] }
}

export async function activateArtifact(root: string, id: string): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const current = artifactFromContext(contextResult.value, id)
	if (!current)
		return failure([notFound(id)])
	if (current.kind === 'project' || current.status !== 'draft' || !isStatusAllowed(current.kind, 'active'))
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Artifact '${id}' cannot transition from '${current.status}' to 'active'.`, { artifactId: id, path: pathFor(current), field: 'status' })])
	const candidate = lifecycleCandidate(current, 'active')
	const diagnostics = validateArtifactForWrite(candidate)
	if (diagnostics.length > 0)
		return failure(diagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(withResultPath(candidate))
	}
	catch (error) {
		return ioFailure(error, pathFor(current))
	}
}

export async function completeArtifact(root: string, id: string): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const current = artifactFromContext(contextResult.value, id)
	if (!current)
		return failure([notFound(id)])
	if (current.kind !== 'change' || current.status !== 'draft')
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Artifact '${id}' cannot transition from '${current.status}' to 'completed'.`, { artifactId: id, path: pathFor(current), field: 'status' })])
	const candidate = lifecycleCandidate(current, 'completed')
	const diagnostics = validateArtifactForWrite(candidate)
	if (diagnostics.length > 0)
		return failure(diagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(withResultPath(candidate))
	}
	catch (error) {
		return ioFailure(error, pathFor(current))
	}
}

export async function retireArtifact(root: string, id: string): Promise<MutationResult<Artifact>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const current = artifactFromContext(context, id)
	if (!current)
		return failure([notFound(id)])
	if (current.kind === 'project' || !['draft', 'active'].includes(current.status))
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Artifact '${id}' cannot transition from '${current.status}' to 'retired'.`, { artifactId: id, path: pathFor(current), field: 'status' })])
	const candidate = lifecycleCandidate(current, 'retired')
	const graphDiagnostics = proposedGraph(context, [candidate])
	if (graphDiagnostics.length > 0)
		return failure(graphDiagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(withResultPath(candidate))
	}
	catch (error) {
		return ioFailure(error, pathFor(current))
	}
}

function supersedeCandidates(context: MutationContext, replacementId: string, replacedId: string): MutationResult<{ replacement: Artifact, replaced: Artifact, replacementNeedsWrite: boolean }> {
	const replacement = artifactFromContext(context, replacementId)
	const replaced = artifactFromContext(context, replacedId)
	if (!replacement)
		return failure([notFound(replacementId)])
	if (!replaced)
		return failure([notFound(replacedId)])
	if (replacement.id === replaced.id)
		return failure([diagnostic('SPEC-RELATION-CYCLE', 'An Artifact cannot supersede itself.', { artifactId: replacement.id })])
	if (replacement.kind !== replaced.kind || replacement.kind === 'project' || replacement.kind === 'change')
		return failure([diagnostic('SPEC-RELATION-KIND', 'Only same-kind non-project, non-change Artifacts may supersede one another.', { artifactId: replacement.id, field: 'relations' })])
	if (replacement.status !== 'draft' && replacement.status !== 'active')
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Replacement Artifact '${replacement.id}' must be draft or active.`, { artifactId: replacement.id, field: 'status' })])
	if (replaced.status !== 'active')
		return failure([diagnostic('SPEC-LIFECYCLE-INVALID', `Replaced Artifact '${replaced.id}' must be active.`, { artifactId: replaced.id, field: 'status' })])
	if (supersedesCycle(context.artifacts.values(), replacement.id, replaced.id))
		return failure([diagnostic('SPEC-RELATION-CYCLE', `Supersedes relation '${replacement.id}' -> '${replaced.id}' would create a cycle.`, { artifactId: replacement.id, field: 'relations' })])

	const inheritedTargets = replaced.relations
		.filter(relation => relation.type === 'supersedes')
		.map(relation => relation.target)
	const requiredTargets = [replaced.id, ...inheritedTargets]
	const replacementRelations = [...replacement.relations]
	let replacementNeedsWrite = replacement.status !== 'active'
	for (const targetId of requiredTargets) {
		if (!hasRelation(replacement, 'supersedes', targetId)) {
			replacementRelations.push(relationEntry('supersedes', targetId))
			replacementNeedsWrite = true
		}
	}

	const replacementCandidate: Artifact = {
		...replacement,
		status: 'active',
		relations: replacementRelations,
		resources: [...replacement.resources],
		path: pathFor(replacement),
	}
	const replacedCandidate: Artifact = {
		...lifecycleCandidate(replaced, 'superseded'),
		relations: replaced.relations.filter(relation => relation.type !== 'supersedes'),
	}
	const diagnostics = aggregateDiagnostics([
		...validateArtifactForWrite(replacementCandidate),
		...proposedGraph(context, [replacementCandidate, replacedCandidate]),
	])
	if (diagnostics.length > 0)
		return failure(diagnostics)
	return success({ replacement: replacementCandidate, replaced: replacedCandidate, replacementNeedsWrite }, false)
}

export async function supersedeArtifacts(root: string, replacementId: string, replacedId: string): Promise<MutationResult<{ replacement: Artifact, replaced: Artifact }>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const candidates = supersedeCandidates(contextResult.value, replacementId, replacedId)
	if (!candidates.ok || !candidates.value)
		return failure(candidates.diagnostics)
	const { replacement, replaced, replacementNeedsWrite } = candidates.value
	if (replacementNeedsWrite) {
		try {
			// This first write is already a valid graph state: the replacement is
			// active, points at the still-active old Artifact, and has inherited
			// any current supersedes targets held by the old Artifact.
			await writeArtifactFile(root, replacement, 'replace')
		}
		catch (error) {
			return ioFailure(error, pathFor(replacement))
		}
	}
	try {
		// The second write atomically makes the old Artifact terminal while
		// removing its outgoing supersedes edges, which are now owned by the
		// active replacement.
		await writeArtifactFile(root, replaced, 'replace')
		return success({ replacement: withResultPath(replacement), replaced: withResultPath(replaced) })
	}
	catch (error) {
		const result = ioFailure<{ replacement: Artifact, replaced: Artifact }>(error, pathFor(replaced))
		return { ...result, applied: replacementNeedsWrite }
	}
}

function relationMutationChecks(source: Artifact, target: Artifact, type: RelationType): Diagnostic[] {
	const relation = relationEntry(type, target.id)
	const diagnostics: Diagnostic[] = []
	const kindError = kindRelationError(source, relation, target)
	if (kindError)
		diagnostics.push(kindError)
	if (type === 'addresses' && target.status !== 'active')
		diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', 'New \'addresses\' relations must target an active requirement.', { artifactId: target.id, field: 'status' }))
	if (type === 'governed-by' && target.status !== 'active')
		diagnostics.push(diagnostic('SPEC-RELATION-INTEGRITY', 'New \'governed-by\' relations must target an active policy.', { artifactId: target.id, field: 'status' }))
	if (hasRelation(source, type, target.id))
		diagnostics.push(diagnostic('SPEC-RELATION-DUPLICATE', `Relation '${type}' from '${source.id}' to '${target.id}' already exists.`, { artifactId: source.id, field: 'relations' }))
	return diagnostics
}

export async function addRelation(root: string, sourceId: string, targetId: string, type: RelationType): Promise<MutationResult<RelationView | { replacement: Artifact, replaced: Artifact }>> {
	if (!isRelationType(type))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown relation type '${type}'.`, { field: 'type' })])
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const source = artifactFromContext(context, sourceId)
	const target = artifactFromContext(context, targetId)
	if (!source)
		return failure([notFound(sourceId)])
	if (!target)
		return failure([notFound(targetId)])
	if (isTerminal(source))
		return failure([immutable(source)])
	if (type === 'supersedes')
		return supersedeArtifacts(root, sourceId, targetId)
	const diagnostics = relationMutationChecks(source, target, type)
	if (diagnostics.length > 0)
		return failure(diagnostics)
	const candidate: Artifact = { ...source, relations: [...source.relations, relationEntry(type, target.id)], path: pathFor(source) }
	const graphDiagnostics = proposedGraph(context, [candidate])
	if (graphDiagnostics.length > 0)
		return failure(graphDiagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(relationView(candidate, candidate.relations[candidate.relations.length - 1]!))
	}
	catch (error) {
		return ioFailure(error, pathFor(source))
	}
}

export async function removeRelation(root: string, sourceId: string, targetId: string, type: RelationType): Promise<MutationResult<RelationView>> {
	if (!isRelationType(type))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown relation type '${type}'.`, { field: 'type' })])
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const source = artifactFromContext(context, sourceId)
	const target = artifactFromContext(context, targetId)
	if (!source)
		return failure([notFound(sourceId)])
	if (!target)
		return failure([notFound(targetId)])
	if (isTerminal(source))
		return failure([immutable(source)])
	if (!hasRelation(source, type, targetId))
		return failure([diagnostic('SPEC-RELATION-INTEGRITY', `Relation '${type}' from '${sourceId}' to '${targetId}' does not exist.`, { artifactId: sourceId, field: 'relations' })])
	if ((type === 'addresses' || type === 'governed-by') && isTerminal(target))
		return failure([diagnostic('SPEC-RELATION-INTEGRITY', `Historical '${type}' relation from '${sourceId}' to terminal Artifact '${targetId}' must be retained.`, { artifactId: sourceId, field: 'relations' })])
	const candidate: Artifact = { ...source, relations: source.relations.filter(relation => !(relation.type === type && relation.target === targetId)), path: pathFor(source) }
	const graphDiagnostics = proposedGraph(context, [candidate])
	if (graphDiagnostics.length > 0)
		return failure(graphDiagnostics)
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success({ source: sourceId, type, target: targetId })
	}
	catch (error) {
		return ioFailure(error, pathFor(source))
	}
}

export async function listRelations(root: string, filters: RelationListFilters = {}): Promise<MutationResult<RelationView[]>> {
	if (filters.type !== undefined && !isRelationType(filters.type))
		return failure([diagnostic('SPEC-CLI-INVALID', `Unknown relation type '${filters.type}'.`, { field: 'type' })])
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	if (filters.artifactId !== undefined && !context.artifacts.has(filters.artifactId))
		return failure([notFound(filters.artifactId)])
	const direction = filters.direction ?? (filters.artifactId ? 'all' : 'outgoing')
	const views: RelationView[] = []
	for (const source of context.artifacts.values()) {
		for (const relation of source.relations) {
			if (!isRelationType(relation.type) || (filters.type !== undefined && relation.type !== filters.type))
				continue
			const outgoing = filters.artifactId === undefined || (source.id === filters.artifactId && (direction === 'outgoing' || direction === 'all'))
			const incoming = filters.artifactId !== undefined && relation.target === filters.artifactId && (direction === 'incoming' || direction === 'all')
			if (outgoing || incoming)
				views.push(relationView(source, relation))
		}
	}
	views.sort((left, right) => compareBytewise(left.source, right.source) || compareBytewise(left.type, right.type) || compareBytewise(left.target, right.target))
	return success(views, false)
}

function isHttpsLocation(location: string): boolean {
	return /^https:\/\//i.test(location)
}

function isOtherUrl(location: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(location)
}

interface LocalResourcePathResult {
	absolutePath?: string
	diagnostics: Diagnostic[]
}

async function validateLocalResourcePath(root: string, ownerId: string, location: string, requireFile: boolean): Promise<LocalResourcePathResult> {
	const prefix = `${RESOURCE_ROOT}/${ownerId}/`
	if (location.includes('\\') || location.includes('\0') || isAbsolute(location) || win32.isAbsolute(location))
		return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', 'Local Resource locations must be relative POSIX paths without absolute or backslash components.', { field: 'location' })] }
	if (!location.startsWith(prefix))
		return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', `Local Resource locations must be under '${prefix}'.`, { field: 'location' })] }
	const segments = location.split('/')
	if (segments.length < 4 || segments[0] !== '.spec' || segments[1] !== 'resources' || segments[2] !== ownerId || segments.slice(3)
		.some(segment => segment === '' || segment === '.' || segment === '..')) {
		return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', 'Local Resource locations contain an unsafe path.', { field: 'location' })] }
	}
	if (posix.normalize(location) !== location)
		return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', 'Local Resource locations must be normalized and may not contain traversal segments.', { field: 'location' })] }
	const absolutePath = resolve(root, ...segments)
	const rootPath = resolve(root)
	const relativePath = relative(rootPath, absolutePath)
	if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath))
		return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', 'Local Resource location escapes the workspace root.', { field: 'location' })] }
	let current = rootPath
	for (let index = 0; index < segments.length; index++) {
		current = join(current, segments[index]!)
		let stat
		try {
			stat = await lstat(current)
		}
		catch (error) {
			if (!requireFile && index === segments.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT')
				return { absolutePath, diagnostics: [] }
			return { diagnostics: [diagnostic('SPEC-RESOURCE-NOT-FOUND', `Local Resource path '${location}' does not exist.`, { field: 'location' })] }
		}
		if (stat.isSymbolicLink())
			return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', `Symbolic links are not allowed in local Resource paths: '${location}'.`, { field: 'location' })] }
		if (index < segments.length - 1 && !stat.isDirectory()) {
			return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', `Resource path component '${segments.slice(0, index + 1)
				.join('/')}' is not a directory.`, { field: 'location' })] }
		}
		if (index === segments.length - 1 && (!stat.isFile() || !requireFile)) {
			if (requireFile && !stat.isFile())
				return { diagnostics: [diagnostic('SPEC-RESOURCE-PATH', `Local Resource location '${location}' must be a regular file.`, { field: 'location' })] }
		}
	}
	if (requireFile) {
		try {
			await access(absolutePath, constants.R_OK)
		}
		catch (error) {
			return { diagnostics: [diagnostic('SPEC-RESOURCE-NOT-FOUND', `Local Resource path '${location}' is not readable: ${(error as Error).message}.`, { field: 'location' })] }
		}
	}
	return { absolutePath, diagnostics: [] }
}

function resourceFieldsValid(input: ResourceDescriptor): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	if (typeof input.location !== 'string' || input.location.trim() === '')
		diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource location must not be empty.', { field: 'location' }))
	if (typeof input.role !== 'string' || input.role.trim() === '')
		diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource role must not be empty.', { field: 'role' }))
	if (typeof input.mediaType !== 'string' || input.mediaType.trim() === '')
		diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource mediaType must not be empty.', { field: 'mediaType' }))
	if (typeof input.description !== 'string')
		diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', 'Resource description must be a string.', { field: 'description' }))
	return diagnostics
}

async function validateResourceLocation(root: string, ownerId: string, location: string): Promise<Diagnostic[]> {
	if (isHttpsLocation(location)) {
		try {
			const url = new URL(location)
			return url.protocol === 'https:' && url.hostname !== ''
				? []
				: [diagnostic('SPEC-RESOURCE-INVALID', 'External Resource locations must be valid https URLs.', { artifactId: ownerId, field: 'location' })]
		}
		catch {
			return [diagnostic('SPEC-RESOURCE-INVALID', 'External Resource locations must be valid https URLs.', { artifactId: ownerId, field: 'location' })]
		}
	}
	if (isOtherUrl(location))
		return [diagnostic('SPEC-RESOURCE-INVALID', 'Only \'https://\' external Resource locations are allowed.', { artifactId: ownerId, field: 'location' })]
	return (await validateLocalResourcePath(root, ownerId, location, true)).diagnostics
}

export async function validateResourceIntegrity(root: string, artifacts: readonly Artifact[]): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = []
	for (const artifact of artifacts) {
		const seen = new Set<string>()
		for (const resource of artifact.resources) {
			if (seen.has(resource.location))
				diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', `Artifact '${artifact.id}' contains duplicate Resource location '${resource.location}'.`, { path: pathFor(artifact), artifactId: artifact.id, field: 'resources' }))
			seen.add(resource.location)
			diagnostics.push(...resourceFieldsValid(resource)
				.map(item => ({ ...item, path: item.path ?? pathFor(artifact), artifactId: item.artifactId ?? artifact.id })))
			const locationDiagnostics = await validateResourceLocation(root, artifact.id, resource.location)
			diagnostics.push(...locationDiagnostics
				.map(item => ({ ...item, path: item.path ?? pathFor(artifact), artifactId: item.artifactId ?? artifact.id })))
		}
	}
	return aggregateDiagnostics(diagnostics)
}

export interface ResourceAddInput extends ResourceDescriptor {
	artifactId: string
}

export async function addResource(root: string, input: ResourceAddInput): Promise<MutationResult<ResourceDescriptor>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const context = contextResult.value
	const owner = artifactFromContext(context, input.artifactId)
	if (!owner)
		return failure([notFound(input.artifactId)])
	if (isTerminal(owner))
		return failure([immutable(owner)])
	const resource: ResourceDescriptor = { location: input.location, role: input.role, mediaType: input.mediaType, description: input.description }
	const diagnostics = resourceFieldsValid(resource)
	if (diagnostics.length > 0)
		return failure(diagnostics)
	if (owner.resources.some(existing => existing.location === resource.location))
		diagnostics.push(diagnostic('SPEC-RESOURCE-INVALID', `Resource location '${resource.location}' is already owned by Artifact '${owner.id}'.`, { artifactId: owner.id, field: 'resources' }))
	diagnostics.push(...await validateResourceLocation(root, owner.id, resource.location))
	if (diagnostics.length > 0)
		return failure(diagnostics)
	const candidate: Artifact = { ...owner, resources: [...owner.resources, resource], path: pathFor(owner) }
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(resource)
	}
	catch (error) {
		return ioFailure(error, pathFor(owner))
	}
}

export async function removeResource(root: string, artifactId: string, location: string): Promise<MutationResult<ResourceDescriptor>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const owner = artifactFromContext(contextResult.value, artifactId)
	if (!owner)
		return failure([notFound(artifactId)])
	if (isTerminal(owner))
		return failure([immutable(owner)])
	const resource = owner.resources.find(candidate => candidate.location === location)
	if (!resource)
		return failure([diagnostic('SPEC-RESOURCE-NOT-FOUND', `Artifact '${artifactId}' does not own Resource '${location}'.`, { artifactId, field: 'resources' })])
	const candidate: Artifact = { ...owner, resources: owner.resources.filter(item => item !== resource), path: pathFor(owner) }
	try {
		await writeArtifactFile(root, candidate, 'replace')
		return success(resource)
	}
	catch (error) {
		return ioFailure(error, pathFor(owner))
	}
}

export async function listResources(root: string, filters: ResourceListFilters = {}): Promise<MutationResult<Array<{ artifactId: string, resource: ResourceDescriptor }>>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	if (filters.artifactId !== undefined && !contextResult.value.artifacts.has(filters.artifactId))
		return failure([notFound(filters.artifactId)])
	const resources = [...contextResult.value.artifacts.values()]
		.filter(artifact => filters.artifactId === undefined || artifact.id === filters.artifactId)
		.flatMap(artifact => artifact.resources.map(resource => ({ artifactId: artifact.id, resource })))
		.sort((left, right) => compareBytewise(left.artifactId, right.artifactId) || compareBytewise(left.resource.location, right.resource.location))
	return success(resources, false)
}

export async function readResource(root: string, artifactId: string, location: string): Promise<MutationResult<ResourceReadValue>> {
	const contextResult = await loadMutationContext(root)
	if (!contextResult.ok || !contextResult.value)
		return failure(contextResult.diagnostics)
	const owner = artifactFromContext(contextResult.value, artifactId)
	if (!owner)
		return failure([notFound(artifactId)])
	const resource = owner.resources.find(candidate => candidate.location === location)
	if (!resource)
		return failure([diagnostic('SPEC-RESOURCE-NOT-FOUND', `Artifact '${artifactId}' does not own Resource '${location}'.`, { artifactId, field: 'resources' })])
	if (isHttpsLocation(location))
		return failure([diagnostic('SPEC-RESOURCE-REMOTE', 'Resource read never fetches https URLs; only local Resources can be read.', { artifactId, field: 'location' })])
	if (isOtherUrl(location))
		return failure([diagnostic('SPEC-RESOURCE-REMOTE', 'Resource read never fetches remote URLs; only local Resources can be read.', { artifactId, field: 'location' })])
	const local = await validateLocalResourcePath(root, owner.id, location, true)
	if (local.diagnostics.length > 0 || !local.absolutePath)
		return failure(local.diagnostics)
	try {
		const buffer = await readFile(local.absolutePath)
		const utf8 = buffer.toString('utf8')
		const byteSafeUtf8 = Buffer.from(utf8, 'utf8')
			.equals(buffer)
		return success({ artifactId, resource, content: byteSafeUtf8 ? utf8 : buffer.toString('base64'), encoding: byteSafeUtf8 ? 'utf8' : 'base64', bytes: buffer.byteLength }, false)
	}
	catch (error) {
		return ioFailure(error, location)
	}
}

export const supportedRelationTypes = RELATION_TYPES
export const supportedArtifactKinds = ARTIFACT_KINDS
export const supportedStatuses = ALLOWED_STATUSES
