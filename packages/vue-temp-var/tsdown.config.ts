import { defineConfig } from 'tsdown'
import Vue from 'unplugin-vue/rolldown'

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	dts: {
		vue: true,
		tsconfig: './tsconfig.lib.json',
	},
	clean: true,
	publint: true,
	plugins: [Vue({ isProduction: true })],
	deps: {
		neverBundle: ['vue'],
	},
})
