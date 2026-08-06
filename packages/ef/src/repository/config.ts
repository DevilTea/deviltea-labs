/**
 * `.engineering/ef.yaml` configuration decoding (11-filesystem-and-config.md
 * "Configuration Schema").
 *
 * This module parses raw YAML text directly (it does not reuse
 * `parsing/frontmatter.ts`, whose diagnostic codes are fixed to the
 * `EF-ENV-*` Artifact-envelope namespace; every configuration schema
 * violation here -- including duplicate keys, forbidden YAML constructs, and
 * malformed shape -- is reported as `EF-FS-001`, and non-canonical field or
 * descriptor ordering as `EF-FS-002`, per the owning specification) and
 * validates the exact `ef/config@1` schema: required top-level fields,
 * `repository.integration_ref` Git ref-format rules, `linked_repositories`
 * descriptor shape/vocabulary/uniqueness/non-overlap/ordering, and
 * `schemas.artifact_write_major`.
 *
 * `decodeConfig` returns a non-null `config` only when the document contains
 * zero error-severity diagnostics; canonical-ordering warnings alone do not
 * prevent construction, matching `EF-FS-002`'s warning severity.
 */

import type { Node as YamlNode } from 'yaml'
import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic, RelatedLocation, SourceLocation } from '../domain/diagnostics'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { compareBytewise } from '../domain/model'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LinkedRepositoryRole = 'implementation' | 'management' | 'other'

export interface LinkedRepositoryDescriptor {
	id: string
	path: string
	role: LinkedRepositoryRole
	required: boolean
}

export interface RepositoryConfig {
	/** Full local branch ref, e.g. `refs/heads/main`. */
	integrationRef: string
}

export interface SchemasConfig {
	artifactWriteMajor: number
}

export interface Config {
	schema: string
	repository: RepositoryConfig
	linkedRepositories: LinkedRepositoryDescriptor[]
	schemas: SchemasConfig
}

export interface DecodeConfigResult {
	config: Config | null
	diagnostics: Diagnostic[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_SCHEMA_ID = 'ef/config@1'
const TOP_FIELD_ORDER = ['schema', 'repository', 'linked_repositories', 'schemas'] as const
const REPOSITORY_FIELD_ORDER = ['integration_ref'] as const
const SCHEMAS_FIELD_ORDER = ['artifact_write_major'] as const
const LINKED_REPO_FIELD_ORDER = ['id', 'path', 'role', 'required'] as const
const LINKED_REPO_ROLES: ReadonlySet<string> = new Set(['implementation', 'management', 'other'])
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

const ALLOWED_TAGS = new Set([
	'tag:yaml.org,2002:map',
	'tag:yaml.org,2002:seq',
	'tag:yaml.org,2002:str',
	'tag:yaml.org,2002:int',
	'tag:yaml.org,2002:float',
	'tag:yaml.org,2002:bool',
	'tag:yaml.org,2002:null',
])

// ---------------------------------------------------------------------------
// Git branch-name validation (git-check-ref-format rules, applied to the
// branch-name component after the fixed `refs/heads/` prefix). Forbidden
// characters are matched by character code rather than a regex escape class,
// so no control-character escape sequence needs to be embedded in source.
// ---------------------------------------------------------------------------

const FORBIDDEN_REF_SYMBOLS = new Set([' ', '~', '^', ':', '?', '*', '[', String.fromCharCode(92)])

function hasForbiddenRefCharacter(name: string): boolean {
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)
		if (code <= 0x1F || code === 0x7F)
			return true
		if (FORBIDDEN_REF_SYMBOLS.has(name[i]!))
			return true
	}
	return false
}

/** Whether `name` is a valid Git branch name (the segment after `refs/heads/`). */
export function isValidGitBranchName(name: string): boolean {
	if (name.length === 0)
		return false
	if (name === '@')
		return false
	if (name.startsWith('/') || name.endsWith('/'))
		return false
	if (name.includes('//'))
		return false
	if (name.includes('..'))
		return false
	if (name.includes('@{'))
		return false
	if (name.endsWith('.'))
		return false
	if (hasForbiddenRefCharacter(name))
		return false

	const components = name.split('/')
	for (const component of components) {
		if (component.length === 0)
			return false
		if (component.startsWith('.'))
			return false
		if (component.endsWith('.lock'))
			return false
	}
	return true
}

