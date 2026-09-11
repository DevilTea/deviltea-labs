import { describe, expect, it } from 'vitest'
import { runVersionCommand } from './version'

describe('runVersionCommand', () => {
	it('produces exactly one UTF-8 JSON object followed by one LF in JSON mode', () => {
		const outcome = runVersionCommand({ format: 'json', version: '1.2.3' })
		expect(outcome.exitCode)
			.toBe(0)
		expect(outcome.stdout)
			.toBe('{"schema":"ef/version-result@1","version":"1.2.3","ef_core_major":1}\n')
		expect(outcome.stderr)
			.toBe('')
	})

	it('produces human-readable text mentioning the version in human mode', () => {
		const outcome = runVersionCommand({ format: 'human', version: '1.2.3' })
		expect(outcome.exitCode)
			.toBe(0)
		expect(outcome.stdout)
			.toContain('1.2.3')
		expect(outcome.stderr)
			.toBe('')
	})
})
