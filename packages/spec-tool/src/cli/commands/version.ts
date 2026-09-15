import type { CommandOutcome } from '../command-outcome'

export function runVersionCommand(version: string, format: 'human' | 'json'): CommandOutcome {
	if (format === 'json')
		return { exitCode: 0, stdout: `${JSON.stringify({ schema: 'spec/version-result@1', version })}\n`, stderr: '' }
	return { exitCode: 0, stdout: `${version}\n`, stderr: '' }
}
