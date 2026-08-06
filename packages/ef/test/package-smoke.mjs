#!/usr/bin/env node
/**
 * Packed-package consumer smoke test (docs/planning/00-implementation-decisions.md
 * "Testing and Verification": "installing the output of `pnpm pack` and
 * invoking the installed `ef` binary"; "exact stdout, stderr, JSON shape,
 * trailing newline, and exit-code assertions"; "byte-for-byte `resource
 * read` assertions").
 *
 * Plain Node.js script, no test framework: packs the current working tree
 * with `pnpm pack`, installs the resulting tarball into a clean throwaway
 * npm consumer project (the way a real downstream consumer would), and
 * exercises the installed `node_modules/.bin/ef` binary end to end. Every
 * assertion is exact -- byte-level for the raw-transport failure cases, full
 * JSON-shape for the JSON envelopes -- rather than a loose "it ran"
 * smoke check, per the linked decisions doc.
 *
 * Assumes `pnpm build` has already produced `dist/` (the `test:package`
 * script in `package.json` runs `pnpm build` first); this script only packs
 * and consumes the existing build output.
 */

import { spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const git = process.platform === 'win32' ? 'git.exe' : 'git'

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = []

function record(name, ok, detail = '') {
	results.push({ name, ok, detail })
}

function assert(name, condition, detail = '') {
	record(name, Boolean(condition), condition ? '' : detail)
}

function assertEqual(name, actual, expected) {
	const ok = Object.is(actual, expected)
	record(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Runs a setup command; throws with full diagnostic output on failure. Setup failures are environment problems, not smoke-test findings, so they abort the run instead of being recorded as findings. */
function runSetup(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: { ...process.env, ...options.env },
		maxBuffer: 10 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error([
			`Setup command failed: ${command} ${args.join(' ')}`,
			result.error?.message,
			result.stdout,
			result.stderr,
		].filter(Boolean)
			.join('\n'))
	}
	return result
}

/** Runs an `ef` invocation under test; never throws -- exit code and output are the assertions' subject, not a script-level failure. */
function runEf(efBinary, args, options = {}) {
	return spawnSync(efBinary, args, {
		cwd: options.cwd,
		encoding: 'buffer',
		env: { ...process.env, ...options.env },
		maxBuffer: 10 * 1024 * 1024,
	})
}

function parseJsonOrUndefined(buffer) {
	try {
		return JSON.parse(buffer.toString('utf8'))
	}
	catch {
		return undefined
	}
}

function main() {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), 'deviltea-ef-smoke-'))

	try {
		// ---- Pack the current build output ------------------------------------

		runSetup(pnpm, ['pack', '--pack-destination', temporaryDirectory])

		const tarballName = readdirSync(temporaryDirectory)
			.find(fileName => fileName.endsWith('.tgz'))
		if (!tarballName)
			throw new Error('pnpm pack did not produce a tarball')
		const tarballPath = join(temporaryDirectory, tarballName)

		// ---- Install the tarball into a clean npm consumer project -------------

		const consumerDirectory = join(temporaryDirectory, 'consumer')
		mkdirSync(consumerDirectory)
		runSetup(npm, ['init', '--yes'], { cwd: consumerDirectory })
		runSetup(npm, ['install', tarballPath], { cwd: consumerDirectory })

		const efBinaryName = process.platform === 'win32' ? 'ef.cmd' : 'ef'
		const efBinary = join(consumerDirectory, 'node_modules', '.bin', efBinaryName)
		assert('installed ef binary exists', existsSync(efBinary), `expected binary at ${efBinary}`)

		const installedPackageJson = JSON.parse(readFileSync(
			join(consumerDirectory, 'node_modules', '@deviltea', 'ef', 'package.json'),
			'utf8',
		))

		// ---- Skills ship in the npm tarball (00-implementation-decisions.md
		// "Agent Skills": "Skills ship in the npm tarball ... under the same
		// release tag as the CLI.") ------------------------------------------

		const installedSkillsDirectory = join(consumerDirectory, 'node_modules', '@deviltea', 'ef', 'skills')
		assert('installed package ships skills/', existsSync(installedSkillsDirectory), `expected ${installedSkillsDirectory}`)
		for (const skillName of ['author-engineering-files', 'review-engineering-change']) {
			const skillFile = join(installedSkillsDirectory, skillName, 'SKILL.md')
			assert(`installed package ships skills/${skillName}/SKILL.md`, existsSync(skillFile), `expected ${skillFile}`)
		}

		// ---- (a) ef version --format json --------------------------------------

		{
			const result = runEf(efBinary, ['version', '--format', 'json'], { cwd: consumerDirectory })
			const stdoutText = result.stdout.toString('utf8')
			const newlineCount = (stdoutText.match(/\n/g) ?? []).length
			const isExactlyOneJsonLine = stdoutText.endsWith('\n') && newlineCount === 1
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('version: exit code', result.status, 0)
			assert('version: stdout is exactly one JSON object plus one trailing LF', isExactlyOneJsonLine, `stdout=${JSON.stringify(stdoutText)}`)
			assert('version: stdout parses as JSON', parsed !== undefined, `stdout=${JSON.stringify(stdoutText)}`)
			assertEqual('version: schema', parsed?.schema, 'ef/version-result@1')
			assertEqual('version: ef_core_major', parsed?.ef_core_major, 1)
			assertEqual('version: version matches installed package.json', parsed?.version, installedPackageJson.version)
		}

		// ---- (b) ef help ---------------------------------------------------------

		{
			const result = runEf(efBinary, ['help'], { cwd: consumerDirectory })
			assertEqual('help: exit code', result.status, 0)
		}

		// ---- Temp Git repo for the project-mutation assertions ------------------

		const projectDirectory = join(temporaryDirectory, 'project')
		mkdirSync(projectDirectory)
		runSetup(git, ['init', '--initial-branch=main'], { cwd: projectDirectory })
		runSetup(git, ['config', 'user.email', 'ef-smoke@example.com'], { cwd: projectDirectory })
		runSetup(git, ['config', 'user.name', 'EF Smoke Test'], { cwd: projectDirectory })

		// ---- (c) ef init --------------------------------------------------------

		{
			const result = runEf(efBinary, [
				'init',
				'--yes',
				'--format',
				'json',
				'--title',
				'T',
				'--summary',
				'S',
				'--vision',
				'V',
				'--project-scope',
				'P',
				'--non-goals',
				'N',
				'--context',
				'C',
				'--integration-ref',
				'refs/heads/main',
			], { cwd: projectDirectory })
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('init: exit code', result.status, 0)
			assert('init: parses as JSON', parsed !== undefined, `stdout=${JSON.stringify(result.stdout.toString('utf8'))}, stderr=${JSON.stringify(result.stderr.toString('utf8'))}`)
			assertEqual('init: applied', parsed?.applied, true)
			assert('init: .engineering/ef.yaml exists', existsSync(join(projectDirectory, '.engineering', 'ef.yaml')), '')
		}

		// ---- (d) ef artifact create req ------------------------------------------

		{
			const result = runEf(efBinary, [
				'artifact',
				'create',
				'req',
				'--yes',
				'--format',
				'json',
				'--title',
				'R',
				'--summary',
				'S',
			], { cwd: projectDirectory })
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('artifact create req: exit code', result.status, 0)
			assert('artifact create req: parses as JSON', parsed !== undefined, `stdout=${JSON.stringify(result.stdout.toString('utf8'))}, stderr=${JSON.stringify(result.stderr.toString('utf8'))}`)
			assertEqual('artifact create req: applied', parsed?.applied, true)
			assert('artifact create req: .engineering/req/REQ-001.md exists', existsSync(join(projectDirectory, '.engineering', 'req', 'REQ-001.md')), '')
		}

		// ---- (e) ef validate --scope snapshot ------------------------------------

		{
			const result = runEf(efBinary, ['validate', '--scope', 'snapshot', '--format', 'json'], { cwd: projectDirectory })
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('validate snapshot: exit code', result.status, 0)
			assert('validate snapshot: parses as JSON', parsed !== undefined, `stdout=${JSON.stringify(result.stdout.toString('utf8'))}, stderr=${JSON.stringify(result.stderr.toString('utf8'))}`)
			assertEqual('validate snapshot: valid', parsed?.valid, true)
		}

		// ---- (f) ef resource read failure (byte-level) ---------------------------

		{
			const result = runEf(efBinary, ['resource', 'read', 'REQ-999', 'x'], { cwd: projectDirectory })

			assertEqual('resource read failure: exit code', result.status, 2)
			assertEqual('resource read failure: stdout byte length', result.stdout.length, 0)
		}

		// ---- (g) unknown command --------------------------------------------------

		{
			const result = runEf(efBinary, ['nope', '--format', 'json'], { cwd: projectDirectory })

			assertEqual('unknown command: exit code', result.status, 2)
			assertEqual('unknown command: stdout byte length', result.stdout.length, 0)
		}
	}
	finally {
		rmSync(temporaryDirectory, { force: true, recursive: true })
	}

	// ---- Report ---------------------------------------------------------------

	const failed = results.filter(r => !r.ok)

	for (const r of results) {
		process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} - ${r.name}\n`)
		if (!r.ok)
			process.stdout.write(`     ${r.detail}\n`)
	}

	if (failed.length > 0) {
		process.stdout.write(`\n${failed.length}/${results.length} assertion(s) failed.\n`)
		process.exitCode = 1
		return
	}

	process.stdout.write(`\nAll ${results.length} assertions passed.\n`)
}

main()
