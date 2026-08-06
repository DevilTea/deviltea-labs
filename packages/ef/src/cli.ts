#!/usr/bin/env node
/**
 * The `ef` CLI entry point (13-cli-contract.md; 00-implementation-decisions.md
 * "The four Core exit codes are mapped only at the CLI boundary").
 *
 * This is the ONLY place `process.exit()` is called. `./cli/program.ts`'s
 * `runCli` does every argument parse, command dispatch, and exit-code
 * decision and returns a plain `CommandOutcome`; this file only writes that
 * result's bytes to the real process streams and terminates with its exit
 * code.
 *
 * The version reported by `ef version` is read from this package's own
 * `package.json`, resolved relative to *this* file's `import.meta.url`. This
 * only works reliably because `src/cli.ts` sits exactly one directory below
 * the package root in source, and `tsdown` builds it to `dist/cli.mjs`,
 * which also sits exactly one directory below the package root -- so
 * `../package.json` resolves correctly in both the unbundled (dev/test) and
 * bundled (published) forms. No other file in this package may assume that
 * same depth relationship after bundling.
 */

import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runCli } from './cli/program'

function readPackageVersion(): string {
	try {
		const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
		const raw = readFileSync(packageJsonPath, 'utf8')
		const parsed = JSON.parse(raw) as { version?: string }
		return parsed.version ?? '0.0.0'
	}
	catch {
		return '0.0.0'
	}
}

/** Exported for `src/cli.unit.test.ts`; performs no process-global side effects itself. */
export async function main(argv: readonly string[]): Promise<{ exitCode: number, stdout: string | Uint8Array, stderr: string }> {
	return runCli(argv, { cwd: process.cwd() }, { version: readPackageVersion() })
}

// npm/pnpm expose `bin` entries as symlinks under node_modules/.bin, so
// `process.argv[1]` keeps the symlink path while the ESM loader resolves
// `import.meta.url` to the realpath -- both sides must be realpath-compared.
function isSamePath(argvPath: string): boolean {
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath)
	}
	catch {
		return false
	}
}

const isDirectlyExecuted = process.argv[1] != null && isSamePath(process.argv[1])

if (isDirectlyExecuted) {
	main(process.argv.slice(2))
		.then((outcome) => {
			if (outcome.stdout.length > 0)
				process.stdout.write(outcome.stdout)
			if (outcome.stderr.length > 0)
				process.stderr.write(outcome.stderr)
			process.exit(outcome.exitCode)
		})
		.catch((error: unknown) => {
			process.stderr.write(`Internal CLI failure: ${(error as Error).message}\n`)
			process.exit(3)
		})
}
