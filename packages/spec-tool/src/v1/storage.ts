import type { ValidationIssue } from './types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isMap, parseDocument, stringify } from 'yaml'
import { isUuidV7 } from './identity'

export interface RuleData {
	id: string
	statement: string
}

export interface FeatureData {
	id: string
	title: string
	summary: string
	rules: RuleData[]
}

export interface ClauseData {
	id: string
	statement: string
	/** Absent means inherit Contract scope; an override is a complete, non-empty set. */
	constrains?: string[]
}

export interface ContractData {
	id: string
	title: string
	summary: string
	clauses: ClauseData[]
	constrains: string[]
}

export interface StoryData {
	id: string
	title: string
	actor: string
	goal: string
	value: string
	motivates: string[]
}

export interface Stored<T> {
	path: string
	value: T
	/** Everything after the closing frontmatter marker, including exact whitespace. */
	body: string
}

type ArtifactKind = 'feature' | 'story' | 'contract'
const FIELDS: Record<ArtifactKind, string[]> = {
	feature: ['id', 'title', 'summary', 'rules'],
	story: ['id', 'title', 'actor', 'goal', 'value', 'motivates'],
	contract: ['id', 'title', 'summary', 'clauses', 'constrains'],
}

export function addIssue(
	issues: ValidationIssue[],
	path: string,
	field: string,
	reason: ValidationIssue['reason'],
	message: string,
): void {
	issues.push({ source: { path }, path: field, reason, message })
}

export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function decodeFrontmatter(
	path: string,
	raw: string,
	kind: ArtifactKind,
	issues: ValidationIssue[],
): { fields: Record<string, unknown>, body: string } | null {
	if (!raw.startsWith('---\n')) {
		addIssue(issues, path, path, 'invalid_format', 'Markdown must begin with YAML frontmatter.')
		return null
	}
	const marker = /\n---(?=\n|$)/g
	marker.lastIndex = 4
	const match = marker.exec(raw)
	if (!match) {
		addIssue(issues, path, path, 'invalid_format', 'YAML frontmatter must have a closing marker.')
		return null
	}
	const document = parseDocument(raw.slice(4, match.index), { uniqueKeys: true })
	if (document.errors.length > 0 || !isMap(document.contents)) {
		addIssue(issues, path, path, 'invalid_format', 'Frontmatter must be a valid YAML mapping with unique keys.')
		return null
	}
	const keys = document.contents.items.map(pair => pair.key?.toJSON())
	const expected = FIELDS[kind]
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		addIssue(issues, path, path, 'invalid_format', 'Frontmatter must contain exactly the canonical fields in canonical order.')
	}
	let fields: unknown
	try {
		fields = document.toJS()
	}
	catch {
		addIssue(issues, path, path, 'invalid_format', 'Frontmatter contains an invalid YAML value.')
		return null
	}
	if (fields === null || typeof fields !== 'object' || Array.isArray(fields))
		return null
	return { fields: fields as Record<string, unknown>, body: raw.slice(match.index + 4) }
}

function requiredText(
	fields: Record<string, unknown>,
	field: string,
	path: string,
	issues: ValidationIssue[],
): string | null {
	const value = fields[field]
	if (value === undefined) {
		addIssue(issues, path, field, 'missing', 'Required field is missing.')
		return null
	}
	if (typeof value !== 'string') {
		addIssue(issues, path, field, 'invalid_format', 'Required field must be a string.')
		return null
	}
	if (!value.trim()) {
		addIssue(issues, path, field, 'empty', 'Required text cannot be empty.')
		return null
	}
	return value
}

function recordId(
	fields: Record<string, unknown>,
	filenameId: string,
	path: string,
	issues: ValidationIssue[],
): string | null {
	const id = fields.id
	if (!isUuidV7(id)) {
		addIssue(issues, path, 'id', 'invalid_format', 'Semantic ID must be a canonical lowercase UUIDv7.')
		return null
	}
	if (id !== filenameId)
		addIssue(issues, path, 'id', 'invariant', 'Filename stem must equal the semantic ID.')
	return id
}

