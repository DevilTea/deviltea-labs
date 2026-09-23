#!/usr/bin/env node

import type { V1CliOutcome } from './v1/cli'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runV1Cli } from './v1/cli'

/** The installed spec executable exposes only the frozen-v1 resource-first CLI. */
export async function main(argv: readonly string[]): Promise<V1CliOutcome> {
	const chunks: string[] = []
	if (!process.stdin.isTTY && !argv.includes('--help') && !argv.includes('-h')) {
		for await (const chunk of process.stdin)
			chunks.push(String(chunk))
	}
	return runV1Cli(argv, { cwd: process.cwd(), stdin: chunks.join('') })
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
		.catch(() => {
			process.stderr.write(`${JSON.stringify({
				code: 'validation_failed',
				message: 'Spec operation failed.',
				details: {},
			})}\n`)
			process.exitCode = 1
		})
}
