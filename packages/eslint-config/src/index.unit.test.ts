import { beforeEach, describe, expect, it, vi } from 'vitest'

const { antfu, factoryReturn } = vi.hoisted(() => {
	const factoryReturn = Symbol('antfu factory return')

	return {
		antfu: vi.fn(() => factoryReturn),
		factoryReturn,
	}
})

vi.mock('@antfu/eslint-config', () => ({ antfu }))

const { default: deviltea } = await import('./index')

const defaultOptions = {
	stylistic: {
		indent: 'tab',
		overrides: {
			'style/newline-per-chained-call': ['error', { ignoreChainWithDepth: 1 }],
			'antfu/consistent-chaining': 'off',
		},
	},
	javascript: {
		overrides: {
			'no-lonely-if': 'error',
		},
	},
	typescript: {
		overrides: {
			'no-lonely-if': 'error',
		},
	},
	vue: {
		overrides: {
			'vue/attribute-hyphenation': ['error', 'never'],
			'vue/v-on-event-hyphenation': ['error', 'never'],
			'vue/max-attributes-per-line': ['error', { singleline: { max: 1 }, multiline: { max: 1 } }],
			'vue/component-api-style': ['error', ['script-setup', 'composition']],
			'vue/define-emits-declaration': ['error', 'type-based'],
			'vue/define-props-declaration': ['error', 'type-based'],
			'vue/no-template-target-blank': 'error',
			'vue/prefer-define-options': 'error',
			'vue/require-macro-variable-name': ['error', { defineProps: 'props', defineEmits: 'emit', defineSlots: 'slots', useSlots: 'slots', useAttrs: 'attrs' }],
			'vue/valid-define-options': 'error',
			'vue/component-name-in-template-casing': ['error', 'PascalCase', { registeredComponentsOnly: false }],
		},
	},
}

type CapturedOptions = Record<string, unknown> & {
	stylistic: Record<string, unknown>
	javascript: Record<string, unknown>
	typescript: Record<string, unknown>
	vue: Record<string, unknown>
}

function capturedOptions(): CapturedOptions {
	return antfu.mock.calls[0]?.[0] as CapturedOptions
}

describe('@deviltea/eslint-config', () => {
	beforeEach(() => {
		antfu.mockClear()
	})

	it('passes the exact default policy to antfu and returns its value unchanged', () => {
		const result = deviltea()

		expect(antfu)
			.toHaveBeenCalledTimes(1)
		expect(antfu)
			.toHaveBeenCalledWith(defaultOptions)
		expect(result)
			.toBe(factoryReturn)
	})

	it('treats explicit undefined feature options as omitted and applies every default', () => {
		deviltea({ stylistic: undefined, javascript: undefined, typescript: undefined, vue: undefined })

		expect(antfu)
			.toHaveBeenCalledWith(defaultOptions)
	})

	it.each([
		['stylistic', true],
		['stylistic', false],
		['javascript', true],
		['javascript', false],
		['typescript', true],
		['typescript', false],
		['vue', true],
		['vue', false],
	] as const)('passes %s: %s through unchanged', (feature, enabled) => {
		deviltea({ [feature]: enabled } as never)

		expect(capturedOptions()[feature])
			.toBe(enabled)
	})

	it('merges every feature object, lets users disable defaults, and retains unrelated rules', () => {
		deviltea({
			stylistic: {
				indent: 2,
				quotes: 'double',
				overrides: {
					'style/newline-per-chained-call': 'off',
					'style/user-rule': 'warn',
				},
			},
			javascript: {
				files: ['**/*.cjs'],
				overrides: {
					'no-lonely-if': 'off',
					'no-alert': 'warn',
				},
			},
			typescript: {
				erasableOnly: true,
				filesTypeAware: ['**/*.ts'],
				overrides: {
					'no-lonely-if': 'off',
					'ts/user-rule': 'error',
				},
				overridesTypeAware: { 'ts/no-floating-promises': 'error' },
				tsconfigPath: './tsconfig.json',
			},
			vue: {
				a11y: true,
				vueVersion: 2,
				overrides: {
					'vue/attribute-hyphenation': 'off',
					'vue/user-rule': 'warn',
				},
			},
		} as never)

		expect(capturedOptions())
			.toEqual({
				stylistic: {
					indent: 2,
					quotes: 'double',
					overrides: {
						'style/newline-per-chained-call': 'off',
						'antfu/consistent-chaining': 'off',
						'style/user-rule': 'warn',
					},
				},
				javascript: {
					files: ['**/*.cjs'],
					overrides: {
						'no-lonely-if': 'off',
						'no-alert': 'warn',
					},
				},
				typescript: {
					erasableOnly: true,
					filesTypeAware: ['**/*.ts'],
					overrides: {
						'no-lonely-if': 'off',
						'ts/user-rule': 'error',
					},
					overridesTypeAware: { 'ts/no-floating-promises': 'error' },
					tsconfigPath: './tsconfig.json',
				},
				vue: {
					a11y: true,
					vueVersion: 2,
					overrides: {
						'vue/attribute-hyphenation': 'off',
						'vue/v-on-event-hyphenation': ['error', 'never'],
						'vue/max-attributes-per-line': ['error', { singleline: { max: 1 }, multiline: { max: 1 } }],
						'vue/component-api-style': ['error', ['script-setup', 'composition']],
						'vue/define-emits-declaration': ['error', 'type-based'],
						'vue/define-props-declaration': ['error', 'type-based'],
						'vue/no-template-target-blank': 'error',
						'vue/prefer-define-options': 'error',
						'vue/require-macro-variable-name': ['error', { defineProps: 'props', defineEmits: 'emit', defineSlots: 'slots', useSlots: 'slots', useAttrs: 'attrs' }],
						'vue/valid-define-options': 'error',
						'vue/component-name-in-template-casing': ['error', 'PascalCase', { registeredComponentsOnly: false }],
						'vue/user-rule': 'warn',
					},
				},
			})
	})

	it('preserves unrelated top-level values and nested object identity', () => {
		const componentExts = ['svelte']
		const ignores = ['coverage/**']
		const options = {
			componentExts,
			ignores,
			name: 'deviltea/custom-config',
			type: 'lib',
		} as const

		deviltea(options)

		const captured = capturedOptions()
		expect(captured)
			.toMatchObject({ name: 'deviltea/custom-config', type: 'lib' })
		expect(captured.componentExts)
			.toBe(componentExts)
		expect(captured.ignores)
			.toBe(ignores)
	})

	it('forwards zero or many user configs in exact order and by identity', () => {
		const firstUserConfig = { name: 'user/first', rules: { eqeqeq: 'error' } }
		const secondUserConfig = { name: 'user/second', ignores: ['generated/**'] }

		deviltea(undefined, firstUserConfig, secondUserConfig)

		expect(antfu)
			.toHaveBeenCalledWith(defaultOptions, firstUserConfig, secondUserConfig)
		expect(antfu.mock.calls[0]?.[1])
			.toBe(firstUserConfig)
		expect(antfu.mock.calls[0]?.[2])
			.toBe(secondUserConfig)
	})
})
