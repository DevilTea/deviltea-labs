import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/cli.ts', 'src/index.ts'],
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	dts: {
		tsconfig: './tsconfig.package.json',
	},
	clean: true,
	publint: true,
})
