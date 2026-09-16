#!/usr/bin/env node

/* Packed-consumer smoke test for the Spec-native CLI contract. */

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

const packageTool = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmTool = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'deviltea-spec-smoke-'))
const results = []

function record(name, ok, detail = '') {
	results.push({ name, ok, detail })
}

function setup(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024, shell: process.platform === 'win32' })
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
}

function run(command, args, cwd, shell = false) {
	return spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024, shell })
}

function runInstalledBin(binary, args, cwd) {
	if (process.platform !== 'win32')
		return run(binary, args, cwd)

	const quote = value => `'${value.replaceAll('\'', '\'\'')}'`
	const command = `& ${[binary, ...args].map(quote)
		.join(' ')}`
	return run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], cwd)
}

function check(name, condition, detail = '') {
	record(name, Boolean(condition), condition ? '' : detail)
}

try {
	const supplied = process.env.SPEC_SMOKE_TARBALL
	let tarball
	if (supplied) {
		if (!isAbsolute(supplied) || !existsSync(supplied))
			throw new Error('SPEC_SMOKE_TARBALL must be an existing absolute path')
		tarball = supplied
	}
	else {
		setup(packageTool, ['pack', '--pack-destination', temporaryDirectory], process.cwd())
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
	const installedPackage = join(consumer, 'node_modules', '@deviltea', 'spec-tool')
	const installedSkills = join(installedPackage, 'skills')
	const cliEntry = join(installedPackage, 'dist', 'cli.mjs')
	const binary = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'spec.cmd' : 'spec')
	check('installed spec binary exists', existsSync(binary), binary)
	check('installed CLI entry exists', existsSync(cliEntry), cliEntry)
	check('package ships maintain-spec-workspace skill', existsSync(join(installedSkills, 'maintain-spec-workspace', 'SKILL.md')))
	check('package ships review-spec-workspace skill', existsSync(join(installedSkills, 'review-spec-workspace', 'SKILL.md')))
	check('package omits inherited author-engineering-files skill', !existsSync(join(installedSkills, 'author-engineering-files')))
	check('package omits inherited review-engineering-change skill', !existsSync(join(installedSkills, 'review-engineering-change')))
	check('package omits inherited EF documentation', !existsSync(join(installedPackage, 'docs', 'ef-core')))

	const version = run(binary, ['version', '--format', 'json'], consumer, process.platform === 'win32')
	const versionJson = JSON.parse(version.stdout)
	check('version exits successfully', version.status === 0)
	check('version uses Spec schema', versionJson.schema === 'spec/version-result@1')
	const runSpec = (args, cwd) => run(process.execPath, [cliEntry, ...args], cwd)

	const project = join(temporaryDirectory, 'project')
	mkdirSync(project)
	const init = runSpec(['init', '--format', 'json', '--no-input', '--title', 'Smoke'], project)
	const initJson = JSON.parse(init.stdout)
	check('init exits successfully', init.status === 0, init.stderr)
	check('init reports applied', initJson.ok === true && initJson.applied === true, init.stdout)
	check('config has exact MVP bytes', readFileSync(join(project, '.spec', 'config.yaml'), 'utf8') === 'schema: spec/config@1\n')
	const projectFiles = readdirSync(join(project, '.spec', 'projects'))
	check('init creates one UUIDv7 project file', projectFiles.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/i.test(projectFiles[0] ?? ''))

	const validate = runSpec(['validate', '--format', 'json', '--no-input'], project)
	const validateJson = JSON.parse(validate.stdout)
	check('validate exits successfully', validate.status === 0, validate.stderr)
	check('validate accepts initialized workspace', validateJson.schema === 'spec/validation-result@1' && validateJson.valid === true, validate.stdout)

	const binProbe = runInstalledBin(binary, ['artifact', 'create', '--format', 'json', '--kind', 'story', '--title', 'Bin shim smoke'], project)
	const binProbeJson = binProbe.status === 0 ? JSON.parse(binProbe.stdout) : undefined
	check('installed npm bin forwards spaced arguments', binProbe.status === 0 && binProbeJson?.artifact?.title === 'Bin shim smoke', `${binProbe.stdout} ${binProbe.stderr}`)

	const artifact = runSpec(['artifact', 'create', '--format', 'json', '--kind', 'story', '--title', 'Smoke story'], project)
	const artifactJson = JSON.parse(artifact.stdout)
	check('artifact create exits successfully', artifact.status === 0, artifact.stderr)
	check('artifact create returns stable result', artifactJson.schema === 'spec/artifact-result@1' && artifactJson.artifact?.kind === 'story' && artifactJson.artifact?.status === 'draft', artifact.stdout)
	const artifactId = artifactJson.artifact?.id
	if (typeof artifactId !== 'string')
		throw new TypeError(`artifact create did not return an id\nstdout: ${artifact.stdout}\nstderr: ${artifact.stderr}`)
	const secondArtifact = runSpec(['artifact', 'create', '--format', 'json', '--kind', 'story', '--title', 'Smoke target'], project)
	const secondArtifactJson = JSON.parse(secondArtifact.stdout)
	const secondArtifactId = secondArtifactJson.artifact?.id
	check('second artifact create exits successfully', secondArtifact.status === 0, secondArtifact.stderr)
	if (typeof secondArtifactId !== 'string')
		throw new TypeError(`second artifact create did not return an id\nstdout: ${secondArtifact.stdout}\nstderr: ${secondArtifact.stderr}`)

	const relationAdd = runSpec(['relation', 'add', artifactId, secondArtifactId, '--type', 'references', '--format', 'json'], project)
	const relationAddJson = JSON.parse(relationAdd.stdout)
	check('relation add exits successfully', relationAdd.status === 0, relationAdd.stderr)
	check('relation add uses stable result schema', relationAddJson.schema === 'spec/relation-result@1' && relationAddJson.relation?.type === 'references', relationAdd.stdout)
	const relationList = runSpec(['relation', 'list', '--artifact', artifactId, '--format', 'json'], project)
	const relationListJson = JSON.parse(relationList.stdout)
	check('relation list returns added edge', relationList.status === 0 && relationListJson.relations?.some(item => item.source === artifactId && item.target === secondArtifactId), relationList.stdout)
	const relationRemove = runSpec(['relation', 'remove', artifactId, secondArtifactId, '--type', 'references', '--format', 'json'], project)
	check('relation remove exits successfully', relationRemove.status === 0, relationRemove.stderr)

	const resourceDirectory = join(project, '.spec', 'resources', artifactId)
	mkdirSync(resourceDirectory, { recursive: true })
	writeFileSync(join(resourceDirectory, 'smoke.txt'), 'packed resource\n')
	const resourceLocation = `.spec/resources/${artifactId}/smoke.txt`
	const resourceAdd = runSpec(['resource', 'add', artifactId, '--location', resourceLocation, '--role', 'evidence', '--media-type', 'text/plain', '--format', 'json'], project)
	check('resource add exits successfully', resourceAdd.status === 0, resourceAdd.stderr)
	const resourceRead = runSpec(['resource', 'read', artifactId, resourceLocation, '--format', 'json'], project)
	const resourceReadJson = JSON.parse(resourceRead.stdout)
	check('resource read preserves UTF-8 content', resourceRead.status === 0 && resourceReadJson.encoding === 'utf8' && resourceReadJson.content === 'packed resource\n', resourceRead.stdout)
	const binaryBytes = Buffer.from([0, 255, 128, 65, 10])
	writeFileSync(join(resourceDirectory, 'smoke.bin'), binaryBytes)
	const binaryResourceLocation = `.spec/resources/${artifactId}/smoke.bin`
	const binaryResourceAdd = runSpec(['resource', 'add', artifactId, '--location', binaryResourceLocation, '--role', 'evidence', '--media-type', 'application/octet-stream', '--format', 'json'], project)
	check('binary resource add exits successfully', binaryResourceAdd.status === 0, binaryResourceAdd.stderr)
	const binaryResourceRead = runSpec(['resource', 'read', artifactId, binaryResourceLocation, '--format', 'json'], project)
	const binaryResourceReadJson = JSON.parse(binaryResourceRead.stdout)
	check('binary resource read is byte-safe base64', binaryResourceRead.status === 0 && binaryResourceReadJson.encoding === 'base64' && binaryResourceReadJson.bytes === binaryBytes.byteLength && Buffer.from(binaryResourceReadJson.content, 'base64')
		.equals(binaryBytes), binaryResourceRead.stdout)
	const binaryResourceRemove = runSpec(['resource', 'remove', artifactId, binaryResourceLocation, '--format', 'json'], project)
	check('binary resource remove exits successfully', binaryResourceRemove.status === 0, binaryResourceRemove.stderr)
	const resourceRemove = runSpec(['resource', 'remove', artifactId, resourceLocation, '--format', 'json'], project)
	check('resource remove exits successfully', resourceRemove.status === 0, resourceRemove.stderr)

	const storyBody = '## Actor\nUser\n\n## Goal\nExercise packed lifecycle.\n\n## Value\nVerify the installed CLI.\n'
	const artifactUpdate = runSpec(['artifact', 'update', artifactId, '--body', storyBody, '--format', 'json'], project)
	check('artifact update exits successfully', artifactUpdate.status === 0, artifactUpdate.stderr)
	const lifecycleActivate = runSpec(['lifecycle', 'activate', artifactId, '--format', 'json'], project)
	const lifecycleActivateJson = JSON.parse(lifecycleActivate.stdout)
	check('lifecycle activate reaches active', lifecycleActivate.status === 0 && lifecycleActivateJson.artifact?.status === 'active', lifecycleActivate.stdout)

	const usageError = runSpec(['artifact', 'create', '--format', 'json'], project)
	const usageErrorJson = JSON.parse(usageError.stdout)
	check('JSON usage errors use stable error envelope', usageError.status === 2 && usageError.stderr === '' && usageErrorJson.schema === 'spec/error-result@1' && usageErrorJson.diagnostics?.[0]?.code === 'SPEC-CLI-INVALID', `${usageError.stdout} ${usageError.stderr}`)

	const list = runSpec(['artifact', 'list', '--format', 'json', '--kind', 'story'], project)
	const listJson = JSON.parse(list.stdout)
	check('artifact list returns created Artifact', list.status === 0 && listJson.artifacts?.some(item => item.id === artifactId), list.stdout)
	const search = runSpec(['search', 'smoke', '--format', 'json', '--kind', 'story'], project)
	const searchJson = JSON.parse(search.stdout)
	check('search exits successfully', search.status === 0, search.stderr)
	check('search uses stable result schema and finds created Artifact', searchJson.schema === 'spec/search-result@1' && searchJson.matches?.some(item => item.artifact?.id === artifactId && item.matchedFields?.includes('title')), search.stdout)
	const trace = runSpec(['trace', artifactId, '--format', 'json'], project)
	const traceJson = JSON.parse(trace.stdout)
	check('trace exits successfully', trace.status === 0, trace.stderr)
	check('trace uses stable result schema and includes the root Artifact', traceJson.schema === 'spec/trace-result@1' && traceJson.direction === 'both' && traceJson.artifacts?.some(item => item.id === artifactId), trace.stdout)
	const deleted = runSpec(['artifact', 'delete', secondArtifactId, '--format', 'json'], project)
	check('draft Artifact delete exits successfully', deleted.status === 0, deleted.stderr)
	check('legacy EF root is not created', !existsSync(join(project, '.engineering')))
}
finally {
	rmSync(temporaryDirectory, { force: true, recursive: true })
}

const failed = results.filter(result => !result.ok)
for (const result of results)
	process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} - ${result.name}${result.detail ? `: ${result.detail}` : ''}\n`)
if (failed.length > 0) {
	process.stdout.write(`\n${failed.length}/${results.length} assertion(s) failed.\n`)
	process.exitCode = 1
}
else {
	process.stdout.write(`\nAll ${results.length} assertions passed.\n`)
}
