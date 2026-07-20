import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const typescriptVersion = readArgument('--typescript') ?? '6.0.3'
const workspace = await mkdtemp(join(tmpdir(), 'deviltea-tsconfig-contracts-'))

const nodeTypes = {
	'@types/node': '22.20.0',
}

const fixtures = [
	{
		name: 'strict',
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/strict', ['positive.ts'], {
				lib: ['ES2022'],
				module: 'Preserve',
				moduleResolution: 'Bundler',
				noEmit: true,
				target: 'ES2022',
				types: [],
			}),
			'tsconfig.failure.json': createConfig('./tsconfig.json', ['strict-failure.ts']),
			'positive.ts': source('export const value: number = 1'),
			'strict-failure.ts': source(
				'export function maybeValue(flag: boolean): number {',
				'\tif (flag)',
				'\t\treturn 1',
				'}',
			),
		},
		checks: [
			['tsconfig.json', true],
			['tsconfig.failure.json', false],
		],
		assertConfig(config) {
			assertEqual(config.compilerOptions.strict, true, 'strict policy')
			assertEqual(config.compilerOptions.noUncheckedSideEffectImports, true, 'side-effect import checking')
		},
	},
	{
		name: 'neutral',
		dependencies: nodeTypes,
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/neutral', ['positive.ts']),
			'tsconfig.dom.json': createConfig('./tsconfig.json', ['dom-global.ts']),
			'tsconfig.node.json': createConfig('./tsconfig.json', ['node-global.ts']),
			'positive.ts': source('export const values = new Map<string, number>([[\'one\', 1]])'),
			'dom-global.ts': source('export const title = document.title'),
			'node-global.ts': source('export const platform = process.platform'),
		},
		checks: [
			['tsconfig.json', true],
			['tsconfig.dom.json', false],
			['tsconfig.node.json', false],
		],
		assertConfig(config) {
			assertEqual(config.compilerOptions.module, 'preserve', 'neutral module')
			assertEqual(config.compilerOptions.moduleResolution, 'bundler', 'neutral moduleResolution')
			assertEqual(config.compilerOptions.target, 'es2022', 'neutral target')
			assertEqual(config.compilerOptions.types.length, 0, 'neutral ambient types')
		},
	},
	{
		name: 'browser',
		dependencies: nodeTypes,
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/browser', ['positive.ts']),
			'tsconfig.node.json': createConfig('./tsconfig.json', ['node-global.ts']),
			'positive.ts': source(
				'document.title = \'contract\'',
				'export const href = window.location.href',
			),
			'node-global.ts': source('export const platform = process.platform'),
		},
		checks: [
			['tsconfig.json', true],
			['tsconfig.node.json', false],
		],
		assertConfig(config) {
			assert(config.compilerOptions.lib.some(value => value.includes('dom')), 'browser preset must include DOM')
			assertEqual(config.compilerOptions.types.length, 0, 'browser ambient types')
		},
	},
	{
		name: 'node-bundler',
		dependencies: nodeTypes,
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/node-bundler', ['main.ts', 'sibling.ts']),
			'main.ts': source(
				'import process from \'node:process\'',
				'import { value } from \'./sibling\'',
				'export const result = process.platform + \':\' + value',
			),
			'sibling.ts': source('export const value = 1'),
		},
		checks: [['tsconfig.json', true]],
		assertConfig(config) {
			assertEqual(config.compilerOptions.module, 'preserve', 'node-bundler module')
			assertEqual(config.compilerOptions.moduleResolution, 'bundler', 'node-bundler moduleResolution')
		},
	},
	{
		name: 'node-native',
		dependencies: nodeTypes,
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/node', ['positive.ts', 'sibling.ts']),
			'tsconfig.extensionless.json': createConfig('./tsconfig.json', ['extensionless.ts', 'sibling.ts']),
			'positive.ts': source(
				'import process from \'node:process\'',
				'import { value } from \'./sibling.js\'',
				'export const result = process.platform + \':\' + value',
			),
			'extensionless.ts': source(
				'import { value } from \'./sibling\'',
				'export { value }',
			),
			'sibling.ts': source('export const value = 1'),
		},
		checks: [
			['tsconfig.json', true],
			['tsconfig.extensionless.json', false],
		],
		assertConfig(config) {
			assertEqual(config.compilerOptions.module, 'nodenext', 'native Node module')
			assertEqual(config.compilerOptions.moduleResolution, 'nodenext', 'native Node moduleResolution')
		},
	},
	{
		name: 'tooling',
		dependencies: nodeTypes,
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/tooling', ['tooling.js']),
			'tooling.js': source(
				'import process from \'node:process\'',
				'export const platform = process.platform',
			),
		},
		checks: [['tsconfig.json', true]],
		assertConfig(config) {
			assertEqual(config.compilerOptions.checkJs, true, 'tooling checkJs')
			assertEqual(config.compilerOptions.target, 'es2024', 'tooling target')
		},
	},
	{
		name: 'internal-export',
		files: {
			'tsconfig.json': createConfig('@deviltea/tsconfig/_bundler', ['positive.ts']),
			'positive.ts': source('export const value = 1'),
		},
		checks: [['tsconfig.json', false]],
	},
]

