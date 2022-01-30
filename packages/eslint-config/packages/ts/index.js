const base = require('@deviltea/eslint-config-base')

module.exports = {
  extends: [
    '@deviltea/eslint-config-base',
    'plugin:@typescript-eslint/recommended',
    'airbnb-typescript/base',
  ],
  rules: {
    // TS
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
    '@typescript-eslint/member-delimiter-style': ['error', { multiline: { delimiter: 'none' } }],
    '@typescript-eslint/type-annotation-spacing': ['error', {}],
    '@typescript-eslint/consistent-type-imports': ['error', {
      prefer: 'type-imports',
      disallowTypeAnnotations: false,
    }],
    '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],
    '@typescript-eslint/prefer-ts-expect-error': 'error',

    // override js rules
    semi: 'off',
    '@typescript-eslint/semi': ['error', 'never'],

    'no-unused-expressions': 'off',
    '@typescript-eslint/no-unused-expressions': [
      'error',
      {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: true,
      },
    ],

    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'warn',

    'space-before-function-paren': 'off',
    '@typescript-eslint/space-before-function-paren': ['error', 'always'],
  },
  overrides: base.overrides,
}
