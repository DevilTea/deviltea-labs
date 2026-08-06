/**
 * Artifact envelope decoding and validation (01-artifact-envelope.md).
 *
 * Consumes the already-parsed top-level YAML mapping produced by the parsing
 * module (frontmatter boundary detection, structural YAML errors, duplicate
 * keys, and forbidden constructs are that module's responsibility and are not
 * re-checked here). This module owns:
 *
 * - required core field presence (EF-ENV-003);
 * - core field type and forbidden-empty-scalar checks (EF-ENV-004);
 * - unknown non-extension top-level fields (EF-ENV-006);
 * - extension field name and value shape (EF-ENV-007);
 * - schema identifier support (EF-ENV-008);
 * - schema/type correspondence (EF-ENV-009);
 * - canonical field and extension ordering (EF-ENV-011, warning);
 * - tag syntax and uniqueness (EF-ENV-012);
 * - tag bytewise ordering (EF-ENV-013, warning).
 *
 * Relation and resource entries are decoded into raw `RelationEntry` /
 * `ResourceDescriptor` shapes without semantic validation of their contents;
 * only the envelope-level "every entry must be a mapping" rule is enforced
 * here (EF-ENV-004). Deeper relation and resource rules belong to the
 * EF-REL-* and EF-RES-* namespaces owned by other modules.
 */

import type { YAMLMap, Node as YamlNode } from 'yaml'
import type { DiagnosticCode } from './diagnostic-codes'
import type { Diagnostic, RelatedLocation, SourceLocation } from './diagnostics'
import type { ArtifactType, Envelope, RelationEntry, RelationType, ResourceDescriptor, Status } from './model'
import { isMap, isScalar, isSeq } from 'yaml'
import { severityOf } from './diagnostic-codes'
import { ARTIFACT_TYPES, compareBytewise, ENVELOPE_FIELD_ORDER, SCHEMA_BY_TYPE } from './model'

// ---------------------------------------------------------------------------
// Input / output contract
// ---------------------------------------------------------------------------

/**
 * Resolves a parsed YAML node (or a raw character offset) to a stable
 * one-based line/Unicode-scalar-column source location. Matches the shape of
 * `parseFrontmatterDocument(...).locate` from the parsing module, without
 * this module depending on it. Optional: when omitted, every diagnostic's
 * `location` is left `undefined`.
 */
export type LocateFn = (nodeOrOffset: YamlNode | number | null | undefined) => SourceLocation | undefined

export interface DecodeEnvelopeInput {
	/**
	 * The top-level YAML mapping, or `undefined` when frontmatter YAML
	 * structure already failed upstream (EF-ENV-002/005/010). Per the
	 * validation pipeline's cascading rule, a structural parse failure
	 * suppresses speculative envelope findings, so `decodeEnvelope` returns an
	 * empty diagnostic list and a `null` envelope in that case.
	 */
	mapping: YAMLMap<unknown, unknown> | undefined
	locate?: LocateFn
}

export interface DecodeEnvelopeResult {
	envelope: Envelope | null
	diagnostics: Diagnostic[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORE_FIELD_NAMES: readonly string[] = ENVELOPE_FIELD_ORDER
const EXTENSION_NAME_PATTERN = /^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/
const TAG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const SCHEMA_IDENTIFIERS: ReadonlySet<string> = new Set(Object.values(SCHEMA_BY_TYPE))

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: {
		path?: string
		field?: string
		location?: SourceLocation
		related?: RelatedLocation[]
	} = {},
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		field: options.field,
		location: options.location,
		related: options.related ?? [],
	}
}

function scalarStringValue(node: unknown): string | undefined {
	if (isScalar(node) && typeof node.value === 'string')
		return node.value
	return undefined
}

function scalarBooleanValue(node: unknown): boolean | undefined {
	if (isScalar(node) && typeof node.value === 'boolean')
		return node.value
	return undefined
}

function joinField(base: string, key: string): string {
	return `${base}.${key}`
}

function isSingleLineNonEmpty(value: string): boolean {
	return value.length > 0 && !/[\r\n]/.test(value)
}

