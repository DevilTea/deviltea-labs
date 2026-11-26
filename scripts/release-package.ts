import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

const packages = {
	'spec-tool': {
		directory: 'packages/spec-tool',
		name: '@deviltea/spec-tool',
	},
	'eslint-config': {
		directory: 'packages/eslint-config',
		name: '@deviltea/eslint-config',
	},
	'tiny-state-machine': {
		directory: 'packages/tiny-state-machine/core',
		name: '@deviltea/tiny-state-machine',
	},
	'tiny-state-machine-vue': {
		directory: 'packages/tiny-state-machine/vue',
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

export const packageIds = (Object.keys(packages) as PackageId[]).filter(id => id !== 'tiny-state-machine-vue')

const fsmMembers = ['tiny-state-machine', 'tiny-state-machine-vue'] as const
const fsmCore = packages['tiny-state-machine']

export function releaseMembers(id: string): readonly PackageId[] {
	packageEntry(id)
	if (id === 'tiny-state-machine-vue')
		fail('Release the FSM family together using tiny-state-machine.')
	return id === 'tiny-state-machine' ? fsmMembers : [id as PackageId]
}

export function assertFsmVersions(core: string, vue: string, peer: unknown): void {
	if (core !== vue)
		fail(`FSM versions must match: core ${core}, vue ${vue}.`)
	if (peer !== 'workspace:*')
		fail(`FSM Vue core peer must be workspace:* (exact version on pack).`)
}

export function assertWorkspaceVersions(): void {
	const core = packageVersion('tiny-state-machine')
	const vue = packageVersion('tiny-state-machine-vue')
	const manifest = JSON.parse(readFileSync(resolve(workspaceRoot, packages['tiny-state-machine-vue'].directory, 'package.json'), 'utf8'))
	assertFsmVersions(core, vue, manifest.peerDependencies?.[fsmCore.name])
}

export function releaseVersion(id: string): string {
	const members = releaseMembers(id)
	if (members.length > 1)
		assertWorkspaceVersions()
	return packageVersion(id)
}

export function fail(message: string): never {
	throw new Error(message)
}

export function packageEntry(id: string) {
	if (!Object.hasOwn(packages, id))
		fail(`Unknown release package: ${id}`)

	return packages[id as PackageId]
}

export function packageVersion(id: string) {
	const entry = packageEntry(id)
	const packageJsonPath = resolve(workspaceRoot, entry.directory, 'package.json')
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

export function assertReleaseTagAllowed(id: string, version: string): void {
	releaseMembers(id)
	if (id === 'spec-tool' && version === '0.0.1')
		fail('spec-tool@0.0.1 is the manual, untagged bootstrap release. Publish it manually, configure Trusted Publishing, then tag the next Spec Tool version.')
}

export function packageTag(id: string) {
	const version = releaseVersion(id)
	assertReleaseTagAllowed(id, version)
	return `${id}@${version}`
}

export function verifyTag(tag: string) {
	const separator = tag.lastIndexOf('@')
	if (separator <= 0)
		fail(`Invalid release tag: ${tag}`)

	const id = tag.slice(0, separator)
	const version = tag.slice(separator + 1)
	const currentVersion = releaseVersion(id)

	if (version !== currentVersion)
		fail(`Tag ${tag} does not match ${id}@${currentVersion}`)

	assertReleaseTagAllowed(id, version)

	return id
}

function runCli() {
	const [command, value] = process.argv.slice(2)

	if (command === 'verify-workspace') {
		assertWorkspaceVersions()
		return
	}
	if (!command || !value)
		fail('Usage: release-package.ts <package-path|package-name|version|tag|verify-tag|release-members> <value>')

	switch (command) {
		case 'release-members':
			console.log(releaseMembers(value)
				.join('\n'))
			break
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
			console.log(packageTag(value))
			break
		case 'verify-tag':
			console.log(verifyTag(value))
			break
		default:
			fail(`Unknown command: ${command}`)
	}
}

const entrypoint = process.argv[1]
if (entrypoint != null && resolve(entrypoint) === fileURLToPath(import.meta.url))
	runCli()
