/* eslint-disable complexity */
import type { OptionsConfig, TypedFlatConfigItem } from '@antfu/eslint-config'
import { antfu } from '@antfu/eslint-config'

type FactoryFn = typeof antfu

const deviltea: FactoryFn = (options?, ...userConfigs) => {
	const mixedOptions: OptionsConfig & TypedFlatConfigItem = {
		...options,
		stylistic: typeof options?.stylistic === 'boolean'
			? options.stylistic
			: {
					indent: 'tab',
					...options?.stylistic,
					overrides: {
						'style/newline-per-chained-call': ['error', { ignoreChainWithDepth: 2 }],
						...options?.stylistic?.overrides,
					},
				},

		javascript: typeof options?.javascript === 'boolean'
			? options.javascript
			: {
					overrides: {
						'no-lonely-if': 'error',
						...options?.javascript?.overrides,
					},
				},

		typescript: typeof options?.typescript === 'boolean'
			? options.typescript
			: {
					overrides: {
						'no-lonely-if': 'error',
						...options?.typescript?.overrides,
					},
				},

		vue: typeof options?.vue === 'boolean'
			? options.vue
			: {
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
						...options?.vue?.overrides,
					},
				},
	}

	return antfu(mixedOptions, ...userConfigs)
}

export default deviltea