/** Whether `ref` is a syntactically valid full local branch ref `refs/heads/<branch-name>`. */
export function isValidIntegrationRef(ref: string): boolean {
	const prefix = 'refs/heads/'
	if (!ref.startsWith(prefix))
		return false
	return isValidGitBranchName(ref.slice(prefix.length))
}

// ---------------------------------------------------------------------------
// Linked-repository path lexical rules
// ---------------------------------------------------------------------------

export type LinkedRepositoryPathViolation = 'empty' | 'absolute' | 'backslash' | 'colon' | 'tilde' | 'segment'

/** Classify a `linked_repositories[].path` value against the lexical rules in 11-filesystem-and-config.md. */
export function analyzeLinkedRepositoryPath(value: string): { valid: true, segments: string[] } | { valid: false, violation: LinkedRepositoryPathViolation } {
	if (value.length === 0)
		return { valid: false, violation: 'empty' }
	if (value.startsWith('/'))
		return { valid: false, violation: 'absolute' }
	if (value.includes(String.fromCharCode(92)))
		return { valid: false, violation: 'backslash' }
	if (value.includes(':'))
		return { valid: false, violation: 'colon' }

	const segments = value.split('/')
	for (const segment of segments) {
		if (segment.length === 0 || segment === '.' || segment === '..')
			return { valid: false, violation: 'segment' }
		if (segment.startsWith('~'))
			return { valid: false, violation: 'tilde' }
	}
	return { valid: true, segments }
}

/** Whether two lexically valid (segment-decomposed) paths overlap: one's segments are a prefix of the other's, including equality. */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
	const length = Math.min(a.length, b.length)
	for (let i = 0; i < length; i++) {
		if (a[i] !== b[i])
			return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

interface DiagnosticInit {
	path?: string
	field?: string
	location?: SourceLocation
	related?: RelatedLocation[]
}

function makeDiagnostic(code: DiagnosticCode, message: string, init: DiagnosticInit = {}): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: init.path,
		field: init.field,
		location: init.location,
		related: init.related ?? [],
	}
}

// ---------------------------------------------------------------------------
// Small YAML value helpers
// ---------------------------------------------------------------------------

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

function scalarNumberValue(node: unknown): number | undefined {
	if (isScalar(node) && typeof node.value === 'number')
		return node.value
	return undefined
}

interface SourceLine {
	content: string
	startOffset: number
	terminatorLength: number
}

function splitLines(source: string): SourceLine[] {
	const lines: SourceLine[] = []
	let pos = 0
	while (true) {
		const nlIndex = source.indexOf('\n', pos)
		if (nlIndex === -1) {
			lines.push({ content: source.slice(pos), startOffset: pos, terminatorLength: 0 })
			break
		}
		const hasCR = nlIndex > pos && source[nlIndex - 1] === '\r'
		const contentEnd = hasCR ? nlIndex - 1 : nlIndex
		lines.push({ content: source.slice(pos, contentEnd), startOffset: pos, terminatorLength: nlIndex + 1 - contentEnd })
		pos = nlIndex + 1
	}
	return lines
}

function scalarLength(text: string): number {
	let count = 0
	for (const _ of text) count++
	return count
}

function locateOffsetInText(text: string, offset: number): SourceLocation {
	const lines = splitLines(text)
	let line = 1
	let lineStart = 0
	for (let i = 0; i < lines.length; i++) {
		const current = lines[i]!
		const nextStart = current.startOffset + current.content.length + current.terminatorLength
		line = i + 1
		lineStart = current.startOffset
		if (offset < nextStart || i === lines.length - 1)
			break
	}
	const column = scalarLength(text.slice(lineStart, offset)) + 1
	return { line, column }
}

// ---------------------------------------------------------------------------
// Structural scan: forbidden constructs and duplicate keys -> EF-FS-001
// ---------------------------------------------------------------------------

