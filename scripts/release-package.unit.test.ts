import { describe, expect, it } from 'vitest'
import { assertFsmVersions, assertReleaseTagAllowed, assertWorkspaceVersions, packageEntry, packageIds, packageTag, packageVersion, releaseMembers, releaseVersion, verifyTag } from './release-package'

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

describe('fSM lockstep releases', () => {
	it('keeps one release ID and orders core before Vue', () => {
		expect(releaseMembers('tiny-state-machine'))
			.toEqual(['tiny-state-machine', 'tiny-state-machine-vue'])
		expect(packageIds).not.toContain('tiny-state-machine-vue')
		expect(packageEntry('tiny-state-machine').directory)
			.toBe('packages/tiny-state-machine/core')
		expect(packageEntry('tiny-state-machine-vue').directory)
			.toBe('packages/tiny-state-machine/vue')
		expect(releaseMembers('eslint-config'))
			.toEqual(['eslint-config'])
		expect(() => releaseMembers('constructor'))
			.toThrow('Unknown release package')
	})
	it('rejects independent Vue release and tags', () => {
		expect(() => releaseVersion('tiny-state-machine-vue'))
			.toThrow('Release the FSM family together')
		expect(() => verifyTag('tiny-state-machine-vue@0.0.5'))
			.toThrow('Release the FSM family together')
		expect(() => assertReleaseTagAllowed('tiny-state-machine-vue', '0.0.6'))
			.toThrow('Release the FSM family together')
	})
	it('rejects a diverging manifest version or non-exact peer', () => {
		expect(() => assertFsmVersions('0.0.6', '0.0.5', 'workspace:*'))
			.toThrow('FSM versions must match')
		expect(() => assertFsmVersions('0.0.5', '0.0.5', 'workspace:^'))
			.toThrow('FSM Vue core peer must be workspace:*')
		expect(() => assertFsmVersions('0.0.5', '0.0.5', undefined))
			.toThrow('FSM Vue core peer must be workspace:*')
		expect(() => assertFsmVersions('0.0.5', '0.0.5', 'workspace:*')).not.toThrow()
	})
	it('checks the actual manifests and shared release tag', () => {
		expect(() => assertWorkspaceVersions()).not.toThrow()
		const version = releaseVersion('tiny-state-machine')
		expect(packageVersion('tiny-state-machine-vue'))
			.toBe(version)
		expect(verifyTag(packageTag('tiny-state-machine')))
			.toBe('tiny-state-machine')
		expect(() => verifyTag('tiny-state-machine@0.0.0'))
			.toThrow('does not match')
	})
})
