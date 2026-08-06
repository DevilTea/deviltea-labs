import { describe, expect, it } from 'vitest'
import { runCli } from './index'

describe('cli barrel', () => {
	it('re-exports runCli as a callable function', () => {
		expect(typeof runCli)
			.toBe('function')
	})

	it('runCli rejects an unknown command with exit 2 and empty stdout, exercised through the barrel export', async () => {
		const outcome = await runCli(['bogus'], { cwd: process.cwd() }, { version: '0.0.0' })
		expect(outcome.exitCode)
			.toBe(2)
		expect(outcome.stdout)
			.toBe('')
	})
})
