/**
 * `ef version` (13-cli-contract.md "Version and Help").
 */

import type { CommandOutcome } from '../command-outcome'
import { buildVersionResultJson } from '../envelopes'
import { renderVersionHuman } from '../human-render'

export interface VersionCommandInput {
	format: 'human' | 'json'
	version: string
}

export function runVersionCommand(input: VersionCommandInput): CommandOutcome {
	if (input.format === 'json') {
		return { exitCode: 0, stdout: `${JSON.stringify(buildVersionResultJson(input.version))}\n`, stderr: '' }
	}
	return { exitCode: 0, stdout: renderVersionHuman(input.version), stderr: '' }
}