export function decodeFeature(
	path: string,
	raw: string,
	filenameId: string,
	issues: ValidationIssue[],
): Stored<FeatureData> | null {
	const parsed = decodeFrontmatter(path, raw, 'feature', issues)
	if (!parsed)
		return null
	const { fields, body } = parsed
	const id = recordId(fields, filenameId, path, issues)
	const title = requiredText(fields, 'title', path, issues)
	const summary = requiredText(fields, 'summary', path, issues)
	const rules: RuleData[] = []
	if (!Array.isArray(fields.rules)) {
		addIssue(issues, path, 'rules', fields.rules === undefined ? 'missing' : 'invalid_format', 'Rules must be an array.')
	}
	else {
		for (const [index, item] of fields.rules.entries()) {
			const field = `rules[${index}]`
			if (item === null || typeof item !== 'object' || Array.isArray(item)
				|| Object.keys(item)
					.join(',') !== 'id,statement') {
				addIssue(issues, path, field, 'invalid_format', 'Rule must contain exactly id and statement in canonical order.')
				continue
			}
			const rule = item as Record<string, unknown>
			if (!isUuidV7(rule.id)) {
				addIssue(issues, path, `${field}.id`, 'invalid_format', 'Rule id must be canonical lowercase UUIDv7.')
			}
			if (typeof rule.statement !== 'string' || !rule.statement.trim()) {
				addIssue(issues, path, `${field}.statement`, 'empty', 'Rule statement must be non-empty text.')
			}
			if (isUuidV7(rule.id) && typeof rule.statement === 'string' && rule.statement.trim())
				rules.push({ id: rule.id, statement: rule.statement })
		}
	}
	if (!id || title === null || summary === null || !Array.isArray(fields.rules) || rules.length !== fields.rules.length)
		return null
	return { path, body, value: { id, title, summary, rules } }
}

function decodeTargets(
	value: unknown,
	path: string,
	field: string,
	issues: ValidationIssue[],
	optional = false,
): string[] | null {
	if (optional && value === undefined)
		return null
	if (!Array.isArray(value) || value.length === 0) {
		addIssue(issues, path, field, value === undefined ? 'missing' : Array.isArray(value) ? 'empty' : 'invalid_format', 'Targets must be a non-empty UUIDv7 array.')
		return null
	}
	const result: string[] = []
	const seen = new Set<string>()
	let valid = true
	for (const target of value) {
		if (!isUuidV7(target)) {
			addIssue(issues, path, field, 'invalid_format', 'Every target must be a canonical lowercase UUIDv7.')
			valid = false
		}
		else if (seen.has(target)) {
			addIssue(issues, path, field, 'duplicate', 'Relation targets must be unique.')
			valid = false
		}
		else {
			seen.add(target)
			result.push(target)
		}
	}
	if (result.some((id, index) => index > 0 && compareText(result[index - 1]!, id) >= 0)) {
		addIssue(issues, path, field, 'invariant', 'Relation targets must be sorted lexicographically.')
		valid = false
	}
	return valid ? result : null
}

