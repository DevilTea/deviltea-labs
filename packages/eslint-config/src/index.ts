import type { ConfigItem, OptionsConfig } from '@antfu/eslint-config'
import { antfu } from '@antfu/eslint-config'

type FactoryFn = typeof antfu

const MAX_COMPLEXITY = 15
const MAX_PARAMS = 3

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
				'no-magic-numbers': 'error',
				'complexity': ['error', MAX_COMPLEXITY],
				'max-params': ['error', MAX_PARAMS],
				'no-lonely-if': 'error',
				...options?.overrides?.javascript,
			},
			typescript: {
				'no-magic-numbers': 'off',
				'ts/no-magic-numbers': 'error',
				'complexity': ['error', MAX_COMPLEXITY],
				'max-params': ['error', MAX_PARAMS],
				'no-lonely-if': 'error',
				...options?.overrides?.typescript,
			},
			vue: {
				'vue/attribute-hyphenation': ['error', 'never'],
				...options?.overrides?.vue,
			},
		},
		rules: {
			'style/max-len': ['error', { code: 120 }],
			'style/newline-per-chained-call': ['error', { ignoreChainWithDepth: 2 }],
			...options?.rules,
		},
	}

	return antfu(mixedOptions, ...userConfigs)
}

export default deviltea
