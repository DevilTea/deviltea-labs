import Vue from 'unplugin-vue/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [Vue()],
	test: {
		coverage: {
			all: true,
			enabled: true,
			exclude: ['src/**/*.unit.test.ts'],
			include: ['src/**/*.{ts,vue}'],
			reporter: ['text', 'json', 'html'],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		typecheck: {
			enabled: true,
			tsconfig: './tsconfig.lib.json',
		},
	},
})
