import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const typescriptVersion = readArgument('--typescript') ?? '6.0.3'
const typescriptMajor = Number.parseInt(typescriptVersion, 10)
const workspace = await mkdtemp(join(tmpdir(), 'deviltea-tsconfig-contracts-'))

const fixtures = [
	{
		name: 'base',
		checks: [
			['tsconfig.json', true],
			['tsconfig.dom-global.json', true],
			['tsconfig.strict-failure.json', false],
		],
		assertConfig(config) {
			assertEqual(config.compilerOptions.module, 'esnext', 'base module')
			assertEqual(config.compilerOptions.moduleResolution, 'bundler', 'base moduleResolution')
			assertEqual(config.compilerOptions.strict, true, 'base strict')
		},
	},
	{
		name: 'dom',
		checks: [
			['tsconfig.json', true],
			['tsconfig.node-global.json', false],
		],
		assertConfig(config) {
			assert(
				config.compilerOptions.lib.some(value => value.includes('dom')),
				'dom preset must include the DOM library',
			)
		},
	},
	{
		name: 'node',
		dependencies: {
			'@types/node': '22.20.0',
		},
		checks: [['tsconfig.json', true]],
		assertConfig(config) {
			assert(config.compilerOptions.types.includes('node'), 'node preset must include Node types')
			assertEqual(config.compilerOptions.moduleResolution, 'bundler', 'legacy node moduleResolution')
		},
	},
	{
		name: 'ambient-default',
		dependencies: {
			'@types/node': '22.20.0',
		},
		checks: [['tsconfig.json', typescriptMajor < 6]],
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
	await cp(join(root, 'tests', 'fixtures', fixture.name), fixtureRoot, { recursive: true })
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
