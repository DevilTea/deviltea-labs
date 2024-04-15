# @deviltea/eslint-config

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config)](https://npmjs.com/package/@deviltea/eslint-config)

Extends [`@antfu/eslint-config`](https://github.com/antfu/eslint-config), with some customizations.

The way to customize the rules is the same as [`@antfu/eslint-config`](https://github.com/antfu/eslint-config/tree/main#customization).

## Usage

### Install

```bash
pnpm add -D eslint @deviltea/eslint-config
```

```mjs
// eslint.config.mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea()
```

### Add script for package.json

For example:

```json
{
	"scripts": {
		"lint": "eslint .",
		"lint:fix": "eslint . --fix"
	}
}
```

## VS Code support (auto fix)

Install [VS Code ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

Add the following settings to your `.vscode/settings.json`:

```jsonc
{
	// Enable the ESlint flat config support
	"eslint.experimental.useFlatConfig": true,

	// Disable the default formatter, use eslint instead
	"prettier.enable": false,
	"editor.formatOnSave": false,

	// Auto fix
	"editor.codeActionsOnSave": {
		"source.fixAll.eslint": "explicit",
		"source.organizeImports": "never"
	},

	// Enable eslint for all supported languages
	"eslint.validate": [
		"javascript",
		"javascriptreact",
		"typescript",
		"typescriptreact",
		"vue",
		"html",
		"markdown",
		"json",
		"jsonc",
		"yaml",
		"toml",
		"gql",
		"graphql"
	]
}
```

### Using tabs instead of spaces

> According to the [discussion](https://github.com/microsoft/vscode/issues/156304#issue-1318328510), I prefer to use tabs instead of spaces.
