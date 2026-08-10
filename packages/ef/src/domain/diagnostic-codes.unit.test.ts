import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CODES, severityOf } from './diagnostic-codes'

describe('dIAGNOSTIC_CODES', () => {
	it('registers EF-VAL-013 as an error, matching diagnostic-registry.md', () => {
		expect(DIAGNOSTIC_CODES['EF-VAL-013'])
			.toBe('error')
	})

	it('registers EF-VAL-014 as an info diagnostic, matching diagnostic-registry.md', () => {
		expect(DIAGNOSTIC_CODES['EF-VAL-014'])
			.toBe('info')
	})

	it('does not (re)assign the reserved EF-VAL-003 slot', () => {
		expect(Object.hasOwn(DIAGNOSTIC_CODES, 'EF-VAL-003'))
			.toBe(false)
	})
})

describe('severityOf', () => {
	it('returns the registered severity for the new range-validation codes', () => {
		expect(severityOf('EF-VAL-013'))
			.toBe('error')
		expect(severityOf('EF-VAL-014'))
			.toBe('info')
	})
})
