import Vue from 'unplugin-vue/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [Vue()],
	test: {
		include: ['packages/**/src/**/*.unit.test.ts'],
		coverage: {
			enabled: true,
			provider: 'v8',
			// Keep the report scoped to published runtime source. tsconfig is a JSON
			// configuration product and is covered by consumer contracts instead.
			include: [
				'packages/ef/src/**/*.ts',
				'packages/eslint-config/src/**/*.ts',
				'packages/tiny-state-machine/src/**/*.ts',
				'packages/tiny-state-machine-vue/src/**/*.ts',
				'packages/vue-router-middleware/src/**/*.ts',
				'packages/vue-temp-var/src/**/*.ts',
				'packages/vue-temp-var/src/**/*.vue',
			],
			exclude: [
				'**/*.unit.test.ts',
				'**/dist/**',
				'packages/tsconfig/**',
			],
			excludeAfterRemap: true,
			// CI/agent environments default the text reporter to skip complete files.
			// Keep them visible so this is a per-package report, not just a summary.
			reporter: [
				['text', { skipFull: false }],
				'html',
				'clover',
				'json',
			],
			thresholds: {
				branches: 90,
				functions: 90,
				lines: 90,
				statements: 90,
			},
		},
		typecheck: {
			enabled: true,
		},
	},
})
