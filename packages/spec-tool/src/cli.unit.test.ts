import fs from 'node:fs/promises'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { main } from './cli'

describe('main', () => {
	it('resolves this package\'s own real version for ef version --format json', async () => {
		const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

		const outcome = await main(['version', '--format', 'json'])

		expect(outcome.exitCode)
			.toBe(0)
		expect(JSON.parse(outcome.stdout as string))
			.toEqual({ schema: 'ef/version-result@1', version: packageJson.version, ef_core_major: 1 })
	})

	it('returns exit 2 with empty stdout for an unknown command, without calling process.exit itself', async () => {
		const exitSpy = process.exit
		let exitCalled = false
		process.exit = (() => {
			exitCalled = true
			return undefined as never
		}) as typeof process.exit

		try {
			const outcome = await main(['bogus'])
			expect(outcome.exitCode)
				.toBe(2)
			expect(outcome.stdout)
				.toBe('')
			expect(exitCalled)
				.toBe(false)
		}
		finally {
			process.exit = exitSpy
		}
	})
})
