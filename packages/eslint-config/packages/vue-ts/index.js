const vueBase = require('@deviltea/eslint-config-vue')

module.exports = {
  ...vueBase,
  extends: [
    '@deviltea/eslint-config-vue',
    '@deviltea/eslint-config-ts',
  ],
  rules: {
    ...vueBase.rules,
    'vue/block-lang': ['error', { script: { lang: 'ts' } }],
    'vue/component-api-style': ['error', ['script-setup', 'composition']],
  },
  overrides: [
    {
      ...vueBase.overrides[0],
      parser: 'vue-eslint-parser',
      parserOptions: {
        parser: '@typescript-eslint/parser',
      },
      rules: {
        ...vueBase.overrides[0].rules,
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
}
