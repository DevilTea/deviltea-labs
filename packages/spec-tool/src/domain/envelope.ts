import type { YAMLMap, Node as YamlNode } from 'yaml'
import type { Diagnostic } from './diagnostics'
import type { Artifact, ArtifactEnvelope, ArtifactKind } from './model'
import { isMap, isScalar, isSeq, stringify } from 'yaml'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { aggregateDiagnostics, diagnostic } from './diagnostics'
import { isUuidV7, validateUuidV7 } from './identity'
import { validateStatus } from './lifecycle'
import { isArtifactKind, SCHEMA_BY_KIND } from './model'
import { decodeRelations } from './relations'
import { decodeResources } from './resources'

export const ENVELOPE_FIELD_ORDER = ['schema', 'kind', 'id', 'title', 'status', 'relations', 'resources'] as const

export type LocateFn = (nodeOrOffset: YamlNode | number | null | undefined) => { line: number, column: number } | undefined

export interface DecodeEnvelopeInput {
	mapping: YAMLMap<unknown, unknown> | undefined
	locate?: LocateFn
}

export interface DecodeEnvelopeResult {
	envelope: ArtifactEnvelope | null
	diagnostics: Diagnostic[]
	candidateId?: string
	candidateKind?: string
}

function plainValue(node: unknown): unknown {
	if (isScalar(node))
		return node.value
	if (isSeq(node))
		return node.items.map(plainValue)
	if (isMap(node)) {
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const pair of node.items) {
			const key = isScalar(pair.key) ? pair.key.value : undefined
			if (typeof key === 'string')
				result[key] = plainValue(pair.value)
		}
		return result
	}
	return undefined
}

function valueAt(mapping: YAMLMap<unknown, unknown>, name: string): { node: unknown, value: unknown } | undefined {
	const pair = mapping.items.find(item => isScalar(item.key) && item.key.value === name)
	return pair ? { node: pair.value, value: plainValue(pair.value) } : undefined
}

function fieldLocation(input: DecodeEnvelopeInput, name: string): ReturnType<NonNullable<LocateFn>> | undefined {
	const pair = input.mapping?.items.find(item => isScalar(item.key) && item.key.value === name)
	return input.locate?.(pair?.value as YamlNode | undefined)
}

function requiredField(mapping: YAMLMap<unknown, unknown>, name: string, path: string, diagnostics: Diagnostic[]): { node: unknown, value: unknown } | undefined {
	const value = valueAt(mapping, name)
	if (!value)
		diagnostics.push(diagnostic('SPEC-ENVELOPE-INVALID', `Missing required envelope field '${name}'.`, { path, field: name }))
	return value
}