function isTrimmedSingleLineNonEmpty(value: string): boolean {
	const trimmed = value.trim()
	return trimmed.length > 0 && !/[\r\n]/.test(trimmed)
}

function isTrimmedNonEmpty(value: string): boolean {
	return value.trim().length > 0
}

/**
 * Converts a parsed YAML node to a plain JS value, preserving non-finite
 * numbers (`NaN`/`Infinity`/`-Infinity`) verbatim rather than laundering them
 * to `null` the way `Node#toJSON()` does, so EF-ENV-007 can detect and report
 * them while extension values are still preserved for tooling that does not
 * understand them.
 */
function nodeToPlainValue(node: unknown): unknown {
	if (isScalar(node))
		return node.value
	if (isSeq(node))
		return node.items.map(nodeToPlainValue)
	if (isMap(node)) {
		const result: Record<string, unknown> = {}
		for (const pair of node.items) {
			const key = scalarStringValue(pair.key) ?? String(isScalar(pair.key) ? pair.key.value : '')
			result[key] = nodeToPlainValue(pair.value)
		}
		return result
	}
	return null
}

// ---------------------------------------------------------------------------
// Field collection (last-value-wins, first-insertion-order; EF-ENV-005
// duplicate-key detection itself is owned upstream by the parsing module)
// ---------------------------------------------------------------------------

interface FieldEntry {
	keyNode: unknown
	valueNode: unknown
}

function collectFields(mapping: YAMLMap<unknown, unknown>): Map<string, FieldEntry> {
	const fields = new Map<string, FieldEntry>()
	for (const pair of mapping.items) {
		const name = scalarStringValue(pair.key)
		if (name === undefined)
			continue
		fields.set(name, { keyNode: pair.key, valueNode: pair.value })
	}
	return fields
}

// ---------------------------------------------------------------------------
// Extension value shape (EF-ENV-007)
// ---------------------------------------------------------------------------

function validateExtensionValueShape(
	node: unknown,
	fieldPath: string,
	path: string,
	locate: LocateFn,
	diagnostics: Diagnostic[],
): void {
	if (isScalar(node)) {
		if (typeof node.value === 'number' && !Number.isFinite(node.value)) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-007',
				`Extension field '${fieldPath}' has a non-finite numeric value; numbers must be finite.`,
				{ path, field: fieldPath, location: locate(node as YamlNode) },
			))
		}
		return
	}

	if (isSeq(node)) {
		node.items.forEach((item, index) => validateExtensionValueShape(item, `${fieldPath}[${index}]`, path, locate, diagnostics))
		return
	}

	if (isMap(node)) {
		for (const pair of node.items) {
			const keyText = scalarStringValue(pair.key)
			if (keyText === undefined) {
				diagnostics.push(makeDiagnostic(
					'EF-ENV-007',
					`Extension field '${fieldPath}' has a mapping key that is not a string.`,
					{ path, field: fieldPath, location: locate(node as YamlNode) },
				))
				continue
			}
			validateExtensionValueShape(pair.value, joinField(fieldPath, keyText), path, locate, diagnostics)
		}
	}
}

// ---------------------------------------------------------------------------
// Relation / resource raw decoding (no semantic validation; EF-REL-*/EF-RES-*
// territory)
// ---------------------------------------------------------------------------

const RELATION_KNOWN_FIELDS = new Set(['type', 'target'])

function decodeRelationEntry(map: YAMLMap<unknown, unknown>): RelationEntry {
	let type = ''
	let target = ''
	const extensions: Record<string, unknown> = {}

	for (const pair of map.items) {
		const name = scalarStringValue(pair.key)
		if (name === undefined)
			continue
		if (name === 'type') {
			type = scalarStringValue(pair.value) ?? type
			continue
		}
		if (name === 'target') {
			target = scalarStringValue(pair.value) ?? target
			continue
		}
		if (!RELATION_KNOWN_FIELDS.has(name))
			extensions[name] = nodeToPlainValue(pair.value)
	}

	return { type: type as RelationType, target, extensions }
}

const RESOURCE_KNOWN_FIELDS = new Set(['type', 'location', 'role', 'media_type', 'normative', 'description'])

