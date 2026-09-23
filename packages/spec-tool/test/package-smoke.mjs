#!/usr/bin/env node

/* Packed-consumer smoke test for the frozen v1 CLI and TypeScript library. */

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageTool = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmTool = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'deviltea-spec-v1-consumer-'))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '..', '..')
const results = []

function check(name, condition, detail = '') {
	results.push({ name, ok: Boolean(condition), detail: condition ? '' : String(detail) })
}

function run(command, args, cwd, options = {}) {
	return spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: process.env,
		maxBuffer: 10 * 1024 * 1024,
		shell: options.shell ?? false,
		input: options.input,
		timeout: options.timeout ?? 30000,
	})
}

function setup(command, args, cwd) {
	const result = run(command, args, cwd, { shell: process.platform === 'win32', timeout: 120000 })
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
}

function runInstalledBin(binary, args, cwd) {
	if (process.platform !== 'win32')
		return run(binary, args, cwd)
	const quote = value => `'${value.replaceAll('\'', '\'\'')}'`
	const command = `& ${[binary, ...args].map(quote)
		.join(' ')}`
	return run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], cwd)
}

async function main() {
	try {
		const supplied = process.env.SPEC_SMOKE_TARBALL
		let tarball
		if (supplied) {
			if (!isAbsolute(supplied) || !existsSync(supplied))
				throw new Error('SPEC_SMOKE_TARBALL must be an existing absolute path')
			tarball = supplied
		}
		else {
			setup(packageTool, ['pack', '--pack-destination', temporaryDirectory], packageRoot)
			const name = readdirSync(temporaryDirectory)
				.find(item => item.endsWith('.tgz'))
			if (!name)
				throw new Error('pnpm pack did not produce a tarball')
			tarball = join(temporaryDirectory, name)
		}
		const consumer = join(temporaryDirectory, 'consumer')
		mkdirSync(consumer)
		setup(npmTool, ['init', '--yes'], consumer)
		setup(npmTool, ['install', tarball], consumer)
		const installed = join(consumer, 'node_modules', '@deviltea', 'spec-tool')
		const binary = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'spec.cmd' : 'spec')
		const cliEntry = join(installed, 'dist', 'cli.mjs')
		const indexEntry = join(installed, 'dist', 'index.mjs')
		const installedSkills = join(installed, 'skills')
		const sourceSkills = join(packageRoot, 'skills')
		const repositorySkills = join(repositoryRoot, 'skills')

		check('packed binary exists', existsSync(binary))
		check('packed CLI entry exists', existsSync(cliEntry))
		check('packed TypeScript library entry exists', existsSync(indexEntry))
		check('packed maintain skill exists', existsSync(join(installedSkills, 'maintain-spec-workspace', 'SKILL.md')))
		check('packed review skill exists', existsSync(join(installedSkills, 'review-spec-workspace', 'SKILL.md')))
		for (const name of ['maintain-spec-workspace', 'review-spec-workspace']) {
			const subpath = join(name, 'SKILL.md')
			check(`repository ${name} skill matches published package`, readFileSync(join(repositorySkills, subpath), 'utf8')
			=== readFileSync(join(sourceSkills, subpath), 'utf8'))
		}
		check('tarball omits old v0 application/domain source', !existsSync(join(installed, 'src')))
		check('tarball omits obsolete EF history', !existsSync(join(installed, 'docs', 'ef-core')))
		check('tarball omits old artifact skills', !existsSync(join(installedSkills, 'author-engineering-files')))
		const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
		check('runtime dependency no longer contains Commander', !Object.hasOwn(installedManifest.dependencies ?? {}, 'commander'))
		check('published files only expose dist and skills', JSON.stringify(installedManifest.files) === '["dist","skills"]')

		check('manifest exposes public ESM and published .d.mts declarations', installedManifest.exports?.['.']?.import === './dist/index.mjs'
		&& installedManifest.exports?.['.']?.types === './dist/index.d.mts'
		&& installedManifest.main === './dist/index.mjs'
		&& installedManifest.types === './dist/index.d.mts')
		const bareProbePath = join(consumer, 'public-import.mjs')
		writeFileSync(bareProbePath, `${[
			'import * as api from \'@deviltea/spec-tool\'',
			'console.log(JSON.stringify(Object.keys(api).sort()))',
		].join('\n')}\n`)
		const bareProbe = run(process.execPath, [bareProbePath], consumer)
		check('an external Node ESM consumer resolves the bare @deviltea/spec-tool package specifier', bareProbe.status === 0
		&& bareProbe.stderr === ''
		&& bareProbe.stdout.trim() === JSON.stringify(['SpecClient', 'SpecError', 'createSpecClient'].sort()), bareProbe.stdout + bareProbe.stderr)

		const typeProbePath = join(consumer, 'public-types.mts')
		writeFileSync(typeProbePath, `${[
			'import { createSpecClient, SpecError, type SpecClient, type ContractCreateRequest, type MutationResponse, type NormalizedIr } from \'@deviltea/spec-tool\'',
			'declare const request: ContractCreateRequest',
			'const client: SpecClient = createSpecClient(\'.\')',
			'const changed: Promise<MutationResponse> = client.contract.create(request)',
			'const snapshot: Promise<{ revision: string, data: NormalizedIr }> = client.graph.export()',
			'const error: SpecError = new SpecError(\'invalid_request\', \'test\')',
			'void changed',
			'void snapshot',
			'void error',
		].join('\n')}\n`)
		const tsconfigPath = join(consumer, 'tsconfig.json')
		writeFileSync(tsconfigPath, JSON.stringify({
			compilerOptions: {
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				target: 'ES2022',
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				types: [],
			},
			include: ['public-types.mts'],
		}, null, 2))
		const publicTypecheck = run(packageTool, ['exec', 'tsc', '--project', tsconfigPath], repositoryRoot, { shell: process.platform === 'win32', timeout: 120000 })
		check('external TypeScript NodeNext consumer resolves published request and IR declarations', publicTypecheck.status === 0, publicTypecheck.stdout + publicTypecheck.stderr)

		const api = await import(pathToFileURL(indexEntry).href)
		check('public runtime exports are only frozen-v1 primitives', JSON.stringify(Object.keys(api)
			.sort()) === JSON.stringify(['SpecClient', 'SpecError', 'createSpecClient'].sort()))

		const project = join(temporaryDirectory, 'project with spaces')
		mkdirSync(project)
		const help = runInstalledBin(binary, ['--help'], consumer)
		check('installed bin help succeeds', help.status === 0 && help.stderr === '')
		check('installed bin documents v1 workspace namespace', help.stdout.includes('workspace init|validate') && help.stdout.includes('clause create'))
		check('installed bin does not advertise old Artifact ontology', !help.stdout.includes('artifact create') && !help.stdout.includes('lifecycle activate'))
		const init = runInstalledBin(binary, ['workspace', 'init', '--root', project], consumer)
		check('installed binary forwards a spaced --root argument', init.status === 0 && init.stderr === '', init.stderr)
		const initialized = JSON.parse(init.stdout)
		check('init creates only canonical manifest', readFileSync(join(project, '.spec', 'spec.yaml'), 'utf8') === 'formatVersion: 1\n')
		check('init starts with no extra canonical storage roots', readdirSync(join(project, '.spec'))
			.join(',') === 'spec.yaml')
		check('init returns zero node/edge changes', initialized.changedNodes.length === 0 && initialized.changedEdges.added.length === 0)

		// A malformed UTF-8 JSON byte sequence must not silently turn into U+FFFD.
		const invalidStdin = Buffer.concat([
			Buffer.from('{"title":"'),
			Buffer.from([0xFF]),
			Buffer.from(`","summary":"Invalid","expectedRevision":"${initialized.revision}"}`),
		])
		const invalidEncoding = run(process.execPath, [cliEntry, 'feature', 'create', '--root', project], consumer, { input: invalidStdin })
		check('CLI rejects invalid UTF-8 request bytes with a structured stdin error', invalidEncoding.status !== 0
		&& invalidEncoding.stdout === ''
		&& JSON.parse(invalidEncoding.stderr).code === 'invalid_request'
		&& JSON.parse(invalidEncoding.stderr).details.issues[0].path === 'stdin')
		check('malformed UTF-8 request cannot mutate canonical workspace', (await api.createSpecClient(project).graph.export()).revision === initialized.revision)

		const invoke = (resource, operation, input = {}, extra = []) => {
			const result = run(process.execPath, [cliEntry, resource, operation, '--root', project, ...extra], consumer, { input: JSON.stringify(input) })
			if (result.error)
				throw result.error
			const success = result.status === 0
			check(`${resource}/${operation} uses stdout or stderr exclusively`, (success ? result.stderr : result.stdout) === '', result.stderr + result.stdout)
			return { status: result.status, success, data: JSON.parse(success ? result.stdout : result.stderr) }
		}
		const validated = invoke('workspace', 'validate')
		check('initialized empty workspace is valid', validated.status === 0 && validated.data.valid && validated.data.revision === initialized.revision)
		const feature = invoke('feature', 'create', {
			title: 'Search capability',
			summary: 'Return matching results',
			expectedRevision: initialized.revision,
		})
		const fid = feature.data.changedNodes[0].id
		check('Feature persists UUIDv7 in canonical flat root', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fid)
		&& existsSync(join(project, '.spec', 'features', `${fid}.md`)))
		check('Feature exposes normalized node and changed revision', feature.data.changedNodes[0].kind === 'feature'
		&& feature.data.revision !== initialized.revision)
		const story = invoke('story', 'create', {
			title: 'Find a product',
			actor: 'Buyer',
			goal: 'Find matches',
			value: 'Save time',
			motivates: [fid],
			expectedRevision: feature.data.revision,
		})
		check('Story derives one motivates edge', story.data.changedEdges.added.length === 1
		&& story.data.changedEdges.added[0].type === 'motivates')
		const rule = invoke('rule', 'create', {
			ownerId: fid,
			statement: 'Results must be ordered',
			expectedRevision: story.data.revision,
		})
		const rid = rule.data.changedNodes[0].id
		check('Rule is first-class normalized but embedded in Feature file', rule.data.changedNodes[0].kind === 'rule'
		&& readFileSync(join(project, '.spec', 'features', `${fid}.md`), 'utf8')
			.includes(rid))
		const contract = invoke('contract', 'create', {
			title: 'Shared result ordering',
			summary: 'Cross-feature authority',
			constrains: [fid],
			expectedRevision: rule.data.revision,
		})
		const cid = contract.data.changedNodes[0].id
		check('Contract constrains Feature', contract.data.changedEdges.added[0].to === fid)
		const clause = invoke('clause', 'create', {
			ownerId: cid,
			statement: 'All ordering is deterministic',
			expectedRevision: contract.data.revision,
		})
		const clauseId = clause.data.changedNodes[0].id
		check('Clause inherits Contract applicability', clause.data.changedEdges.added.some(edge => edge.from === clauseId && edge.to === fid))
		const scenario = invoke('scenario', 'create', {
			title: 'Find matching items',
			steps: [{ type: 'when', text: 'I search' }, { type: 'then', text: 'I see matches' }],
			demonstrates: [rid, clauseId].sort(),
			expectedRevision: clause.data.revision,
		})
		check('Scenario persists restricted Gherkin and demonstrates both kinds', scenario.data.changedNodes[0].kind === 'scenario' && scenario.data.changedEdges.added.length === 2)
		const client = api.createSpecClient(project)
		const graph = await client.graph.export()
		check('packed TypeScript API agrees with installed CLI revision', graph.revision === scenario.data.revision)
		check('packed TypeScript API returns all six node kinds', JSON.stringify([...new Set(graph.data.nodes.map(node => node.kind))].sort())
		=== JSON.stringify(['story', 'feature', 'rule', 'contract', 'clause', 'scenario'].sort()))
		check('packed TypeScript API returns full derived graph', graph.data.edges.length === 5)
		const oldCommand = invoke('artifact', 'list')
		check('removed 0.0.1 command cannot dispatch', oldCommand.status !== 0
		&& oldCommand.data.code === 'invalid_request')
		const missingRevision = invoke('feature', 'update', { id: fid, changes: { title: 'Missing revision' } })
		check('binary failures have structured error envelope', missingRevision.status !== 0 && missingRevision.data.code === 'invalid_request')
		const human = run(process.execPath, [cliEntry, 'workspace', 'validate', '--root', project, '--format', 'human'], consumer)
		check('human rendering requires explicit opt-in', human.status === 0 && human.stdout.startsWith('Workspace valid\nRevision: ')
		&& human.stderr === '')
		writeFileSync(join(project, '.spec', 'unrecognized'), 'not valid\n')
		const invalid = invoke('workspace', 'validate')
		check('invalid workspace returns issues on stderr and nonzero exit', invalid.status !== 0 && invalid.data.valid === false && invalid.data.revision === undefined
		&& invalid.data.issues.length > 0)
		const blocked = invoke('graph', 'export')
		check('invalid persistence blocks all general graph reads', blocked.data.code === 'validation_failed')
		rmSync(join(project, '.spec', 'unrecognized'))
		check('external cleanup restores valid revision', (await client.workspace.validate()).revision === graph.revision)
		check('no inherited legacy workspace root created', !existsSync(join(project, '.engineering')))
	}
	finally {
		rmSync(temporaryDirectory, { recursive: true, force: true })
	}
	const failed = results.filter(result => !result.ok)
	for (const result of results) {
		process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} - ${result.name
		}${result.detail ? `: ${result.detail}` : ''}\n`)
	}
	if (failed.length) {
		process.stdout.write(`\n${failed.length}/${results.length} assertions failed.\n`)
		process.exitCode = 1
	}
	else {
		process.stdout.write(`\nAll ${results.length} assertions passed.\n`)
	}
}

main()
	.catch((error) => {
		rmSync(temporaryDirectory, { recursive: true, force: true })
		process.stderr.write(`v1 packed consumer smoke failed: ${String(error)}\n`)
		process.exitCode = 1
	})
