import { describe, expect, it } from 'vitest'
import { generateNonce } from './nonce'

describe('generateNonce', () => {
	it('returns a 32-character lowercase hexadecimal string (128-bit)', () => {
		const nonce = generateNonce()
		expect(nonce)
			.toMatch(/^[0-9a-f]{32}$/)
	})

	it('returns a different value on each call', () => {
		const first = generateNonce()
		const second = generateNonce()
		expect(first)
			.not.toBe(second)
	})

	it('never includes uppercase hexadecimal characters', () => {
		for (let i = 0; i < 20; i++) {
			const nonce = generateNonce()
			expect(nonce)
				.toBe(nonce.toLowerCase())
		}
	})
})
