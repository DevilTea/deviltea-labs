# @deviltea/eslint-config

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config)](https://npmjs.com/package/@deviltea/eslint-config)

Extends from awesome [`@antfu/eslint-config`](https://github.com/antfu/eslint-config), with some personal customizations.

- Preferred tabs instead of spaces.
	> According to the [discussion](https://github.com/microsoft/vscode/issues/156304#issue-1318328510), I prefer to use tabs instead of spaces.

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
	// Disable the default formatter, use eslint instead
	"prettier.enable": false,
	"editor.formatOnSave": false,

	// Auto fix
	"editor.codeActionsOnSave": {
		"source.fixAll.eslint": "explicit",
		"source.organizeImports": "never"
	},

	// Silent the stylistic rules in you IDE, but still auto fix them
	"eslint.rules.customizations": [
		{ "rule": "style/*", "severity": "off" },
		{ "rule": "format/*", "severity": "off" },
		{ "rule": "*-indent", "severity": "off" },
		{ "rule": "*-spacing", "severity": "off" },
		{ "rule": "*-spaces", "severity": "off" },
		{ "rule": "*-order", "severity": "off" },
		{ "rule": "*-dangle", "severity": "off" },
		{ "rule": "*-newline", "severity": "off" },
		{ "rule": "*quotes", "severity": "off" },
		{ "rule": "*semi", "severity": "off" }
	],

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
		"xml",
		"gql",
		"graphql",
		"astro",
		"css",
		"less",
		"scss",
		"pcss",
		"postcss"
	]
}
```

### Lint Staged

If you want to apply lint and auto-fix before every commit, you can add the following to your `package.json`:

```json
{
	"simple-git-hooks": {
		"pre-commit": "pnpm lint-staged"
	},
	"lint-staged": {
		"*": "eslint --fix"
	}
}
```

and then

```bash
pnpm add -D lint-staged simple-git-hooks

// to active the hooks
pnpm exec simple-git-hooks
```
