module.exports = {
  root: true,
  extends: ['@antfu'],
  rules: {
    'vue/component-tags-order': [
      'error',
      { order: ['template', 'script[setup]', 'script:not([setup])', 'style'] },
    ],
    '@typescript-eslint/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    'curly': ['error', 'multi-line', 'consistent'],
  },
}
