import { describe, expect, it } from 'vitest'
import { classifyMutationAuthorization } from './mutation-authorization'

describe('classifyMutationAuthorization', () => {
	it('is dry-run whenever --dry-run is set, regardless of --yes or --no-input', () => {
		expect(classifyMutationAuthorization({ dryRun: true, yes: false, noInput: false }))
			.toBe('dry-run')
		expect(classifyMutationAuthorization({ dryRun: true, yes: true, noInput: true }))
			.toBe('dry-run')
	})

	it('is direct when --yes is set without --dry-run', () => {
		expect(classifyMutationAuthorization({ dryRun: false, yes: true, noInput: false }))
			.toBe('direct')
		expect(classifyMutationAuthorization({ dryRun: false, yes: true, noInput: true }))
			.toBe('direct')
	})

	it('is missing-authorization when neither --dry-run nor --yes is set and prompts are forbidden', () => {
		expect(classifyMutationAuthorization({ dryRun: false, yes: false, noInput: true }))
			.toBe('missing-authorization')
	})

	it('is needs-confirmation only when interactive input is available and no flag was supplied', () => {
		expect(classifyMutationAuthorization({ dryRun: false, yes: false, noInput: false }))
			.toBe('needs-confirmation')
	})
})
