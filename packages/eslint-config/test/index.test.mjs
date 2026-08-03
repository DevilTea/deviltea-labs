import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
// This package intentionally uses Node's built-in runner to avoid a test framework dependency.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const callsKey = Symbol.for('@deviltea/eslint-config/test/calls')
const mockModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`
const callsKey = Symbol.for('@deviltea/eslint-config/test/calls')

export function antfu(...args) {
	globalThis[callsKey].push(args)
	return args
}
`)}`

globalThis[callsKey] = []

const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '@antfu/eslint-config') {
			return {
				format: 'module',
				shortCircuit: true,
				url: mockModuleUrl,
			}
		}

		return nextResolve(specifier, context)
	},
})

const { default: deviltea } = await import('../dist/index.mjs')

hooks.deregister()

function takeCall() {
	const call = globalThis[callsKey].shift()
	assert.ok(call, 'expected antfu() to be called')
	return call
}

test('applies the default custom rules', () => {
	deviltea()

	const [options] = takeCall()

	assert.equal(options.stylistic.indent, 'tab')
	assert.deepEqual(
		options.stylistic.overrides['style/newline-per-chained-call'],
		['error', { ignoreChainWithDepth: 1 }],
	)
	assert.equal(options.stylistic.overrides['antfu/consistent-chaining'], 'off')
	assert.equal(options.javascript.overrides['no-lonely-if'], 'error')
	assert.equal(options.typescript.overrides['no-lonely-if'], 'error')
	assert.deepEqual(options.vue.overrides['vue/component-api-style'], ['error', ['script-setup', 'composition']])
})

test('preserves nested options and lets user overrides win', () => {
	deviltea({
		stylistic: {
			indent: 2,
			quotes: 'double',
			overrides: {
				'style/newline-per-chained-call': 'warn',
			},
		},
		javascript: {
			files: ['**/*.cjs'],
			overrides: {
				'no-lonely-if': 'off',
			},
		},
		typescript: {
			erasableOnly: true,
			filesTypeAware: ['**/*.ts'],
			overrides: {
				'no-lonely-if': 'warn',
			},
			overridesTypeAware: {
				'ts/no-floating-promises': 'error',
			},
			tsconfigPath: './tsconfig.json',
		},
		vue: {
			a11y: true,
			overrides: {
				'vue/attribute-hyphenation': 'off',
			},
			vueVersion: 2,
		},
	})

	const [options] = takeCall()

	assert.equal(options.stylistic.indent, 2)
	assert.equal(options.stylistic.quotes, 'double')
	assert.equal(options.stylistic.overrides['style/newline-per-chained-call'], 'warn')
	assert.deepEqual(options.javascript.files, ['**/*.cjs'])
	assert.equal(options.javascript.overrides['no-lonely-if'], 'off')
	assert.equal(options.typescript.tsconfigPath, './tsconfig.json')
	assert.equal(options.typescript.erasableOnly, true)
	assert.deepEqual(options.typescript.filesTypeAware, ['**/*.ts'])
	assert.equal(options.typescript.overridesTypeAware['ts/no-floating-promises'], 'error')
	assert.equal(options.typescript.overrides['no-lonely-if'], 'warn')
	assert.equal(options.vue.vueVersion, 2)
	assert.equal(options.vue.a11y, true)
	assert.equal(options.vue.overrides['vue/attribute-hyphenation'], 'off')
})

test('forwards boolean options and user configs unchanged', () => {
	const userConfig = {
		name: 'user/config',
		rules: {
			eqeqeq: 'error',
		},
	}

	const result = deviltea(
		{
			javascript: false,
			stylistic: false,
			typescript: false,
			vue: false,
		},
		userConfig,
	)

	const [options, forwardedUserConfig] = takeCall()

	assert.equal(options.javascript, false)
	assert.equal(options.stylistic, false)
	assert.equal(options.typescript, false)
	assert.equal(options.vue, false)
	assert.strictEqual(forwardedUserConfig, userConfig)
	assert.strictEqual(result[1], userConfig)
})
