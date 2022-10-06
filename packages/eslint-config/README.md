# @deviltea/eslint-config

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config)](https://npmjs.com/package/@deviltea/eslint-config)

Extends [`@antfu/eslint-config`](https://github.com/antfu/eslint-config)

## Usage

### Install

```bash
pnpm add -D eslint @deviltea/eslint-config
```

### Config `.eslintrc`

```json
{
  "extends": [
    "@deviltea"
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
  ]
}
```