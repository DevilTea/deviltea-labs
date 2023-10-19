# @deviltea/eslint-config

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config)](https://npmjs.com/package/@deviltea/eslint-config)

Extends [`@antfu/eslint-config`](https://github.com/antfu/eslint-config), with some customizations.

The way to customize the rules is the same as [`@antfu/eslint-config`](https://github.com/antfu/eslint-config/tree/main#customization).

## Usage

### Install

```bash
pnpm add -D eslint @deviltea/eslint-config
```

### Create config file

With [`"type": "module"`](https://nodejs.org/api/packages.html#type) in `package.json` (recommended):

```js
// eslint.config.js
import deviltea from '@deviltea/eslint-config'

export default deviltea()
```

With CJS:

```js
// eslint.config.js
const deviltea = require('@deviltea/eslint-config').default

module.exports = deviltea()
```

> Note that `.eslintignore` no longer works in Flat config, see [customization](#customization) for more details.

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
		"source.fixAll": "explicit",
		"source.organizeImports": "never"
	},

	// Silent the stylistic rules in you IDE, but still auto fix them
	"eslint.rules.customizations": [
		{ "rule": "style/*", "severity": "off" },
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
		"yaml"
	]
}
```

### Using tabs instead of spaces


> According to [this](https://github.com/microsoft/vscode/issues/156304#issue-1318328510), I prefer to use tabs instead of spaces.
>
> The size of tabs can be configured in `.editorconfig`.

Install [VS Code EditorConfig extension](https://marketplace.visualstudio.com/items?itemName=editorconfig.editorconfig)

Add the following settings to your `.editorconfig`:

```ini
# .editorconfig
root = true

[*]
indent_size = 4
end_of_line = lf
charset = utf-8
insert_final_newline = true
```
