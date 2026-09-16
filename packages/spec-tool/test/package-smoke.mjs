#!/usr/bin/env node

/* Packed-consumer smoke test for the Spec-native CLI contract. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

function run(binary, args, cwd) {
	return spawnSync(binary, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024, shell: process.platform === 'win32' })
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
	const binary = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'spec.cmd' : 'spec')
	check('installed spec binary exists', existsSync(binary), binary)
	check('package ships maintain-spec-workspace skill', existsSync(join(installedSkills, 'maintain-spec-workspace', 'SKILL.md')))
	check('package ships review-spec-workspace skill', existsSync(join(installedSkills, 'review-spec-workspace', 'SKILL.md')))
	check('package omits inherited author-engineering-files skill', !existsSync(join(installedSkills, 'author-engineering-files')))
	check('package omits inherited review-engineering-change skill', !existsSync(join(installedSkills, 'review-engineering-change')))
	check('package omits inherited EF documentation', !existsSync(join(installedPackage, 'docs', 'ef-core')))

	const version = run(binary, ['version', '--format', 'json'], consumer)
	const versionJson = JSON.parse(version.stdout)
	check('version exits successfully', version.status === 0)
	check('version uses Spec schema', versionJson.schema === 'spec/version-result@1')

	const project = join(temporaryDirectory, 'project')
	mkdirSync(project)
	const init = run(binary, ['init', '--format', 'json', '--no-input', '--title', 'Smoke'], project)
	const initJson = JSON.parse(init.stdout)
	check('init exits successfully', init.status === 0, init.stderr)
	check('init reports applied', initJson.ok === true && initJson.applied === true, init.stdout)
	check('config has exact MVP bytes', readFileSync(join(project, '.spec', 'config.yaml'), 'utf8') === 'schema: spec/config@1\n')
	const projectFiles = readdirSync(join(project, '.spec', 'projects'))
	check('init creates one UUIDv7 project file', projectFiles.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/i.test(projectFiles[0] ?? ''))

	const validate = run(binary, ['validate', '--format', 'json', '--no-input'], project)
	const validateJson = JSON.parse(validate.stdout)
	check('validate exits successfully', validate.status === 0, validate.stderr)
	check('validate accepts initialized workspace', validateJson.schema === 'spec/validation-result@1' && validateJson.valid === true, validate.stdout)
	const artifact = run(binary, ['artifact', 'create', '--format', 'json', '--kind', 'story', '--title', 'Smoke story'], project)
	const artifactJson = JSON.parse(artifact.stdout)
	check('artifact create exits successfully', artifact.status === 0, artifact.stderr)
	check('artifact create returns stable result', artifactJson.schema === 'spec/artifact-result@1' && artifactJson.artifact?.kind === 'story' && artifactJson.artifact?.status === 'draft', artifact.stdout)
	const artifactId = artifactJson.artifact?.id
	const list = run(binary, ['artifact', 'list', '--format', 'json', '--kind', 'story'], project)
	const listJson = JSON.parse(list.stdout)
	check('artifact list returns created Artifact', list.status === 0 && listJson.artifacts?.some(item => item.id === artifactId), list.stdout)
	const search = run(binary, ['search', 'smoke', '--format', 'json', '--kind', 'story'], project)
	const searchJson = JSON.parse(search.stdout)
	check('search exits successfully', search.status === 0, search.stderr)
	check('search uses stable result schema and finds created Artifact', searchJson.schema === 'spec/search-result@1' && searchJson.matches?.some(item => item.artifact?.id === artifactId && item.matchedFields?.includes('title')), search.stdout)
	const trace = run(binary, ['trace', artifactId, '--format', 'json'], project)
	const traceJson = JSON.parse(trace.stdout)
	check('trace exits successfully', trace.status === 0, trace.stderr)
	check('trace uses stable result schema and includes the root Artifact', traceJson.schema === 'spec/trace-result@1' && traceJson.direction === 'both' && traceJson.artifacts?.some(item => item.id === artifactId), trace.stdout)
	const deleted = run(binary, ['artifact', 'delete', artifactId, '--format', 'json'], project)
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
