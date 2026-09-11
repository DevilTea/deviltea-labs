import { describe, expect, it } from 'vitest'
import { highestExitCode } from './exit'

describe('highestExitCode', () => {
	it('returns 0 for no arguments', () => {
		expect(highestExitCode())
			.toBe(0)
	})

	it('follows 3 > 2 > 1 > 0 regardless of argument order', () => {
		expect(highestExitCode(0, 1))
			.toBe(1)
		expect(highestExitCode(1, 2))
			.toBe(2)
		expect(highestExitCode(2, 3))
			.toBe(3)
		expect(highestExitCode(3, 2, 1, 0))
			.toBe(3)
		expect(highestExitCode(0, 0, 1, 0))
			.toBe(1)
	})

	it('returns the single supplied code unchanged', () => {
		expect(highestExitCode(2))
			.toBe(2)
	})
})
