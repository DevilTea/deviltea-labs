# Migrating to `@deviltea/tsconfig` v1

Version 1 redesigns the presets around TypeScript 6, runtime environment, and module resolution ownership. It is not a drop-in replacement for every v0 preset.

## Requirements

- TypeScript 6.x
- a version of `@types/node` that matches the target runtime when using a Node.js preset

```sh
pnpm add -D typescript@^6 @deviltea/tsconfig@^1
```

Projects that must remain on TypeScript 5.9 should continue using `@deviltea/tsconfig@0`.

## Preset mapping

| v0 usage | v1 replacement |
| --- | --- |
| `/base` for a bundled platform-neutral library | `/neutral` |
| `/base` only for shared strictness rules | `/strict` plus project-selected runtime and module options |
| `/dom` | `/browser` |
| `/node` for repository scripts, tests, or config files | `/tooling` |
| `/node` for a bundled Node.js package | `/node-bundler` |
| `/node` for source run directly by Node.js or JavaScript emitted by `tsc` | `/node` |

The `/base` and `/dom` exports no longer exist in v1.

## The breaking change to `node`

The v0 `node` preset combined Node.js ambient types with Bundler module resolution. The v1 `node` preset models native Node.js instead:

```json
{
	"extends": "@deviltea/tsconfig/node"
}
```

It uses `module: "NodeNext"` and `moduleResolution: "NodeNext"`. In ESM files, relative imports therefore need the runtime extension:

```ts
// Before: accepted by the v0 Bundler-based preset
import { value } from './value'

// Native Node.js source in v1
import { value } from './value.js'
```

Do not add `.js` extensions mechanically when a bundler processes the source graph. Use `node-bundler` instead:

```json
{
	"extends": "@deviltea/tsconfig/node-bundler"
}
```

## Common migrations

### Platform-neutral library

```diff
 {
-	"extends": "@deviltea/tsconfig/base"
+	"extends": "@deviltea/tsconfig/neutral"
 }
```

The v1 preset explicitly removes DOM and Node.js ambient globals. Code that uses either environment must select a more specific preset or receive those capabilities through explicit dependencies.

### Browser or Vue library

```diff
 {
-	"extends": "@deviltea/tsconfig/dom"
+	"extends": "@deviltea/tsconfig/browser"
 }
```

Keep Vue-specific `vueCompilerOptions`, `.vue` includes, aliases, and output settings in the consuming project.

### Vite application

```json
{
	"extends": "@deviltea/tsconfig/browser",
	"compilerOptions": {
		"noEmit": true,
		"paths": {
			"@/*": ["./src/*"]
		}
	},
	"include": ["env.d.ts", "src/**/*", "src/**/*.vue"]
}
```

### Bundled Node.js package

```diff
 {
-	"extends": "@deviltea/tsconfig/node"
+	"extends": "@deviltea/tsconfig/node-bundler"
 }
```

This is the normal choice for packages built with tsdown, Rollup, esbuild, or another bundler before publication.

### Native Node.js project

```json
{
	"extends": "@deviltea/tsconfig/node",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["src/**/*.ts"]
}
```

Check the nearest `package.json` `type` field and update relative ESM imports to their runtime `.js` paths.

### Repository tooling

```diff
 {
-	"extends": "@deviltea/tsconfig/node"
+	"extends": "@deviltea/tsconfig/tooling"
 }
```

Use this for scripts, Vitest tests, Vite/VitePress configuration, and build-tool configuration. The preset includes Node.js types and checks JavaScript files, but it does not add Vitest or other test-runner globals.

For browser-oriented tests that need both Node.js tooling and DOM APIs, extend `tooling` and add the DOM library locally:

```json
{
	"extends": "@deviltea/tsconfig/tooling",
	"compilerOptions": {
		"lib": ["ES2024", "DOM"]
	}
}
```

### VitePress documentation

Use separate project configs for client content and Node.js configuration.

`docs/tsconfig.docs.json`:

```json
{
	"extends": "@deviltea/tsconfig/browser"
}
```

`docs/tsconfig.configs.json`:

```json
{
	"extends": "@deviltea/tsconfig/tooling",
	"include": [".vitepress/config.ts"]
}
```

## Relevant TypeScript 6 changes

When upgrading the compiler, review these changes in addition to switching presets:

- ambient `types` now default to an empty list; add required global type packages explicitly
- `rootDir` now defaults to the project directory; set it explicitly when declaration or JavaScript output layout matters
- native Node.js projects should use `NodeNext`, while bundled projects should use `Preserve` with Bundler resolution
- legacy `moduleResolution: "node"` is deprecated
- several old module and interoperability options are deprecated in preparation for TypeScript 7

The v1 presets explicitly choose stable runtime baselines instead of inheriting TypeScript's floating default target.

## Validation checklist

After migration, run the repository's complete quality pipeline. At minimum:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm publint
pnpm pack
```

Also verify:

- platform-neutral source does not rely on accidental DOM or Node.js globals
- browser source does not rely on Node.js globals
- native Node.js ESM imports use runtime extensions
- test-runner globals are declared explicitly when used
- `rootDir`, declaration emit, and output paths still match the published package layout
- the bundler target agrees with the selected runtime preset
