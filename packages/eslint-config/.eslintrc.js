module.exports = {
  root: true,
  extends: ['@antfu'],
  rules: {
    // vue
    'vue/block-order': [
      'error',
      {
        order: [
          'script[setup]',
          'template',
          'style:not([scoped])',
          'style[scoped]',
        ],
      },
    ],
    'vue/component-api-style': ['error', ['script-setup']],
    // js / ts
    '@typescript-eslint/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    '@typescript-eslint/space-before-function-paren': ['error', 'always'],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    'arrow-parens': ['error', 'always'],
    'sort-imports': ['off'],
  },
}
