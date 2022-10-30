module.exports = {
  root: true,
  extends: ['@antfu'],
  rules: {
    // vue
    'vue/component-tags-order': [
      'error',
      {
        order: [
          'template',
          'script:not([setup])',
          'script[setup]',
          'style:not([scoped])',
          'style[scoped]',
        ],
      },
    ],
    // js / ts
    '@typescript-eslint/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    '@typescript-eslint/space-before-function-paren': ['error', 'always'],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    'arrow-parens': ['error', 'always'],
    'sort-imports': ['off'],
    // import
    'import/first': ['off'],
    'import/no-duplicates': ['off'],
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
