#!/usr/bin/env node
/**
 * Packed-package consumer smoke test (docs/planning/00-implementation-decisions.md
 * "Testing and Verification": "installing the output of `pnpm pack` and
 * invoking the installed `ef` binary"; "exact stdout, stderr, JSON shape,
 * trailing newline, and exit-code assertions"; "byte-for-byte `resource
 * read` assertions"; "CI execution on Ubuntu, macOS, and Windows with
 * supported Node.js versions").
 *
 * Plain Node.js script, no test framework: packs the current working tree
 * with `pnpm pack`, installs the resulting tarball into a clean throwaway
 * npm consumer project (the way a real downstream consumer would), and
 * exercises the installed `ef` binary end to end. Every assertion is exact
 * -- byte-level for the raw-transport failure cases, full JSON-shape for the
 * JSON envelopes -- rather than a loose "it ran" smoke check, per the linked
 * decisions doc.
 *
 * Assumes `pnpm build` has already produced `dist/` (the `test:package`
 * script in `package.json` runs `pnpm build` first); this script only packs
 * and consumes the existing build output.
 *
 * When the `EF_SMOKE_TARBALL` environment variable is set to an absolute
 * path, that tarball is installed directly and the internal build+pack step
 * is skipped. CI uses this to build and pack the package once on Node.js 24
 * and reuse the resulting tarball for the packed-consumer runs on every
 * supported OS and Node.js version, instead of rebuilding per matrix leg.
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
import { isAbsolute, join } from 'node:path'
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

function assertEqual(name, actual, expected, context = '') {
	const ok = Object.is(actual, expected)
	const detail = ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${context ? ` | ${context}` : ''}`
	record(name, ok, detail)
}

const MAX_OUTPUT_DETAIL_BYTES = 4000

/** Truncates `text` to a reasonable length for a failure detail line, so a huge stream doesn't flood CI logs while still being complete enough to diagnose a JSON-shape or exit-code mismatch. */
function truncateForDetail(text) {
	if (text.length <= MAX_OUTPUT_DETAIL_BYTES)
		return text
	return `${text.slice(0, MAX_OUTPUT_DETAIL_BYTES)}... [truncated, ${text.length} chars total]`
}

/** Full stdout/stderr (truncated) for a `runCli`/`runEf` result, appended to assertion failure details so a failing CI run shows the actual JSON diagnostics instead of just "expected/got". */
function describeCliResult(result) {
	return `stdout=${JSON.stringify(truncateForDetail(result.stdout.toString('utf8')))} stderr=${JSON.stringify(truncateForDetail(result.stderr.toString('utf8')))}`
}

