import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		// Both suites must exercise the instrumented source, not an old dist build.
		alias: {
			'@deviltea/tiny-state-machine': fileURLToPath(new URL('./packages/tiny-state-machine/src/index.ts', import.meta.url)),
		},
	},
	test: {
		include: [
			'packages/tiny-state-machine/src/**/*.unit.test.ts',
			'packages/tiny-state-machine-vue/src/**/*.unit.test.ts',
		],
	},
})