function decodeResourceEntry(map: YAMLMap<unknown, unknown>): ResourceDescriptor {
	let type = ''
	let location = ''
	let role = ''
	let mediaType = ''
	let normative = false
	let description = ''
	const extensions: Record<string, unknown> = {}

	for (const pair of map.items) {
		const name = scalarStringValue(pair.key)
		if (name === undefined)
			continue
		switch (name) {
			case 'type':
				type = scalarStringValue(pair.value) ?? type
				break
			case 'location':
				location = scalarStringValue(pair.value) ?? location
				break
			case 'role':
				role = scalarStringValue(pair.value) ?? role
				break
			case 'media_type':
				mediaType = scalarStringValue(pair.value) ?? mediaType
				break
			case 'normative':
				normative = scalarBooleanValue(pair.value) ?? normative
				break
			case 'description':
				description = scalarStringValue(pair.value) ?? description
				break
			default:
				if (!RESOURCE_KNOWN_FIELDS.has(name))
					extensions[name] = nodeToPlainValue(pair.value)
		}
	}

	return { type, location, role, mediaType, normative, description, extensions }
}

// ---------------------------------------------------------------------------
// decodeEnvelope
// ---------------------------------------------------------------------------

export function decodeEnvelope(input: DecodeEnvelopeInput, path: string): DecodeEnvelopeResult {
	const { mapping } = input
	const locate: LocateFn = input.locate ?? (() => undefined)

	if (!mapping)
		return { envelope: null, diagnostics: [] }

	const diagnostics: Diagnostic[] = []
	const fields = collectFields(mapping)

	// ---- Unknown / extension field classification -------------------------

	const extensionEntries: { name: string, keyNode: unknown, valueNode: unknown }[] = []

	for (const [name, entry] of fields) {
		if (CORE_FIELD_NAMES.includes(name))
			continue

		if (EXTENSION_NAME_PATTERN.test(name)) {
			extensionEntries.push({ name, ...entry })
			continue
		}

		if (name.startsWith('x-')) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-007',
				`Extension field '${name}' does not contain both a namespace and a field name.`,
				{ path, field: name, location: locate(entry.keyNode as YamlNode) },
			))
			continue
		}

		diagnostics.push(makeDiagnostic(
			'EF-ENV-006',
			`Unknown top-level field '${name}'; extension fields must begin with a valid namespace.`,
			{ path, field: name, location: locate(entry.keyNode as YamlNode) },
		))
	}

	// ---- Required presence (EF-ENV-003) ------------------------------------

	for (const name of ENVELOPE_FIELD_ORDER) {
		if (!fields.has(name)) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-003',
				`Missing required core field '${name}'.`,
				{ path, field: name },
			))
		}
	}

	// ---- Core scalar fields (EF-ENV-004) -----------------------------------

	let schema: string | null = null
	let type: ArtifactType | null = null
	let id: string | null = null
	let title: string | null = null
	let status: string | null = null
	let summary: string | null = null

	const schemaEntry = fields.get('schema')
	if (schemaEntry) {
		const raw = scalarStringValue(schemaEntry.valueNode)
		if (raw !== undefined && isSingleLineNonEmpty(raw)) {
			schema = raw
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'schema\' must be a non-empty single-line string.',
				{ path, field: 'schema', location: locate(schemaEntry.valueNode as YamlNode) },
			))
		}
	}

	const typeEntry = fields.get('type')
	if (typeEntry) {
		const raw = scalarStringValue(typeEntry.valueNode)
		if (raw !== undefined && isSingleLineNonEmpty(raw) && (ARTIFACT_TYPES as readonly string[]).includes(raw)) {
			type = raw as ArtifactType
		}
		else if (raw !== undefined && isSingleLineNonEmpty(raw)) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				`Field 'type' must be one of: ${ARTIFACT_TYPES.join(', ')}.`,
				{ path, field: 'type', location: locate(typeEntry.valueNode as YamlNode) },
			))
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'type\' must be a non-empty single-line string.',
				{ path, field: 'type', location: locate(typeEntry.valueNode as YamlNode) },
			))
		}
	}

	const idEntry = fields.get('id')
	if (idEntry) {
		const raw = scalarStringValue(idEntry.valueNode)
		if (raw !== undefined && isSingleLineNonEmpty(raw)) {
			id = raw
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'id\' must be a non-empty single-line string.',
				{ path, field: 'id', location: locate(idEntry.valueNode as YamlNode) },
			))
		}
	}

	const titleEntry = fields.get('title')
	if (titleEntry) {
		const raw = scalarStringValue(titleEntry.valueNode)
		if (raw !== undefined && isTrimmedSingleLineNonEmpty(raw)) {
			title = raw
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'title\' must be a non-empty single-line string after trimming surrounding whitespace.',
				{ path, field: 'title', location: locate(titleEntry.valueNode as YamlNode) },
			))
		}
	}

	const statusEntry = fields.get('status')
	if (statusEntry) {
		const raw = scalarStringValue(statusEntry.valueNode)
		if (raw !== undefined && isSingleLineNonEmpty(raw)) {
			status = raw
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'status\' must be a non-empty single-line string.',
				{ path, field: 'status', location: locate(statusEntry.valueNode as YamlNode) },
			))
		}
	}

	const summaryEntry = fields.get('summary')
	if (summaryEntry) {
		const raw = scalarStringValue(summaryEntry.valueNode)
		if (raw !== undefined && isTrimmedNonEmpty(raw)) {
			summary = raw
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'summary\' must be a non-empty string after trimming surrounding whitespace.',
				{ path, field: 'summary', location: locate(summaryEntry.valueNode as YamlNode) },
			))
		}
	}

	// ---- Schema identifier support (EF-ENV-008) ----------------------------

	let schemaSupported = false
	if (schema !== null) {
		schemaSupported = SCHEMA_IDENTIFIERS.has(schema)
		if (!schemaSupported) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-008',
				`Unsupported schema identifier '${schema}'.`,
				{ path, field: 'schema', location: locate(schemaEntry!.valueNode as YamlNode) },
			))
		}
	}

	// ---- Schema/type correspondence (EF-ENV-009) ---------------------------

	if (schema !== null && schemaSupported && type !== null) {
		const expected = SCHEMA_BY_TYPE[type]
		if (expected !== schema) {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-009',
				`Schema '${schema}' does not correspond to type '${type}'; expected '${expected}'.`,
				{ path, field: 'schema', location: locate(schemaEntry!.valueNode as YamlNode) },
			))
		}
	}

	// ---- tags (EF-ENV-004 shape / EF-ENV-012 content / EF-ENV-013 order) ---

	let tags: string[] | null = null
	const tagsEntry = fields.get('tags')
	if (tagsEntry) {
		if (isSeq(tagsEntry.valueNode)) {
			const collected: string[] = []
			const seen = new Map<string, { field: string, location: SourceLocation | undefined }>()
			let allStrings = true

			tagsEntry.valueNode.items.forEach((item, index) => {
				const fieldPath = `tags[${index}]`
				const location = locate(item as YamlNode)
				const raw = scalarStringValue(item)

				if (raw === undefined) {
					allStrings = false
					diagnostics.push(makeDiagnostic(
						'EF-ENV-012',
						`Tag entry '${fieldPath}' must be a string.`,
						{ path, field: fieldPath, location },
					))
					return
				}

				collected.push(raw)

				if (!TAG_PATTERN.test(raw)) {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-012',
						`Invalid tag '${raw}'; tags must match ^[a-z0-9]+(?:[._-][a-z0-9]+)*$.`,
						{ path, field: fieldPath, location },
					))
				}

				const prior = seen.get(raw)
				if (prior) {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-012',
						`Duplicate tag '${raw}'.`,
						{
							path,
							field: fieldPath,
							location,
							related: [{
								path,
								field: prior.field,
								location: prior.location,
								message: `First occurrence of tag '${raw}'.`,
							}],
						},
					))
				}
				else {
					seen.set(raw, { field: fieldPath, location })
				}
			})

			tags = collected

			if (allStrings && collected.length > 1) {
				let ordered = true
				for (let i = 1; i < collected.length; i++) {
					if (compareBytewise(collected[i - 1]!, collected[i]!) > 0) {
						ordered = false
						break
					}
				}
				if (!ordered) {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-013',
						'Tags are not in bytewise lexicographic order.',
						{ path, field: 'tags', location: locate(tagsEntry.valueNode as YamlNode) },
					))
				}
			}
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'tags\' must be an array of strings.',
				{ path, field: 'tags', location: locate(tagsEntry.valueNode as YamlNode) },
			))
		}
	}

	// ---- relations (EF-ENV-004 shape; entries decoded raw) -----------------

	let relations: RelationEntry[] | null = null
	const relationsEntry = fields.get('relations')
	if (relationsEntry) {
		if (isSeq(relationsEntry.valueNode)) {
			const collected: RelationEntry[] = []
			relationsEntry.valueNode.items.forEach((item, index) => {
				if (!isMap(item)) {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-004',
						`Field 'relations[${index}]' must be a mapping.`,
						{ path, field: `relations[${index}]`, location: locate(item as YamlNode) },
					))
					return
				}
				collected.push(decodeRelationEntry(item))
			})
			relations = collected
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'relations\' must be an array of mappings.',
				{ path, field: 'relations', location: locate(relationsEntry.valueNode as YamlNode) },
			))
		}
	}

	// ---- resources (EF-ENV-004 shape; entries decoded raw) -----------------

	let resources: ResourceDescriptor[] | null = null
	const resourcesEntry = fields.get('resources')
	if (resourcesEntry) {
		if (isSeq(resourcesEntry.valueNode)) {
			const collected: ResourceDescriptor[] = []
			resourcesEntry.valueNode.items.forEach((item, index) => {
				if (!isMap(item)) {
					diagnostics.push(makeDiagnostic(
						'EF-ENV-004',
						`Field 'resources[${index}]' must be a mapping.`,
						{ path, field: `resources[${index}]`, location: locate(item as YamlNode) },
					))
					return
				}
				collected.push(decodeResourceEntry(item))
			})
			resources = collected
		}
		else {
			diagnostics.push(makeDiagnostic(
				'EF-ENV-004',
				'Field \'resources\' must be an array of mappings.',
				{ path, field: 'resources', location: locate(resourcesEntry.valueNode as YamlNode) },
			))
		}
	}

	// ---- Extension value shape (EF-ENV-007) and collection -----------------

	const extensions: Record<string, unknown> = {}
	for (const { name, valueNode } of extensionEntries) {
		validateExtensionValueShape(valueNode, name, path, locate, diagnostics)
		extensions[name] = nodeToPlainValue(valueNode)
	}

	// ---- Canonical field / extension ordering (EF-ENV-011, warning) -------

	const recognizedOrder: string[] = []
	for (const name of fields.keys()) {
		if (CORE_FIELD_NAMES.includes(name) || EXTENSION_NAME_PATTERN.test(name))
			recognizedOrder.push(name)
	}
	const expectedOrder = [
		...ENVELOPE_FIELD_ORDER.filter(name => fields.has(name)),
		...extensionEntries.map(entry => entry.name)
			.sort(compareBytewise),
	]
	const isCanonicalOrder = recognizedOrder.length === expectedOrder.length
		&& recognizedOrder.every((name, index) => name === expectedOrder[index])
	if (!isCanonicalOrder) {
		diagnostics.push(makeDiagnostic(
			'EF-ENV-011',
			'Envelope fields are not in canonical order: schema, type, id, title, status, summary, tags, relations, resources, then extensions sorted by name.',
			{ path, location: locate(mapping as YamlNode) },
		))
	}

	// ---- Assemble result ----------------------------------------------------

	if (schema === null || type === null || id === null || title === null || status === null
		|| summary === null || tags === null || relations === null || resources === null) {
		return { envelope: null, diagnostics }
	}

	return {
		envelope: {
			schema,
			type,
			id,
			title,
			status: status as Status,
			summary,
			tags,
			relations,
			resources,
			extensions,
		},
		diagnostics,
	}
}
