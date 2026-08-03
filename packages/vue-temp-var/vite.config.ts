import { fileURLToPath, URL } from 'node:url'
import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import Dts from 'vite-plugin-dts'

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		Vue(),
		Dts({
			tsconfigPath: './tsconfig.lib.json',
			entryRoot: 'src',
			copyDtsFiles: true,
		}),
	],
	build: {
		lib: {
			name: 'VueTempVar',
			entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
			formats: ['es'],
		},
		rollupOptions: {
			external: ['vue'],
		},
	},
})