/** Decode exactly the common Spec envelope from a parsed frontmatter mapping. */
export function decodeEnvelope(input: DecodeEnvelopeInput, path = ''): DecodeEnvelopeResult {
	const diagnostics: Diagnostic[] = []
	const mapping = input.mapping
	if (!mapping)
		return { envelope: null, diagnostics: [diagnostic('SPEC-ENVELOPE-INVALID', 'Artifact frontmatter must be a mapping.', { path })] }

	const fields = new Set<string>()
	for (const pair of mapping.items) {
		const key = isScalar(pair.key) ? pair.key.value : undefined
		if (typeof key !== 'string') {
			diagnostics.push(diagnostic('SPEC-ENVELOPE-INVALID', 'Envelope field names must be strings.', { path }))
			continue
		}
		fields.add(key)
		if (!(ENVELOPE_FIELD_ORDER as readonly string[]).includes(key))
			diagnostics.push(diagnostic('SPEC-ENVELOPE-INVALID', `Unknown envelope field '${key}'.`, { path, field: key }))
	}

	const schema = requiredField(mapping, 'schema', path, diagnostics)?.value
	const kindValue = requiredField(mapping, 'kind', path, diagnostics)?.value
	const id = requiredField(mapping, 'id', path, diagnostics)?.value
	const title = requiredField(mapping, 'title', path, diagnostics)?.value
	const status = requiredField(mapping, 'status', path, diagnostics)?.value
	const relationsValue = requiredField(mapping, 'relations', path, diagnostics)?.value
	const resourcesValue = requiredField(mapping, 'resources', path, diagnostics)?.value

	const candidateId = typeof id === 'string' ? id : undefined
	const candidateKind = typeof kindValue === 'string' ? kindValue : undefined
	let kind: ArtifactKind | undefined
	if (!isArtifactKind(kindValue))
		diagnostics.push(diagnostic('SPEC-ENVELOPE-INVALID', `Unknown artifact kind ${JSON.stringify(kindValue)}.`, { path, field: 'kind' }))
	else
		kind = kindValue

	if (typeof schema !== 'string')
		diagnostics.push(diagnostic('SPEC-SCHEMA-INVALID', 'Envelope schema must be a string.', { path, field: 'schema', location: fieldLocation(input, 'schema') }))
	else if (kind && schema !== SCHEMA_BY_KIND[kind])
		diagnostics.push(diagnostic('SPEC-SCHEMA-INVALID', `Schema '${schema}' does not match kind '${kind}'; expected '${SCHEMA_BY_KIND[kind]}'.`, { path, field: 'schema', location: fieldLocation(input, 'schema') }))

	diagnostics.push(...validateUuidV7(id, path, 'id'))
	if (typeof title !== 'string' || title.trim() === '' || /[\r\n]/.test(title))
		diagnostics.push(diagnostic('SPEC-ENVELOPE-INVALID', 'Envelope title must be a non-empty single-line string.', { path, field: 'title' }))
	if (kind)
		diagnostics.push(...validateStatus(kind, status, path, candidateId))

	const relations = relationsValue === undefined ? { relations: [], diagnostics: [] } : decodeRelations(relationsValue, path ? `${path}.relations` : 'relations')
	const resources = resourcesValue === undefined ? { resources: [], diagnostics: [] } : decodeResources(resourcesValue, path ? `${path}.resources` : 'resources')
	diagnostics.push(...relations.diagnostics, ...resources.diagnostics)

	if (diagnostics.length > 0 || !kind || typeof schema !== 'string' || typeof id !== 'string' || typeof title !== 'string' || typeof status !== 'string')
		return { envelope: null, diagnostics: aggregateDiagnostics(diagnostics), candidateId, candidateKind }

	return {
		envelope: {
			schema,
			kind,
			id,
			title,
			status: status as ArtifactEnvelope['status'],
			relations: relations.relations,
			resources: resources.resources,
		},
		diagnostics: [],
		candidateId,
		candidateKind,
	}
}

/** Encode the exact seven-field frontmatter envelope in deterministic order. */
export function encodeEnvelope(envelope: ArtifactEnvelope): string {
	return stringify({
		schema: envelope.schema,
		kind: envelope.kind,
		id: envelope.id,
		title: envelope.title,
		status: envelope.status,
		relations: envelope.relations.map(({ type, target }) => ({ type, target })),
		resources: envelope.resources.map(({ location, role, mediaType, description }) => ({ location, role, mediaType, description })),
	}, { lineWidth: 0 })
}

export function encodeArtifact(artifact: Artifact): string {
	const body = artifact.body.replace(/[ \t\r\n]+$/, '')
	return `---\n${encodeEnvelope(artifact)}---\n${body}\n`
}

export interface DecodeArtifactResult {
	artifact: Artifact | null
	diagnostics: Diagnostic[]
	candidateId?: string
	candidateKind?: string
}

export function decodeArtifact(source: string, path: string): DecodeArtifactResult {
	const split = splitFrontmatter(source)
	if (!split.ok)
		return { artifact: null, diagnostics: [{ ...split.diagnostic, path }] }
	const document = parseFrontmatterDocument(split.frontmatterText, path, { startLine: 2 })
	if (document.diagnostics.length > 0)
		return { artifact: null, diagnostics: aggregateDiagnostics(document.diagnostics) }
	const decoded = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, path)
	if (!decoded.envelope)
		return { artifact: null, diagnostics: decoded.diagnostics, candidateId: decoded.candidateId, candidateKind: decoded.candidateKind }
	return {
		artifact: { ...decoded.envelope, body: split.bodyText, path },
		diagnostics: [],
		candidateId: decoded.candidateId,
		candidateKind: decoded.candidateKind,
	}
}

export function isCanonicalEnvelope(envelope: ArtifactEnvelope): boolean {
	return envelope.schema === SCHEMA_BY_KIND[envelope.kind] && isUuidV7(envelope.id)
}
