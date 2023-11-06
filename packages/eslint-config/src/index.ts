import type { ConfigItem, OptionsConfig } from '@antfu/eslint-config'
import { antfu } from '@antfu/eslint-config'

type FactoryFn = typeof antfu

const MAX_COMPLEXITY = 15
const MAX_PARAMS = 3
const MAX_DEPTH = 3

const deviltea: FactoryFn = (options?, ...userConfigs) => {
	const mixedOptions: OptionsConfig & ConfigItem = {
		...options,
		stylistic: typeof options?.stylistic === 'boolean'
			? options.stylistic
			: {
					indent: 'tab',
					...options?.stylistic,
				},
		overrides: {
			...options?.overrides,
			javascript: {
				'complexity': ['error', MAX_COMPLEXITY],
				'max-params': ['error', MAX_PARAMS],
				'max-depth': ['error', MAX_DEPTH],
				'no-lonely-if': 'error',
				...options?.overrides?.javascript,
			},
			typescript: {
				'complexity': ['error', MAX_COMPLEXITY],
				'max-params': ['error', MAX_PARAMS],
				'max-depth': ['error', MAX_DEPTH],
				'no-lonely-if': 'error',
				...options?.overrides?.typescript,
			},
			vue: {
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
				...options?.overrides?.vue,
			},
		},
		rules: {
			'style/newline-per-chained-call': ['error', { ignoreChainWithDepth: 2 }],
			...options?.rules,
		},
	}

	return antfu(mixedOptions, ...userConfigs)
}

export default deviltea
