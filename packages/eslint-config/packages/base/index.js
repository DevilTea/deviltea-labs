module.exports = {
  env: {
    es6: true,
    browser: true,
    node: true,
  },
  extends: [
    'airbnb-base',
    'plugin:eslint-comments/recommended',
    'plugin:import/recommended',
    'plugin:jsonc/recommended-with-jsonc',
    'plugin:promise/recommended',
  ],
  plugins: [
    'promise',
    'html',
    'unicorn',
  ],
  settings: {
    'import/resolver': {
      node: {
        extensions: [
          '.js',
          '.mjs',
          '.ts',
          '.d.ts',
        ],
      },
    },
  },
  rules: {
    // common
    semi: ['error', 'never'],
    'no-unused-expressions': [
      'error',
      {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: true,
      },
    ],
    'max-len': 'off',
    'no-underscore-dangle': 'off',
    'no-plusplus': 'off',
    'no-use-before-define': 'warn',
    'no-param-reassign': ['error', { props: false }],
    'array-bracket-newline': ['error', 'consistent'],
    'array-element-newline': ['error', 'consistent'],
    'object-curly-newline': [
      'error',
      {
        ObjectExpression: {
          minProperties: 3,
          multiline: true,
          consistent: true,
        },
        ObjectPattern: {
          minProperties: 3,
          multiline: true,
          consistent: true,
        },
        ImportDeclaration: {
          minProperties: 3,
          multiline: true,
          consistent: true,
        },
        ExportDeclaration: {
          minProperties: 3,
          multiline: true,
          consistent: true,
        },
      },
    ],
    'object-property-newline': ['error', {
      allowAllPropertiesOnSameLine: false,
    }],
    'space-before-function-paren': ['error', 'always'],
    'no-nested-ternary': 'off',
    'prefer-destructuring': 'off',
    // import
    'import/order': 'error',
    'import/first': 'error',
    'import/no-absolute-path': 'off',
    'import/no-mutable-exports': 'error',
    'import/no-default-export': 'error',
    'import/prefer-default-export': 'off',
  },
  overrides: [
    {
      files: ['*.json', '*.json5'],
      parser: 'jsonc-eslint-parser',
      rules: {
        quotes: ['error', 'double'],
        'quote-props': ['error', 'always'],
        'comma-dangle': ['error', 'never'],
        'eol-last': ['error', 'never'],
        // turn off ts rules for json files
        '@typescript-eslint/naming-convention': 'off',
        '@typescript-eslint/dot-notation': 'off',
        '@typescript-eslint/no-implied-eval': 'off',
        '@typescript-eslint/no-throw-literal': 'off',
        '@typescript-eslint/return-await': 'off',
      },
    },
    {
      files: ['package.json'],
      parser: 'jsonc-eslint-parser',
      rules: {
        'jsonc/sort-keys': [
          'error',
          {
            pathPattern: '^$',
            order: [
              'name',
              'version',
              'description',
              'keywords',
              'license',
              'repository',
              'funding',
              'author',
              'type',
              'files',
              'exports',
              'main',
              'module',
              'unpkg',
              'bin',
              'scripts',
              'husky',
              'lint-staged',
              'peerDependencies',
              'peerDependenciesMeta',
              'dependencies',
              'devDependencies',
              'eslintConfig',
            ],
          },
          {
            pathPattern: '^(?:dev|peer|optional|bundled)?[Dd]ependencies$',
            order: { type: 'asc' },
          },
        ],
      },
    },
    {
      files: ['*.d.ts'],
      rules: {
        'import/no-duplicates': 'off',
      },
    },
    {
      files: ['*.js'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['scripts/**/*.*'],
      rules: {
        'no-console': 'off',
        'import/no-extraneous-dependencies': 'off',
      },
    },
    {
      files: ['*.test.ts', '*.test.js', '*.spec.ts', '*.spec.js'],
      rules: {
        'no-unused-expressions': 'off',
      },
    },
  ],
  ignorePatterns: [
    '!.*',
  ],
}