function scanStructural(root: YamlNode, path: string, locate: (node: YamlNode | number) => SourceLocation): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	function checkNode(node: unknown, field: string | undefined): void {
		if (!isNode(node))
			return

		if (isAlias(node)) {
			diagnostics.push(makeDiagnostic('EF-FS-001', 'YAML alias is a forbidden construct in the configuration.', { path, field, location: locate(node) }))
			return
		}

		if (node.anchor) {
			diagnostics.push(makeDiagnostic('EF-FS-001', `YAML anchor '&${node.anchor}' is a forbidden construct in the configuration.`, { path, field, location: locate(node) }))
		}

		if (node.tag && !ALLOWED_TAGS.has(node.tag)) {
			diagnostics.push(makeDiagnostic('EF-FS-001', `YAML custom tag '${node.tag}' is a forbidden construct in the configuration.`, { path, field, location: locate(node) }))
		}

		if (isMap(node)) {
			const seen = new Map<string, SourceLocation>()
			for (const pair of node.items) {
				const keyText = scalarStringValue(pair.key)
				const childField = keyText !== undefined ? (field ? `${field}.${keyText}` : keyText) : field

				if (keyText === '<<') {
					diagnostics.push(makeDiagnostic('EF-FS-001', 'YAML merge key \'<<\' is a forbidden construct in the configuration.', { path, field: childField, location: locate(pair.key as YamlNode) }))
				}

				if (keyText !== undefined) {
					const priorLocation = seen.get(keyText)
					if (priorLocation) {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Duplicate mapping key '${keyText}'.`, {
							path,
							field: childField,
							location: locate(pair.key as YamlNode),
							related: [{ path, field: childField, location: priorLocation, message: `First occurrence of key '${keyText}'.` }],
						}))
					}
					else {
						seen.set(keyText, locate(pair.key as YamlNode))
					}
				}

				checkNode(pair.key, childField)
				checkNode(pair.value, childField)
			}
		}
		else if (isSeq(node)) {
			node.items.forEach((item, index) => checkNode(item, `${field ?? ''}[${index}]`))
		}
	}

	checkNode(root, undefined)
	return diagnostics
}

// ---------------------------------------------------------------------------
// decodeConfig
// ---------------------------------------------------------------------------

/**
 * Decode and validate `.engineering/ef.yaml` text against the exact
 * `ef/config@1` schema. `path` is the project-relative path used in reported
 * diagnostics (normally `.engineering/ef.yaml`).
 */
export function decodeConfig(yamlText: string, path: string): DecodeConfigResult {
	const diagnostics: Diagnostic[] = []

	const locate = (nodeOrOffset: YamlNode | number): SourceLocation => {
		const offset = typeof nodeOrOffset === 'number' ? nodeOrOffset : (nodeOrOffset.range?.[0] ?? 0)
		return locateOffsetInText(yamlText, offset)
	}

	const document = parseDocument(yamlText, { uniqueKeys: true, merge: false })

	const structuralErrors = document.errors.filter(error => error.code !== 'DUPLICATE_KEY')
	for (const error of structuralErrors) {
		diagnostics.push(makeDiagnostic('EF-FS-001', `Configuration YAML could not be parsed: ${error.message}`, { path, location: locate(error.pos[0]) }))
	}

	const contents = document.contents ?? undefined
	const mapping = contents !== undefined && isMap(contents) ? contents : undefined

	if (structuralErrors.length === 0 && !mapping) {
		diagnostics.push(makeDiagnostic('EF-FS-001', 'Configuration must contain exactly one top-level YAML mapping.', { path, location: contents !== undefined ? locate(contents as YamlNode) : locate(0) }))
	}

	if (contents !== undefined)
		diagnostics.push(...scanStructural(contents as YamlNode, path, locate))

	if (!mapping)
		return { config: null, diagnostics: aggregateDiagnostics(diagnostics) }

	// ---- Top-level fields --------------------------------------------------

	const topFields = new Map<string, { keyNode: unknown, valueNode: unknown }>()
	for (const pair of mapping.items) {
		const name = scalarStringValue(pair.key)
		if (name === undefined)
			continue
		topFields.set(name, { keyNode: pair.key, valueNode: pair.value })
	}

	for (const name of TOP_FIELD_ORDER) {
		if (!topFields.has(name))
			diagnostics.push(makeDiagnostic('EF-FS-001', `Missing required top-level field '${name}'.`, { path, field: name }))
	}

	for (const [name, entry] of topFields) {
		if (!(TOP_FIELD_ORDER as readonly string[]).includes(name))
			diagnostics.push(makeDiagnostic('EF-FS-001', `Unknown top-level field '${name}'.`, { path, field: name, location: locate(entry.keyNode as YamlNode) }))
	}

	const presentTopOrder = [...mapping.items.map(pair => scalarStringValue(pair.key))
		.filter((name): name is string => name !== undefined && (TOP_FIELD_ORDER as readonly string[]).includes(name))]
	const expectedTopOrder = TOP_FIELD_ORDER.filter(name => topFields.has(name))
	if (!sameOrder(presentTopOrder, expectedTopOrder))
		diagnostics.push(makeDiagnostic('EF-FS-002', 'Top-level configuration fields are not in canonical order: schema, repository, linked_repositories, schemas.', { path, location: locate(mapping as YamlNode) }))

	// ---- schema -------------------------------------------------------------

	let schema = ''
	const schemaEntry = topFields.get('schema')
	if (schemaEntry) {
		const raw = scalarStringValue(schemaEntry.valueNode)
		if (raw === CONFIG_SCHEMA_ID) {
			schema = raw
		}
		else {
			diagnostics.push(makeDiagnostic('EF-FS-001', `Field 'schema' must be exactly '${CONFIG_SCHEMA_ID}'.`, { path, field: 'schema', location: locate(schemaEntry.valueNode as YamlNode) }))
		}
	}

	// ---- repository -----------------------------------------------------

	let integrationRef = ''
	const repositoryEntry = topFields.get('repository')
	if (repositoryEntry) {
		if (!isMap(repositoryEntry.valueNode)) {
			diagnostics.push(makeDiagnostic('EF-FS-001', 'Field \'repository\' must be a mapping.', { path, field: 'repository', location: locate(repositoryEntry.valueNode as YamlNode) }))
		}
		else {
			const repoMap = repositoryEntry.valueNode
			const repoFields = new Map<string, unknown>()
			for (const pair of repoMap.items) {
				const name = scalarStringValue(pair.key)
				if (name !== undefined)
					repoFields.set(name, pair.value)
			}

			for (const name of REPOSITORY_FIELD_ORDER) {
				if (!repoFields.has(name))
					diagnostics.push(makeDiagnostic('EF-FS-001', `Missing required field 'repository.${name}'.`, { path, field: `repository.${name}` }))
			}
			for (const [name] of repoFields) {
				if (!(REPOSITORY_FIELD_ORDER as readonly string[]).includes(name)) {
					const keyNode = repoMap.items.find(pair => scalarStringValue(pair.key) === name)?.key
					diagnostics.push(makeDiagnostic('EF-FS-001', `Unknown field 'repository.${name}'.`, { path, field: `repository.${name}`, location: locate(keyNode as YamlNode) }))
				}
			}

			const presentRepoOrder = repoMap.items.map(pair => scalarStringValue(pair.key))
				.filter((name): name is string => name !== undefined && (REPOSITORY_FIELD_ORDER as readonly string[]).includes(name))
			const expectedRepoOrder = REPOSITORY_FIELD_ORDER.filter(name => repoFields.has(name))
			if (!sameOrder(presentRepoOrder, expectedRepoOrder))
				diagnostics.push(makeDiagnostic('EF-FS-002', 'Field \'repository\' fields are not in canonical order: integration_ref.', { path, field: 'repository', location: locate(repoMap as YamlNode) }))

			const refNode = repoFields.get('integration_ref')
			if (refNode !== undefined) {
				const raw = scalarStringValue(refNode)
				if (raw !== undefined && isValidIntegrationRef(raw)) {
					integrationRef = raw
				}
				else {
					diagnostics.push(makeDiagnostic('EF-FS-001', `Field 'repository.integration_ref' must be a syntactically valid full local branch ref of the form 'refs/heads/<branch-name>'.`, { path, field: 'repository.integration_ref', location: locate(refNode as YamlNode) }))
				}
			}
		}
	}

	// ---- linked_repositories -------------------------------------------------

	const linkedRepositories: LinkedRepositoryDescriptor[] = []
	const linkedRepositoriesEntry = topFields.get('linked_repositories')
	if (linkedRepositoriesEntry) {
		if (!isSeq(linkedRepositoriesEntry.valueNode)) {
			diagnostics.push(makeDiagnostic('EF-FS-001', 'Field \'linked_repositories\' must be an array.', { path, field: 'linked_repositories', location: locate(linkedRepositoriesEntry.valueNode as YamlNode) }))
		}
		else {
			const seq = linkedRepositoriesEntry.valueNode
			const seenIds = new Map<string, number>()
			const validEntries: { index: number, descriptor: LinkedRepositoryDescriptor, pathSegments: string[] }[] = []
			const rawIds: { index: number, id: string }[] = []

			seq.items.forEach((item, index) => {
				const entryField = `linked_repositories[${index}]`
				if (!isMap(item)) {
					diagnostics.push(makeDiagnostic('EF-FS-001', `${entryField} must be a mapping.`, { path, field: entryField, location: locate(item as YamlNode) }))
					return
				}

				const entryFields = new Map<string, unknown>()
				for (const pair of item.items) {
					const name = scalarStringValue(pair.key)
					if (name !== undefined)
						entryFields.set(name, pair.value)
				}

				for (const name of LINKED_REPO_FIELD_ORDER) {
					if (!entryFields.has(name))
						diagnostics.push(makeDiagnostic('EF-FS-001', `Missing required field '${entryField}.${name}'.`, { path, field: `${entryField}.${name}` }))
				}
				for (const [name] of entryFields) {
					if (!(LINKED_REPO_FIELD_ORDER as readonly string[]).includes(name)) {
						const keyNode = item.items.find(pair => scalarStringValue(pair.key) === name)?.key
						diagnostics.push(makeDiagnostic('EF-FS-001', `Unknown field '${entryField}.${name}'.`, { path, field: `${entryField}.${name}`, location: locate(keyNode as YamlNode) }))
					}
				}

				const presentEntryOrder = item.items.map(pair => scalarStringValue(pair.key))
					.filter((name): name is string => name !== undefined && (LINKED_REPO_FIELD_ORDER as readonly string[]).includes(name))
				const expectedEntryOrder = LINKED_REPO_FIELD_ORDER.filter(name => entryFields.has(name))
				if (!sameOrder(presentEntryOrder, expectedEntryOrder))
					diagnostics.push(makeDiagnostic('EF-FS-002', `${entryField} fields are not in canonical order: id, path, role, required.`, { path, field: entryField, location: locate(item as YamlNode) }))

				const idNode = entryFields.get('id')
				const pathNode = entryFields.get('path')
				const roleNode = entryFields.get('role')
				const requiredNode = entryFields.get('required')

				let id: string | undefined
				if (idNode !== undefined) {
					const raw = scalarStringValue(idNode)
					if (raw !== undefined && ID_PATTERN.test(raw)) {
						id = raw
						rawIds.push({ index, id: raw })
					}
					else {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Field '${entryField}.id' must match /^[a-z][a-z0-9-]*$/.`, { path, field: `${entryField}.id`, location: locate(idNode as YamlNode) }))
					}
				}

				let pathValue: string | undefined
				let pathSegments: string[] | undefined
				if (pathNode !== undefined) {
					const raw = scalarStringValue(pathNode)
					if (raw !== undefined) {
						const analysis = analyzeLinkedRepositoryPath(raw)
						if (analysis.valid) {
							pathValue = raw
							pathSegments = analysis.segments
						}
						else {
							diagnostics.push(makeDiagnostic('EF-FS-001', `Field '${entryField}.path' is not a valid project-root-relative path (${analysis.violation}).`, { path, field: `${entryField}.path`, location: locate(pathNode as YamlNode) }))
						}
					}
					else {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Field '${entryField}.path' must be a string.`, { path, field: `${entryField}.path`, location: locate(pathNode as YamlNode) }))
					}
				}

				let role: LinkedRepositoryRole | undefined
				if (roleNode !== undefined) {
					const raw = scalarStringValue(roleNode)
					if (raw !== undefined && LINKED_REPO_ROLES.has(raw)) {
						role = raw as LinkedRepositoryRole
					}
					else {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Field '${entryField}.role' must be one of: implementation, management, other.`, { path, field: `${entryField}.role`, location: locate(roleNode as YamlNode) }))
					}
				}

				let required: boolean | undefined
				if (requiredNode !== undefined) {
					const raw = scalarBooleanValue(requiredNode)
					if (raw !== undefined) {
						required = raw
					}
					else {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Field '${entryField}.required' must be a boolean.`, { path, field: `${entryField}.required`, location: locate(requiredNode as YamlNode) }))
					}
				}

				if (id !== undefined && pathValue !== undefined && pathSegments !== undefined && role !== undefined && required !== undefined) {
					validEntries.push({ index, descriptor: { id, path: pathValue, role, required }, pathSegments })
				}
			})

			// duplicate ids
			for (const { index, id } of rawIds) {
				const firstIndex = seenIds.get(id)
				if (firstIndex === undefined) {
					seenIds.set(id, index)
					continue
				}
				diagnostics.push(makeDiagnostic('EF-FS-001', `Duplicate linked repository id '${id}'.`, {
					path,
					field: `linked_repositories[${index}].id`,
					related: [{ path, field: `linked_repositories[${firstIndex}].id`, message: `First occurrence of id '${id}'.` }],
				}))
			}

			// overlap detection (pairwise, over lexically valid paths only)
			for (let i = 0; i < validEntries.length; i++) {
				for (let j = i + 1; j < validEntries.length; j++) {
					const a = validEntries[i]!
					const b = validEntries[j]!
					if (pathsOverlap(a.pathSegments, b.pathSegments)) {
						diagnostics.push(makeDiagnostic('EF-FS-001', `Linked repository paths '${a.descriptor.path}' and '${b.descriptor.path}' overlap.`, {
							path,
							field: `linked_repositories[${b.index}].path`,
							related: [{ path, field: `linked_repositories[${a.index}].path`, message: `Overlaps with path '${a.descriptor.path}'.` }],
						}))
					}
				}
			}

			// bytewise id sort order
			let sortViolation = false
			for (let i = 1; i < rawIds.length; i++) {
				if (compareBytewise(rawIds[i - 1]!.id, rawIds[i]!.id) > 0) {
					sortViolation = true
					break
				}
			}
			if (sortViolation)
				diagnostics.push(makeDiagnostic('EF-FS-002', 'linked_repositories descriptors are not sorted by id in bytewise lexicographic order.', { path, field: 'linked_repositories', location: locate(seq as YamlNode) }))

			if (validEntries.length === seq.items.length) {
				linkedRepositories.push(...validEntries
					.slice()
					.sort((x, y) => x.index - y.index)
					.map(entry => entry.descriptor))
			}
		}
	}

	// ---- schemas --------------------------------------------------------

	let artifactWriteMajor = 0
	const schemasEntry = topFields.get('schemas')
	if (schemasEntry) {
		if (!isMap(schemasEntry.valueNode)) {
			diagnostics.push(makeDiagnostic('EF-FS-001', 'Field \'schemas\' must be a mapping.', { path, field: 'schemas', location: locate(schemasEntry.valueNode as YamlNode) }))
		}
		else {
			const schemasMap = schemasEntry.valueNode
			const schemasFields = new Map<string, unknown>()
			for (const pair of schemasMap.items) {
				const name = scalarStringValue(pair.key)
				if (name !== undefined)
					schemasFields.set(name, pair.value)
			}

			for (const name of SCHEMAS_FIELD_ORDER) {
				if (!schemasFields.has(name))
					diagnostics.push(makeDiagnostic('EF-FS-001', `Missing required field 'schemas.${name}'.`, { path, field: `schemas.${name}` }))
			}
			for (const [name] of schemasFields) {
				if (!(SCHEMAS_FIELD_ORDER as readonly string[]).includes(name)) {
					const keyNode = schemasMap.items.find(pair => scalarStringValue(pair.key) === name)?.key
					diagnostics.push(makeDiagnostic('EF-FS-001', `Unknown field 'schemas.${name}'.`, { path, field: `schemas.${name}`, location: locate(keyNode as YamlNode) }))
				}
			}

			const presentSchemasOrder = schemasMap.items.map(pair => scalarStringValue(pair.key))
				.filter((name): name is string => name !== undefined && (SCHEMAS_FIELD_ORDER as readonly string[]).includes(name))
			const expectedSchemasOrder = SCHEMAS_FIELD_ORDER.filter(name => schemasFields.has(name))
			if (!sameOrder(presentSchemasOrder, expectedSchemasOrder))
				diagnostics.push(makeDiagnostic('EF-FS-002', 'Field \'schemas\' fields are not in canonical order: artifact_write_major.', { path, field: 'schemas', location: locate(schemasMap as YamlNode) }))

			const majorNode = schemasFields.get('artifact_write_major')
			if (majorNode !== undefined) {
				const raw = scalarNumberValue(majorNode)
				if (raw === 1) {
					artifactWriteMajor = 1
				}
				else {
					diagnostics.push(makeDiagnostic('EF-FS-001', 'Field \'schemas.artifact_write_major\' must be the integer 1.', { path, field: 'schemas.artifact_write_major', location: locate(majorNode as YamlNode) }))
				}
			}
		}
	}

	const aggregated = aggregateDiagnostics(diagnostics)
	const hasError = aggregated.some(d => d.severity === 'error')

	if (hasError)
		return { config: null, diagnostics: aggregated }

	return {
		config: {
			schema,
			repository: { integrationRef },
			linkedRepositories,
			schemas: { artifactWriteMajor },
		},
		diagnostics: aggregated,
	}
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}
