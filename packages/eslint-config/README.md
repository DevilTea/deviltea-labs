# @deviltea/eslint-config-monorepo
## @deviltea/eslint-config-[base/ts/vue]

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config-base)](https://npmjs.com/package/@deviltea/eslint-config-base)

## Usage

### Install

```bash
# @deviltea/eslint-config-base (extends airbnb)
pnpm add -D eslint @deviltea/eslint-config-base

# @deviltea/eslint-config-ts (extends base)
pnpm add -D eslint @deviltea/eslint-config-ts

# @deviltea/eslint-config-vue (extends ts)
pnpm add -D eslint @deviltea/eslint-config-vue
```

### Config `.eslintrc`

```json
{
  "extends": [
    "@deviltea/eslint-config-vue"
  ]
}
```

### Config `.eslintignore`

```txt
dist
public
```

### Add script for package.json

For example:

```json
{
  "scripts": {
    "lint": "eslint \"**/*.{vue,ts,js}\""
  }
}
```

### Config VSCode auto fix

Create `.vscode/settings.json`

```json
{
  "prettier.enable": false,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "eslint.validate": [
    "typescript",
    "javascript",
    "vue",
    "json"
  ],
}
```