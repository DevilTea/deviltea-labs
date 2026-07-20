# @deviltea/eslint-config

[![npm](https://img.shields.io/npm/v/@deviltea/eslint-config)](https://npmjs.com/package/@deviltea/eslint-config)

An opinionated ESLint flat config for JavaScript, TypeScript, and Vue, built on [`@antfu/eslint-config`](https://github.com/antfu/eslint-config).

This package keeps Antfu's composable factory API while applying DevilTea's project conventions. It is intentionally a personal, strongly opinionated config rather than a general-purpose preset.

## Requirements

| Runtime | Supported version |
| --- | --- |
| Node.js | `>=24` |
| ESLint | `^10.4.0` |
| Configuration format | ESLint flat config |

TypeScript and Vue support are enabled by default. They can be disabled explicitly when a project does not need them.

## Opinionated defaults

The package inherits all defaults from `@antfu/eslint-config@9.1.0` and adds the following rules.

### Stylistic

- Tabs for indentation.
- Require a newline for chained calls deeper than one level.
- Disable `antfu/consistent-chaining` in favor of `style/newline-per-chained-call`.

### JavaScript and TypeScript

- Enable `no-lonely-if`.

### Vue

- Use non-hyphenated attributes and event names.
- Limit attributes to one per line.
- Require Composition API or `<script setup>` component style.
- Require type-based `defineProps` and `defineEmits` declarations.
- Require the conventional macro variable names `props`, `emit`, `slots`, and `attrs`.
- Prefer `defineOptions` and validate its usage.
- Disallow unsafe `_blank` template targets.
- Require PascalCase component names in templates, including unregistered components.

User-provided nested options are preserved, and user rule overrides take precedence over these defaults.

## Installation

```bash
pnpm add -D eslint@^10.4.0 @deviltea/eslint-config
```

## Usage

Create `eslint.config.mjs`:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea()
```

Add scripts to `package.json`:

```json
{
	"scripts": {
		"lint": "eslint .",
		"lint:fix": "eslint . --fix"
	}
}
```

## Customization

The factory accepts the same option shape and returns the same composer type as [`@antfu/eslint-config`](https://github.com/antfu/eslint-config#customization).

### Override rules

Pass additional flat config objects after the options object:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea(
	{},
	{
		rules: {
			'no-console': 'warn',
		},
	},
)
```

Nested overrides take precedence over this package's defaults:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	typescript: {
		overrides: {
			'no-lonely-if': 'off',
		},
	},
	vue: {
		overrides: {
			'vue/attribute-hyphenation': 'off',
		},
	},
})
```

### Type-aware TypeScript rules

Upstream TypeScript options are preserved while this package merges its default rule overrides:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	typescript: {
		tsconfigPath: './tsconfig.json',
		overridesTypeAware: {
			'ts/no-floating-promises': 'error',
		},
	},
})
```

### Vue options

Upstream Vue options are preserved while this package merges its default rule overrides:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	vue: {
		a11y: true,
		vueVersion: 3,
	},
})
```

### Disable TypeScript or Vue

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	typescript: false,
	vue: false,
})
```

### Composer API

The returned config supports the upstream flat-config composer methods:

```mjs
import deviltea from '@deviltea/eslint-config'

export default deviltea()
	.prepend({
		ignores: ['coverage/**'],
	})
```

## VS Code

Install the [VS Code ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint), then add the following to `.vscode/settings.json`:

```jsonc
{
	// Let ESLint own formatting and fixes.
	"prettier.enable": false,
	"editor.formatOnSave": false,
	"editor.codeActionsOnSave": {
		"source.fixAll.eslint": "explicit",
		"source.organizeImports": "never"
	},

	// Hide fixable stylistic diagnostics in the editor while preserving save fixes.
	"eslint.rules.customizations": [
		{ "rule": "style/*", "severity": "off", "fixable": true },
		{ "rule": "format/*", "severity": "off", "fixable": true },
		{ "rule": "*-indent", "severity": "off", "fixable": true },
		{ "rule": "*-spacing", "severity": "off", "fixable": true },
		{ "rule": "*-spaces", "severity": "off", "fixable": true },
		{ "rule": "*-order", "severity": "off", "fixable": true },
		{ "rule": "*-dangle", "severity": "off", "fixable": true },
		{ "rule": "*-newline", "severity": "off", "fixable": true },
		{ "rule": "*quotes", "severity": "off", "fixable": true },
		{ "rule": "*semi", "severity": "off", "fixable": true }
	],

	// Extend this list with other languages used by the project.
	"eslint.validate": [
		"javascript",
		"javascriptreact",
		"typescript",
		"typescriptreact",
		"vue",
		"json",
		"jsonc",
		"yaml",
		"markdown"
	]
}
```

The `fixable` filter is important: it suppresses only diagnostics that ESLint can automatically fix, without hiding non-fixable correctness rules.

## Lint staged files

To apply fixes before each commit:

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

```bash
pnpm add -D lint-staged simple-git-hooks
pnpm exec simple-git-hooks
```

## Compatibility and upgrades

`@antfu/eslint-config` is pinned exactly so reinstalling the same `@deviltea/eslint-config` version cannot silently change lint behavior. Upstream upgrades are reviewed and released deliberately.

Changes to the supported Node.js or ESLint range, enabled config families, or existing opinionated rule behavior are treated as breaking changes and released as a new major version.
