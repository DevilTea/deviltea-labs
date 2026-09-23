import { describe, expect, it } from 'vitest'
import { assertReleaseTagAllowed, packageTag, packageVersion, verifyTag } from './release-package'

describe('release package policy', () => {
	it('keeps the Spec Tool 0.0.1 bootstrap untagged', () => {
		expect(() => assertReleaseTagAllowed('spec-tool', '0.0.1'))
			.toThrow('spec-tool@0.0.1 is the manual, untagged bootstrap release')
		expect(() => verifyTag('spec-tool@0.0.1'))
			.toThrow()
	})

	it('accepts the current Spec Tool version after the bootstrap', () => {
		const version = packageVersion('spec-tool')
		if (version === '0.0.1') {
			expect(() => packageTag('spec-tool'))
				.toThrow('spec-tool@0.0.1 is the manual, untagged bootstrap release')
		}
		else {
			expect(packageTag('spec-tool'))
				.toBe(`spec-tool@${version}`)
			expect(verifyTag(`spec-tool@${version}`))
				.toBe('spec-tool')
		}
	})

	it('allows normal tagged releases', () => {
		expect(() => assertReleaseTagAllowed('spec-tool', '0.0.2'))
			.not.toThrow()
		expect(() => assertReleaseTagAllowed('eslint-config', '9.0.1'))
			.not.toThrow()
	})
})
