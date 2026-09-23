import type { SpecErrorEnvelope } from './errors'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { SpecClient } from './client'
import { SpecError } from './errors'

export interface V1CliIO {
	cwd: string
	stdin?: string
}

export interface V1CliOutcome {
	exitCode: number
	stdout: string
	stderr: string
}

const RESOURCES = ['workspace', 'graph', 'story', 'feature', 'rule', 'scenario', 'contract', 'clause'] as const
const OPERATIONS: Record<string, readonly string[]> = {
	workspace: ['init', 'validate'],
	graph: ['export', 'get', 'list', 'incoming', 'outgoing', 'set-relation-targets'],
	story: ['create', 'update', 'delete'],
	feature: ['create', 'update', 'delete'],
	rule: ['create', 'update', 'delete', 'reparent', 'reorder'],
	scenario: ['create', 'update', 'delete'],
	contract: ['create', 'update', 'delete'],
	clause: ['create', 'update', 'delete', 'reparent', 'reorder'],
}

const HELP = [
	'Spec v1 — semantic specification workspace',
	'Usage: spec [--root <repository-root>] [--format json|human] <resource> <operation>',
	'Resources:',
	'  workspace init|validate',
	'  graph export|get|list|incoming|outgoing|set-relation-targets',
	'  story create|update|delete',
	'  feature create|update|delete',
	'  rule create|update|delete|reparent|reorder',
	'  scenario create|update|delete',
	'  contract create|update|delete',
	'  clause create|update|delete|reparent|reorder',
	'Requests: JSON object on stdin; output defaults to JSON.',
].join('\n')

function requestError(path: string, reason: 'missing' | 'unexpected' | 'conflict' | 'unsupported' | 'invalid_format', message: string): never {
	throw new SpecError('invalid_request', 'Invalid CLI request.', { issues: [{ path, reason, message }] })
}

interface ParsedArgs {
	root?: string
	format: 'json' | 'human'
	resource?: string
	operation?: string
	help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	let root: string | undefined
	let format: 'json' | 'human' = 'json'
	let help = false
	const positionals: string[] = []
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]!
		if (token === '--help' || token === '-h') {
			help = true
			continue
		}
		if (token === '--root' || token === '--format') {
			const next = argv[++index]
			if (!next || next.startsWith('--'))
				requestError(token, 'missing', `${token} requires a value.`)
			if (token === '--root')
				root = next
			else if (next === 'json' || next === 'human')
				format = next
			else
				requestError('format', 'unsupported', 'Supported formats are json and human.')
			continue
		}
		if (token.startsWith('--root=')) {
			root = token.slice('--root='.length)
			continue
		}
		if (token.startsWith('--format=')) {
			const value = token.slice('--format='.length)
			if (value !== 'json' && value !== 'human')
				requestError('format', 'unsupported', 'Supported formats are json and human.')
			format = value
			continue
		}
		if (token.startsWith('-'))
			requestError('argv', 'unexpected', `Unknown CLI option: ${token}`)
		positionals.push(token)
	}
	if (!help && positionals.length !== 2)
		requestError('argv', 'invalid_format', 'Exactly one resource and one operation are required.')
	return { root, format, resource: positionals[0], operation: positionals[1], help }
}

export function isV1Command(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index]!
		if (token === '--root' || token === '--format') {
			index++
			continue
		}
		if (token.startsWith('-'))
			continue
		return (RESOURCES as readonly string[]).includes(token)
	}
	return false
}

function repositoryRoot(args: ParsedArgs, io: V1CliIO): string {
	if (args.root !== undefined) {
		if (!args.root.trim())
			requestError('root', 'invalid_format', 'Root must be a non-empty path.')
		return resolve(io.cwd, args.root)
	}
	try {
		const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: io.cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.trim()
		if (!gitRoot)
			requestError('root', 'missing', 'Specify --root when outside a Git working tree.')
		return resolve(gitRoot)
	}
	catch {
		requestError('root', 'missing', 'Specify --root when outside a Git working tree.')
	}
}

function parseRequest(stdin?: string): Record<string, unknown> {
	if (!stdin?.trim())
		return {}
	try {
		const data: unknown = JSON.parse(stdin)
		if (data === null || typeof data !== 'object' || Array.isArray(data))
			requestError('stdin', 'invalid_format', 'JSON request must be an object.')
		return data as Record<string, unknown>
	}
	catch (error) {
		if (error instanceof SpecError)
			throw error
		requestError('stdin', 'invalid_format', 'stdin must contain valid JSON.')
	}
}

function requireEmpty(request: Record<string, unknown>): void {
	const keys = Object.keys(request)
	if (keys.length)
		requestError(keys[0]!, 'unexpected', 'This operation requires an empty JSON object.')
}