export function decodeContract(
	path: string,
	raw: string,
	filenameId: string,
	issues: ValidationIssue[],
): Stored<ContractData> | null {
	const parsed = decodeFrontmatter(path, raw, 'contract', issues)
	if (!parsed)
		return null
	const { fields, body } = parsed
	const id = recordId(fields, filenameId, path, issues)
	const title = requiredText(fields, 'title', path, issues)
	const summary = requiredText(fields, 'summary', path, issues)
	const constrains = decodeTargets(fields.constrains, path, 'constrains', issues)
	const clauses: ClauseData[] = []
	if (!Array.isArray(fields.clauses)) {
		addIssue(issues, path, 'clauses', fields.clauses === undefined ? 'missing' : 'invalid_format', 'Clauses must be an array.')
	}
	else {
		for (const [index, item] of fields.clauses.entries()) {
			const field = `clauses[${index}]`
			if (item === null || typeof item !== 'object' || Array.isArray(item)) {
				addIssue(issues, path, field, 'invalid_format', 'Clause must be a YAML mapping.')
				continue
			}
			const keys = Object.keys(item)
			if (keys.join(',') !== 'id,statement' && keys.join(',') !== 'id,statement,constrains') {
				addIssue(issues, path, field, 'invalid_format', 'Clause keys must be id, statement, optional constrains in canonical order.')
				continue
			}
			const record = item as Record<string, unknown>
			let valid = true
			if (!isUuidV7(record.id)) {
				addIssue(issues, path, `${field}.id`, 'invalid_format', 'Clause ID must be a canonical lowercase UUIDv7.')
				valid = false
			}
			if (typeof record.statement !== 'string' || !record.statement.trim()) {
				addIssue(issues, path, `${field}.statement`, 'empty', 'Clause statement must be non-empty.')
				valid = false
			}
			const override = keys.length === 3
				? decodeTargets(record.constrains, path, `${field}.constrains`, issues)
				: undefined
			if (keys.length === 3 && override === null)
				valid = false
			if (valid) {
				clauses.push(override === undefined
					? { id: record.id as string, statement: record.statement as string }
					: { id: record.id as string, statement: record.statement as string, constrains: override! })
			}
		}
	}
	if (!id || title === null || summary === null || !constrains || !Array.isArray(fields.clauses)
		|| clauses.length !== fields.clauses.length) {
		return null
	}
	return { path, body, value: { id, title, summary, clauses, constrains } }
}

export function decodeStory(
	path: string,
	raw: string,
	filenameId: string,
	issues: ValidationIssue[],
): Stored<StoryData> | null {
	const parsed = decodeFrontmatter(path, raw, 'story', issues)
	if (!parsed)
		return null
	const { fields, body } = parsed
	const id = recordId(fields, filenameId, path, issues)
	const title = requiredText(fields, 'title', path, issues)
	const actor = requiredText(fields, 'actor', path, issues)
	const goal = requiredText(fields, 'goal', path, issues)
	const value = requiredText(fields, 'value', path, issues)
	const motivates = fields.motivates
	if (!Array.isArray(motivates) || motivates.length < 1) {
		addIssue(issues, path, 'motivates', !Array.isArray(motivates) ? 'invalid_format' : 'empty', 'A Story must motivate at least one Feature.')
	}
	else {
		const unique = new Set<string>()
		for (const target of motivates) {
			if (!isUuidV7(target))
				addIssue(issues, path, 'motivates', 'invalid_format', 'Every target must be a canonical lowercase UUIDv7.')
			else if (unique.has(target))
				addIssue(issues, path, 'motivates', 'duplicate', 'Relation targets must be unique.')
			else
				unique.add(target)
		}
		if (motivates.some((target, index) => index > 0 && typeof target === 'string' && typeof motivates[index - 1] === 'string' && compareText(motivates[index - 1], target) > 0))
			addIssue(issues, path, 'motivates', 'invariant', 'Relation targets must be sorted lexicographically.')
	}
	if (!id || title === null || actor === null || goal === null || value === null || !Array.isArray(motivates) || motivates.length < 1 || !motivates.every(isUuidV7))
		return null
	return { path, body, value: { id, title, actor, goal, value, motivates } }
}

export function encodeContract(contract: ContractData, body = '\n'): string {
	return `---\n${stringify({
		id: contract.id,
		title: contract.title,
		summary: contract.summary,
		clauses: contract.clauses.map((clause) => {
			const canonical = { id: clause.id, statement: clause.statement }
			return clause.constrains === undefined
				? canonical
				: { ...canonical, constrains: [...clause.constrains].sort(compareText) }
		}),
		constrains: [...contract.constrains].sort(compareText),
	})
		.trimEnd()}\n---${body}`
}

export function encodeFeature(feature: FeatureData, body = '\n'): string {
	return `---\n${stringify({
		id: feature.id,
		title: feature.title,
		summary: feature.summary,
		rules: feature.rules,
	})
		.trimEnd()}\n---${body}`
}

export function encodeStory(story: StoryData, body = '\n'): string {
	return `---\n${stringify({
		id: story.id,
		title: story.title,
		actor: story.actor,
		goal: story.goal,
		value: story.value,
		motivates: [...story.motivates].sort(compareText),
	})
		.trimEnd()}\n---${body}`
}

