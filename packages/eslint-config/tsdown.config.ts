import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	clean: true,
	dts: true,
	publint: true,
	deps: {
		// Keep dependency types as external imports in the emitted dts.
		// tsdown >=0.22 tries to bundle them and chokes on transitive
		// CommonJS dts (e.g. @eslint/config-helpers, typescript itself).
		neverBundle: [/^@antfu\//, /^@eslint\//, /^@typescript-eslint\//, 'eslint', 'typescript'],
	},
})
