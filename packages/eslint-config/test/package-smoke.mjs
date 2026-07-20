import { spawnSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			...options.env,
		},
		maxBuffer: 10 * 1024 * 1024,
	})

	if (result.status !== 0) {
		throw new Error([
			`Command failed: ${command} ${args.join(' ')}`,
			result.error?.message,
			result.stdout,
			result.stderr,
		].filter(Boolean)
			.join('\n'))
	}

	return result.stdout.trim()
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`)
}

function main() {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), 'deviltea-eslint-config-'))

	try {
		run(pnpm, ['pack', '--pack-destination', temporaryDirectory])

		const tarballName = readdirSync(temporaryDirectory)
			.find(fileName => fileName.endsWith('.tgz'))

		if (!tarballName) {
			throw new Error('pnpm pack did not produce a tarball')
		}

		const consumerDirectory = join(temporaryDirectory, 'consumer')
		const tarballUrl = pathToFileURL(join(temporaryDirectory, tarballName)).href
		const eslintVersion = process.env.ESLINT_VERSION ?? '^10.4.0'

		mkdirSync(consumerDirectory)

		writeJson(join(consumerDirectory, 'package.json'), {
			name: 'eslint-config-consumer-smoke',
			private: true,
			type: 'module',
			packageManager: 'pnpm@10.34.4',
			devDependencies: {
				'@deviltea/eslint-config': tarballUrl,
				'eslint': eslintVersion,
				'typescript': '~5.9.3',
			},
		})

		writeFileSync(join(consumerDirectory, 'eslint.config.mjs'), `import deviltea from '@deviltea/eslint-config'\n\nexport default deviltea()\n`)
		writeFileSync(join(consumerDirectory, 'fixture.js'), `export const answer = 42\n`)
		writeFileSync(join(consumerDirectory, 'fixture.ts'), `export function add(left: number, right: number): number {\n\treturn left + right\n}\n`)
		writeFileSync(join(consumerDirectory, 'SmokeFixture.vue'), `<script setup lang="ts">\nconst props = defineProps<{\n\ttitle: string\n}>()\n\nconst emit = defineEmits<{\n\tclose: []\n}>()\n</script>\n\n<template>\n\t<button\n\t\ttype="button"\n\t\t@click="emit('close')"\n\t>\n\t\t{{ props.title }}\n\t</button>\n</template>\n`)
		writeFileSync(join(consumerDirectory, 'typecheck.ts'), `import deviltea from '@deviltea/eslint-config'\n\nconst config = deviltea({\n\ttypescript: {\n\t\toverridesTypeAware: {\n\t\t\t'ts/no-floating-promises': 'error',\n\t\t},\n\t\ttsconfigPath: './tsconfig.json',\n\t},\n\tvue: {\n\t\tvueVersion: 3,\n\t},\n})\n\nconfig.prepend({ name: 'consumer/prepend' })\n`)
		writeJson(join(consumerDirectory, 'tsconfig.json'), {
			compilerOptions: {
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				noEmit: true,
				skipLibCheck: true,
				strict: true,
			},
			include: ['typecheck.ts'],
		})

		run(pnpm, ['install', '--ignore-scripts', '--strict-peer-dependencies'], {
			cwd: consumerDirectory,
		})
		run(process.execPath, [
			'--input-type=module',
			'--eval',
			`import deviltea from '@deviltea/eslint-config'; const config = deviltea(); if (!config) process.exit(1)`,
		], {
			cwd: consumerDirectory,
		})
		run(pnpm, ['exec', 'tsc', '--noEmit'], {
			cwd: consumerDirectory,
		})
		run(pnpm, ['exec', 'eslint', 'fixture.js', 'fixture.ts', 'SmokeFixture.vue'], {
			cwd: consumerDirectory,
		})
	}
	finally {
		rmSync(temporaryDirectory, { force: true, recursive: true })
	}
}

main()