interface MutationJournal {
	root: string
	originals: Map<string, string | null>
	restoring: boolean
}

const mutationJournal = new AsyncLocalStorage<MutationJournal>()

async function rememberOriginal(root: string, relativePath: string): Promise<void> {
	const journal = mutationJournal.getStore()
	if (!journal || journal.restoring || journal.root !== resolve(root) || journal.originals.has(relativePath))
		return
	let original: string | null
	try {
		original = await readFile(join(root, relativePath), 'utf8')
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw error
		original = null
	}
	journal.originals.set(relativePath, original)
}

/**
 * Record exact pre-mutation bytes of touched semantic files and restore them
 * on any ordinary mutation/post-validation error while holding the write lock.
 * A process crash still requires external recovery; no cross-file disk commit
 * can be crash-atomic without a persistent transaction protocol.
 */
export async function withSemanticMutationJournal<T>(root: string, action: () => Promise<T>): Promise<T> {
	const journal: MutationJournal = {
		root: resolve(root),
		originals: new Map(),
		restoring: false,
	}
	return mutationJournal.run(journal, async () => {
		try {
			return await action()
		}
		catch (error) {
			journal.restoring = true
			const rollbackErrors: unknown[] = []
			for (const [path, original] of [...journal.originals].reverse()) {
				try {
					if (original === null)
						await rm(join(root, path), { force: true })
					else
						await writeSemanticFile(root, path, original)
				}
				catch (rollbackError) {
					rollbackErrors.push(rollbackError)
				}
			}
			if (rollbackErrors.length)
				throw new AggregateError([error, ...rollbackErrors], 'Semantic mutation failed and rollback was incomplete.')
			throw error
		}
	})
}

/** Stage outside .spec so a reader never encounters temporary illegal .spec entries. */
export async function writeSemanticFile(root: string, relativePath: string, content: string): Promise<void> {
	await rememberOriginal(root, relativePath)
	const destination = join(root, relativePath)
	await mkdir(dirname(destination), { recursive: true })
	const temporary = join(root, `.spec-write-${randomUUID()}`)
	await writeFile(temporary, content, { flag: 'wx' })
	try {
		await rename(temporary, destination)
	}
	finally {
		await rm(temporary, { force: true })
	}
}

/**
 * A multi-file semantic mutation stages every output before publishing, then
 * restores the exact prior bytes if a publication or post-write validation fails.
 * Must only run under the workspace write lock. Crash recovery remains external.
 */
export async function replaceSemanticFiles(
	root: string,
	writes: Array<{ path: string, content: string }>,
	verify: () => Promise<void>,
): Promise<void> {
	const stages: string[] = []
	for (const item of writes)
		await rememberOriginal(root, item.path)
	const originals = await Promise.all(writes.map(async item => readFile(join(root, item.path), 'utf8')))
	let published = 0
	try {
		for (const item of writes) {
			const temporary = join(root, `.spec-write-${randomUUID()}`)
			stages.push(temporary)
			await writeFile(temporary, item.content, { flag: 'wx' })
		}
		for (const [index, item] of writes.entries()) {
			await rename(stages[index]!, join(root, item.path))
			published++
		}
		await verify()
	}
	catch (error) {
		const rollbackErrors: unknown[] = []
		for (let index = published - 1; index >= 0; index--) {
			try {
				await writeSemanticFile(root, writes[index]!.path, originals[index]!)
			}
			catch (rollbackError) {
				rollbackErrors.push(rollbackError)
			}
		}
		if (rollbackErrors.length > 0)
			throw new AggregateError([error, ...rollbackErrors], 'Semantic mutation failed and rollback was incomplete.')
		throw error
	}
	finally {
		await Promise.all(stages.map(stage => rm(stage, { force: true })))
	}
}

export async function removeSemanticFile(root: string, relativePath: string): Promise<void> {
	await rememberOriginal(root, relativePath)
	await unlink(join(root, relativePath))
}

export async function readSemanticFile(root: string, relativePath: string): Promise<string> {
	return readFile(join(root, relativePath), 'utf8')
}

export async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		return await lstat(path)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return null
		throw error
	}
}