function prettyHuman(resource: string, operation: string, value: unknown): string {
	if (resource === 'workspace' && operation === 'validate') {
		const result = value as { valid: boolean, revision?: string, issues: Array<{ source: { path: string }, reason: string, message: string }> }
		return result.valid
			? `Workspace valid\nRevision: ${result.revision}`
			: `Workspace invalid\n${result.issues.map(issue => `${issue.source.path}: ${issue.reason}: ${issue.message}`)
				.join('\n')}`
	}
	if (value !== null && typeof value === 'object' && 'revision' in value) {
		const revision = String((value as { revision: unknown }).revision)
		return `Revision: ${revision}\n${JSON.stringify(value, null, 2)}`
	}
	return JSON.stringify(value, null, 2)
}

export async function runV1Cli(argv: readonly string[], io: V1CliIO): Promise<V1CliOutcome> {
	let format: 'json' | 'human' = 'json'
	try {
		const args = parseArgs(argv)
		format = args.format
		if (args.help)
			return { exitCode: 0, stdout: `${HELP}\n`, stderr: '' }
		const resource = args.resource!
		const operation = args.operation!
		if (!OPERATIONS[resource]?.includes(operation))
			requestError('argv', 'unsupported', `Unsupported v1 resource operation: ${resource} ${operation}`)
		const root = repositoryRoot(args, io)
		const request = parseRequest(io.stdin)
		const client = new SpecClient(root)
		let result: unknown
		switch (`${resource}/${operation}`) {
			case 'workspace/init':
				requireEmpty(request)
				result = await client.workspace.init()
				break
			case 'workspace/validate':
				requireEmpty(request)
				result = await client.workspace.validate()
				break
			case 'graph/export':
				requireEmpty(request)
				result = await client.graph.export()
				break
			case 'graph/get':
				result = await client.graph.get(request as { id: string })
				break
			case 'graph/list':
				result = await client.graph.list(request)
				break
			case 'graph/incoming':
				result = await client.graph.incoming(request as { id: string })
				break
			case 'graph/outgoing':
				result = await client.graph.outgoing(request as { id: string })
				break
			case 'graph/set-relation-targets':
				result = await client.graph.setRelationTargets(request as never)
				break
			case 'story/create':
				result = await client.story.create(request as never)
				break
			case 'story/update':
				result = await client.story.update(request as never)
				break
			case 'story/delete':
				result = await client.story.delete(request as never)
				break
			case 'feature/create':
				result = await client.feature.create(request as never)
				break
			case 'feature/update':
				result = await client.feature.update(request as never)
				break
			case 'feature/delete':
				result = await client.feature.delete(request as never)
				break
			case 'rule/create':
				result = await client.rule.create(request as never)
				break
			case 'rule/update':
				result = await client.rule.update(request as never)
				break
			case 'rule/delete':
				result = await client.rule.delete(request as never)
				break
			case 'rule/reparent':
				result = await client.rule.reparent(request as never)
				break
			case 'rule/reorder':
				result = await client.rule.reorder(request as never)
				break
			case 'scenario/create':
				result = await client.scenario.create(request as never)
				break
			case 'scenario/update':
				result = await client.scenario.update(request as never)
				break
			case 'scenario/delete':
				result = await client.scenario.delete(request as never)
				break
			case 'contract/create':
				result = await client.contract.create(request as never)
				break
			case 'contract/update':
				result = await client.contract.update(request as never)
				break
			case 'contract/delete':
				result = await client.contract.delete(request as never)
				break
			case 'clause/create':
				result = await client.clause.create(request as never)
				break
			case 'clause/update':
				result = await client.clause.update(request as never)
				break
			case 'clause/delete':
				result = await client.clause.delete(request as never)
				break
			case 'clause/reparent':
				result = await client.clause.reparent(request as never)
				break
			case 'clause/reorder':
				result = await client.clause.reorder(request as never)
				break
			default:
				requestError('argv', 'unsupported', 'Unsupported v1 operation.')
		}
		const output = format === 'human'
			? prettyHuman(resource, operation, result)
			: JSON.stringify(result)
		const valid = resource === 'workspace' && operation === 'validate'
			? (result as { valid: boolean }).valid
			: true
		return valid
			? { exitCode: 0, stdout: `${output}\n`, stderr: '' }
			: { exitCode: 1, stdout: '', stderr: `${output}\n` }
	}
	catch (error) {
		const payload: SpecErrorEnvelope = error instanceof SpecError
			? error.toJSON()
			: { code: 'validation_failed', message: 'Spec operation failed.', details: {} }
		const output = format === 'human'
			? `${payload.code}: ${payload.message}`
			: JSON.stringify(payload)
		return { exitCode: 1, stdout: '', stderr: `${output}\n` }
	}
}