/** Runs a setup command; throws with full diagnostic output on failure. Setup failures are environment problems, not smoke-test findings, so they abort the run instead of being recorded as findings. */
function runSetup(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: { ...process.env, ...options.env },
		maxBuffer: 10 * 1024 * 1024,
		shell: options.shell,
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

/**
 * Quotes a single argument for inclusion in the `cmd.exe` command line that
 * `spawnSync` builds when `shell: true` (see `runSetupCliTool` below): Node
 * assembles that command line as `[file, ...args].join(' ')` with no
 * per-argument quoting of its own (`windowsVerbatimArguments` is set so Node
 * does not add any), so an argument containing whitespace must be
 * pre-quoted here or it silently splits into multiple `cmd.exe` tokens. None
 * of the arguments this script passes to `npm`/`pnpm` currently contain a
 * space or a double quote (they are literal flags or `mkdtempSync`-derived
 * paths), so this is a defensive no-op in practice today.
 */
function quoteForWindowsShell(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/**
 * Runs `npm` or `pnpm` as a setup step. On Windows these resolve to `.cmd`
 * shims (a batch file cannot be the target of `CreateProcess` directly); as
 * of the CVE-2024-27980 fix (Node.js 18.20.2 / 20.12.2 / 21.7.2 and every
 * later release, which covers every Node.js version supported by this
 * package's `engines` field), `child_process.spawnSync` on Windows refuses
 * to execute a `.cmd`/`.bat` file unless `shell: true` is set, failing
 * instead with `EINVAL`
 * (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
 * `git` and `node` are native `.exe` binaries and are unaffected by this, so
 * only `npm`/`pnpm` invocations are routed through this wrapper; they still
 * run without a shell on POSIX, matching prior behavior exactly.
 */
function runSetupCliTool(command, args, options = {}) {
	if (process.platform === 'win32')
		return runSetup(command, args.map(quoteForWindowsShell), { ...options, shell: true })
	return runSetup(command, args, options)
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
		// ---- Obtain a tarball of the build output -------------------------------
		//
		// `EF_SMOKE_TARBALL` (an absolute path), when set, skips the internal
		// build+pack step and installs that tarball directly. CI packs once on
		// Node.js 24 and reuses the tarball across every OS/Node.js matrix leg.

		const suppliedTarballPath = process.env.EF_SMOKE_TARBALL
		let tarballPath

		if (suppliedTarballPath) {
			if (!isAbsolute(suppliedTarballPath))
				throw new Error(`EF_SMOKE_TARBALL must be an absolute path, got: ${suppliedTarballPath}`)
			if (!existsSync(suppliedTarballPath))
				throw new Error(`EF_SMOKE_TARBALL does not exist: ${suppliedTarballPath}`)
			tarballPath = suppliedTarballPath
		}
		else {
			runSetupCliTool(pnpm, ['pack', '--pack-destination', temporaryDirectory])

			const tarballName = readdirSync(temporaryDirectory)
				.find(fileName => fileName.endsWith('.tgz'))
			if (!tarballName)
				throw new Error('pnpm pack did not produce a tarball')
			tarballPath = join(temporaryDirectory, tarballName)
		}

		// ---- Install the tarball into a clean npm consumer project -------------

		const consumerDirectory = join(temporaryDirectory, 'consumer')
		mkdirSync(consumerDirectory)
		runSetupCliTool(npm, ['init', '--yes'], { cwd: consumerDirectory })
		runSetupCliTool(npm, ['install', tarballPath], { cwd: consumerDirectory })

		// The installed binary is a POSIX shell script plus a `.cmd` shim on
		// Windows (`node_modules/.bin/ef.cmd`); `spawnSync` with `shell: false`
		// cannot execute a `.cmd` shim directly (it is not a native executable),
		// so on Windows the CLI is invoked directly through Node.js against the
		// installed package's entry point instead. The shim file's existence is
		// still asserted so packaging regressions that drop the generated bin
		// shim are caught on every platform.

		const efBinaryName = process.platform === 'win32' ? 'ef.cmd' : 'ef'
		const efBinaryShim = join(consumerDirectory, 'node_modules', '.bin', efBinaryName)
		assert('installed ef binary exists', existsSync(efBinaryShim), `expected binary at ${efBinaryShim}`)

		const efEntryPoint = join(consumerDirectory, 'node_modules', '@deviltea', 'ef', 'dist', 'cli.mjs')
		const efBinary = process.platform === 'win32' ? process.execPath : efBinaryShim
		const efBinaryArgsPrefix = process.platform === 'win32' ? [efEntryPoint] : []

		/** Invokes the installed `ef` binary under test with the platform-appropriate launcher. */
		function runCli(args, options = {}) {
			return runEf(efBinary, [...efBinaryArgsPrefix, ...args], options)
		}

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
		{
			const brownfieldReference = join(installedSkillsDirectory, 'author-engineering-files', 'references', 'existing-project-bootstrap.md')
			assert('installed package ships the existing-project bootstrap reference', existsSync(brownfieldReference), `expected ${brownfieldReference}`)
		}

		// ---- (a) ef version --format json --------------------------------------

		{
			const result = runCli(['version', '--format', 'json'], { cwd: consumerDirectory })
			const stdoutText = result.stdout.toString('utf8')
			const newlineCount = (stdoutText.match(/\n/g) ?? []).length
			const isExactlyOneJsonLine = stdoutText.endsWith('\n') && newlineCount === 1
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('version: exit code', result.status, 0, describeCliResult(result))
			assert('version: stdout is exactly one JSON object plus one trailing LF', isExactlyOneJsonLine, `stdout=${JSON.stringify(stdoutText)}`)
			assert('version: stdout parses as JSON', parsed !== undefined, `stdout=${JSON.stringify(stdoutText)}`)
			assertEqual('version: schema', parsed?.schema, 'ef/version-result@1', describeCliResult(result))
			assertEqual('version: ef_core_major', parsed?.ef_core_major, 1, describeCliResult(result))
			assertEqual('version: version matches installed package.json', parsed?.version, installedPackageJson.version, describeCliResult(result))
		}

		// ---- (b) ef help ---------------------------------------------------------

		{
			const result = runCli(['help'], { cwd: consumerDirectory })
			assertEqual('help: exit code', result.status, 0, describeCliResult(result))
		}

		// ---- Temp Git repo for the project-mutation assertions ------------------

		const projectDirectory = join(temporaryDirectory, 'project')
		mkdirSync(projectDirectory)
		runSetup(git, ['init', '--initial-branch=main'], { cwd: projectDirectory })
		runSetup(git, ['config', 'user.email', 'ef-smoke@example.com'], { cwd: projectDirectory })
		runSetup(git, ['config', 'user.name', 'EF Smoke Test'], { cwd: projectDirectory })

		// ---- (c) ef init --------------------------------------------------------

		{
			const result = runCli([
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

			assertEqual('init: exit code', result.status, 0, describeCliResult(result))
			assert('init: parses as JSON', parsed !== undefined, describeCliResult(result))
			assertEqual('init: applied', parsed?.applied, true, describeCliResult(result))
			assert('init: .engineering/ef.yaml exists', existsSync(join(projectDirectory, '.engineering', 'ef.yaml')), describeCliResult(result))
		}

		// ---- (d) ef artifact create req ------------------------------------------

		{
			const result = runCli([
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

			assertEqual('artifact create req: exit code', result.status, 0, describeCliResult(result))
			assert('artifact create req: parses as JSON', parsed !== undefined, describeCliResult(result))
			assertEqual('artifact create req: applied', parsed?.applied, true, describeCliResult(result))
			assert('artifact create req: .engineering/req/REQ-001.md exists', existsSync(join(projectDirectory, '.engineering', 'req', 'REQ-001.md')), describeCliResult(result))
		}

		// ---- (e) ef validate --scope snapshot ------------------------------------

		{
			const result = runCli(['validate', '--scope', 'snapshot', '--format', 'json'], { cwd: projectDirectory })
			const parsed = parseJsonOrUndefined(result.stdout)

			assertEqual('validate snapshot: exit code', result.status, 0, describeCliResult(result))
			assert('validate snapshot: parses as JSON', parsed !== undefined, describeCliResult(result))
			assertEqual('validate snapshot: valid', parsed?.valid, true, describeCliResult(result))
		}

		// ---- (f) ef resource read failure (byte-level) ---------------------------

		{
			const result = runCli(['resource', 'read', 'REQ-999', 'x'], { cwd: projectDirectory })

			assertEqual('resource read failure: exit code', result.status, 2, describeCliResult(result))
			assertEqual('resource read failure: stdout byte length', result.stdout.length, 0, describeCliResult(result))
		}

		// ---- (g) unknown command --------------------------------------------------

		{
			const result = runCli(['nope', '--format', 'json'], { cwd: projectDirectory })

			assertEqual('unknown command: exit code', result.status, 2, describeCliResult(result))
			assertEqual('unknown command: stdout byte length', result.stdout.length, 0, describeCliResult(result))
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
