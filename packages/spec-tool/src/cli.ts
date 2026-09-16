#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runCli } from './cli/program'

function readPackageVersion(): string {
	try {
		const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
		return packageJson.version ?? '0.0.0'
	}
	catch {
		return '0.0.0'
	}
}

export async function main(argv: readonly string[]): Promise<{ exitCode: number, stdout: string, stderr: string }> {
	return runCli(argv, { cwd: process.cwd() }, { version: readPackageVersion() })
}

function isDirectExecution(): boolean {
	if (!process.argv[1])
		return false
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
	}
	catch {
		return false
	}
}

if (isDirectExecution()) {
	main(process.argv.slice(2))
		.then((outcome) => {
			if (outcome.stdout)
				process.stdout.write(outcome.stdout)
			if (outcome.stderr)
				process.stderr.write(outcome.stderr)
			process.exitCode = outcome.exitCode
		})
		.catch((error: unknown) => {
			process.stderr.write(`Internal CLI failure: ${(error as Error).message}\n`)
			process.exitCode = 3
		})
}
