module.exports = {
  root: true,
  extends: ['@antfu'],
  rules: {
    // vue
    'vue/component-tags-order': [
      'error',
      { order: ['template', 'script[setup]', 'script:not([setup])', 'style'] },
    ],
    // js / ts
    '@typescript-eslint/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    '@typescript-eslint/space-before-function-paren': ['error', 'always'],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    'arrow-parens': ['error', 'always'],
  },
  overrides: [
    {
      files: ['*.vue'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
}
