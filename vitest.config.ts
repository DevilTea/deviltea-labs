import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['packages/tiny-state-machine*/tests/**/*.test.ts'],
		coverage: {
			enabled: true,
			include: ['packages/tiny-state-machine*/src/**/*.ts'],
		},
		typecheck: {
			enabled: true,
		},
	},
})