try {
	const packResult = run('npm', ['pack', '--json', '--pack-destination', workspace], root)
	const [{ filename }] = JSON.parse(packResult.stdout)
	const tarball = join(workspace, filename)

	for (const fixture of fixtures)
		await runFixture(fixture, tarball)

	console.log(`Preset contracts passed with TypeScript ${typescriptVersion}.`)
}
finally {
	await rm(workspace, { force: true, recursive: true })
}

async function runFixture(fixture, tarball) {
	const fixtureRoot = join(workspace, fixture.name)
	await mkdir(fixtureRoot, { recursive: true })
	for (const [path, content] of Object.entries(fixture.files)) {
		const filePath = join(fixtureRoot, path)
		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, content)
	}

	await writeFile(
		join(fixtureRoot, 'package.json'),
		`${JSON.stringify({
			private: true,
			type: 'module',
			devDependencies: {
				'@deviltea/tsconfig': `file:${tarball}`,
				'typescript': typescriptVersion,
				...fixture.dependencies,
			},
		}, null, '\t')}\n`,
	)

	run(
		'npm',
		['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
		fixtureRoot,
	)

	const tsc = join(fixtureRoot, 'node_modules', 'typescript', 'bin', 'tsc')
	for (const [project, shouldPass] of fixture.checks) {
		const result = run(process.execPath, [tsc, '--project', project, '--pretty', 'false'], fixtureRoot, true)
		if ((result.status === 0) !== shouldPass) {
			throw new Error([
				`${fixture.name}/${project} was expected to ${shouldPass ? 'pass' : 'fail'}.`,
				result.output,
			].join('\n'))
		}
	}

	if (fixture.assertConfig) {
		const result = run(
			process.execPath,
			[tsc, '--project', 'tsconfig.json', '--showConfig', '--pretty', 'false'],
			fixtureRoot,
		)
		fixture.assertConfig(JSON.parse(result.stdout))
	}
}

function createConfig(extendsConfig, files, compilerOptions = {}) {
	return `${JSON.stringify({
		extends: extendsConfig,
		compilerOptions: {
			noEmit: true,
			...compilerOptions,
		},
		files,
	}, null, '\t')}\n`
}

function source(...lines) {
	return `${lines.join('\n')}\n`
}

function readArgument(name) {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

function run(command, arguments_, cwd, allowFailure = false) {
	const result = spawnSync(command, arguments_, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			npm_config_update_notifier: 'false',
		},
	})
	const stdout = (result.stdout ?? '').trim()
	const stderr = (result.stderr ?? '').trim()
	const output = [stdout, stderr]
		.filter(Boolean)
		.join('\n')

	if (result.error)
		throw result.error
	if (!allowFailure && result.status !== 0)
		throw new Error(`${command} ${arguments_.join(' ')} failed.\n${output}`)

	return {
		output,
		status: result.status,
		stderr,
		stdout,
	}
}

function assert(condition, message) {
	if (!condition)
		throw new Error(message)
}

function assertEqual(actual, expected, label) {
	assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}
