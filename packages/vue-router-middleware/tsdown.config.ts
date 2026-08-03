import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	dts: {
		tsconfig: './tsconfig.lib.json',
	},
	clean: true,
	publint: true,
	deps: {
		neverBundle: ['vue', 'vue-router'],
	},
})
