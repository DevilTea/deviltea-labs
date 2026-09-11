import { describe, expect, it } from 'vitest'
import { noLibraryApi } from './index'

describe('noLibraryApi', () => {
	it('is an empty object: EF v1 exposes no supported JavaScript library API', () => {
		expect(noLibraryApi)
			.toEqual({})
	})
})
