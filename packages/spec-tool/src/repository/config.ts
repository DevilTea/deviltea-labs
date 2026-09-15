import type { Node as YamlNode } from 'yaml'
import type { Diagnostic } from '../domain/diagnostics'
import type { Config } from '../domain/model'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, stringify } from 'yaml'
import { aggregateDiagnostics, diagnostic } from '../domain/diagnostics'
import { SPEC_CONFIG_SCHEMA } from '../domain/model'

export const CONFIG_PATH = '.spec/config.yaml'

export interface DecodeConfigResult {
	config: Config | null
	diagnostics: Diagnostic[]
}

const ALLOWED_TAGS = new Set([
	'tag:yaml.org,2002:map',
	'tag:yaml.org,2002:seq',
	'tag:yaml.org,2002:str',
	'tag:yaml.org,2002:int',
	'tag:yaml.org,2002:float',
	'tag:yaml.org,2002:bool',
	'tag:yaml.org,2002:null',
])

function scalarString(node: unknown): string | undefined {
	return isScalar(node) && typeof node.value === 'string' ? node.value : undefined
}

function locate(text: string, node: YamlNode | number): { line: number, column: number } {
	const offset = typeof node === 'number' ? node : node.range?.[0] ?? 0
	const before = text.slice(0, offset)
	const line = before.split(/\r\n|\r|\n/).length
	const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
	return { line, column: [...before.slice(lastBreak + 1)].length + 1 }
}

function scanStructure(node: YamlNode, text: string, path: string, diagnostics: Diagnostic[]): void {
	if (isAlias(node)) {
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', 'YAML aliases are not allowed in Spec configuration.', { path, location: locate(text, node) }))
		return
	}
	if (node.anchor || (node.tag && !ALLOWED_TAGS.has(node.tag)))
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', 'YAML anchors and custom tags are not allowed in Spec configuration.', { path, location: locate(text, node) }))
	if (isMap(node)) {
		const seen = new Set<string>()
		for (const pair of node.items) {
			const key = scalarString(pair.key)
			if (key === '<<')
				diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', 'YAML merge keys are not allowed in Spec configuration.', { path, field: key, location: locate(text, pair.key as YamlNode) }))
			if (key !== undefined && seen.has(key))
				diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', `Duplicate configuration field '${key}'.`, { path, field: key, location: locate(text, pair.key as YamlNode) }))
			if (key !== undefined)
				seen.add(key)
			if (isNode(pair.key))
				scanStructure(pair.key, text, path, diagnostics)
			if (isNode(pair.value))
				scanStructure(pair.value, text, path, diagnostics)
		}
	}
	else if (isSeq(node)) {
		for (const item of node.items) {
			if (isNode(item))
				scanStructure(item, text, path, diagnostics)
		}
	}
}

/** Decode the exact MVP configuration: one field, `schema: spec/config@1`. */
export function decodeConfig(yamlText: string, path = CONFIG_PATH): DecodeConfigResult {
	const diagnostics: Diagnostic[] = []
	const document = parseDocument(yamlText, { uniqueKeys: true, merge: false })
	for (const error of document.errors.filter(item => item.code !== 'DUPLICATE_KEY'))
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', `Configuration YAML could not be parsed: ${error.message}`, { path, location: locate(yamlText, error.pos[0]) }))
	const contents = document.contents
	if (contents === null || contents === undefined || !isMap(contents)) {
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', 'Configuration must be one top-level YAML mapping.', { path, location: locate(yamlText, 0) }))
		return { config: null, diagnostics: aggregateDiagnostics(diagnostics) }
	}
	scanStructure(contents, yamlText, path, diagnostics)
	const fields = new Map<string, unknown>()
	for (const pair of contents.items) {
		const key = scalarString(pair.key)
		if (key !== undefined && !fields.has(key))
			fields.set(key, pair.value)
	}
	if (!fields.has('schema'))
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', `Configuration must contain exactly 'schema: ${SPEC_CONFIG_SCHEMA}'.`, { path, field: 'schema' }))
	for (const key of fields.keys()) {
		if (key !== 'schema')
			diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', `Unknown configuration field '${key}'.`, { path, field: key }))
	}
	const schema = fields.get('schema')
	if (schema !== undefined && scalarString(schema) !== SPEC_CONFIG_SCHEMA)
		diagnostics.push(diagnostic('SPEC-CONFIG-INVALID', `Configuration schema must be exactly '${SPEC_CONFIG_SCHEMA}'.`, { path, field: 'schema' }))
	const result = aggregateDiagnostics(diagnostics)
	return result.length > 0 ? { config: null, diagnostics: result } : { config: { schema: SPEC_CONFIG_SCHEMA }, diagnostics: [] }
}

export function encodeConfig(config: Config = { schema: SPEC_CONFIG_SCHEMA }): string {
	return stringify({ schema: config.schema })
}
