import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const packages = {
	'eslint-config': {
		directory: 'packages/eslint-config',
		name: '@deviltea/eslint-config',
	},
	'tiny-state-machine': {
		directory: 'packages/tiny-state-machine',
		name: '@deviltea/tiny-state-machine',
	},
	'tiny-state-machine-vue': {
		directory: 'packages/tiny-state-machine-vue',
		name: '@deviltea/tiny-state-machine-vue',
	},
	'tsconfig': {
		directory: 'packages/tsconfig',
		name: '@deviltea/tsconfig',
	},
	'vue-router-middleware': {
		directory: 'packages/vue-router-middleware',
		name: '@deviltea/vue-router-middleware',
	},
	'vue-temp-var': {
		directory: 'packages/vue-temp-var',
		name: 'vue-temp-var',
	},
} as const

type PackageId = keyof typeof packages

function fail(message: string): never {
	throw new Error(message)
}

function packageEntry(id: string) {
	if (!(id in packages))
		fail(`Unknown release package: ${id}`)

	return packages[id as PackageId]
}

function packageVersion(id: string) {
	const entry = packageEntry(id)
	const packageJsonPath = resolve(entry.directory, 'package.json')
	const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
		name?: string
		version?: string
	}

	if (packageJson.name !== entry.name)
		fail(`Expected ${packageJsonPath} to name ${entry.name}`)
	if (!packageJson.version)
		fail(`Expected ${packageJsonPath} to contain a version`)

	return packageJson.version
}

function verifyTag(tag: string) {
	const separator = tag.lastIndexOf('@')
	if (separator <= 0)
		fail(`Invalid release tag: ${tag}`)

	const id = tag.slice(0, separator)
	const version = tag.slice(separator + 1)
	const currentVersion = packageVersion(id)

	if (version !== currentVersion)
		fail(`Tag ${tag} does not match ${id}@${currentVersion}`)

	return id
}

const [command, value] = process.argv.slice(2)

if (!command || !value)
	fail('Usage: release-package.ts <package-path|package-name|version|tag|verify-tag> <value>')

switch (command) {
	case 'package-path':
		console.log(packageEntry(value).directory)
		break
	case 'package-name':
		console.log(packageEntry(value).name)
		break
	case 'version':
		console.log(packageVersion(value))
		break
	case 'tag':
		console.log(`${value}@${packageVersion(value)}`)
		break
	case 'verify-tag':
		console.log(verifyTag(value))
		break
	default:
		fail(`Unknown command: ${command}`)
}
