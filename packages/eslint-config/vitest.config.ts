import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/**/*.unit.test.ts'],
		coverage: {
			include: ['src/index.ts'],
			reporter: ['text', 'json-summary', 'html'],
			skipFull: false,
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
	},
})
