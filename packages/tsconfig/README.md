# `@deviltea/tsconfig`

Strict, reusable TypeScript configurations for platform-neutral libraries, browser code, Node.js packages, native Node.js projects, and repository tooling.

## Choose your TypeScript version

| TypeScript | Package version | Status |
| --- | --- | --- |
| TypeScript 6.x | `@deviltea/tsconfig@1` | Current preset architecture |
| TypeScript 5.9 | `@deviltea/tsconfig@0` | Legacy `/base`, `/dom`, and `/node` presets |
| TypeScript 7.x | Not yet supported | Support will be added after compatibility is verified |

### TypeScript 6

```sh
pnpm add -D typescript@^6 @deviltea/tsconfig@^1
```

Install Node.js declarations when using `node`, `node-bundler`, or `tooling`:

```sh
pnpm add -D @types/node
```

### TypeScript 5.9

```sh
pnpm add -D typescript@^5.9 @deviltea/tsconfig@^0
```

The v0 line keeps the previous presets for existing projects. New preset development happens on v1.

## Presets

| Preset | Use it for |
| --- | --- |
| `strict` | Shared type-safety and diagnostic policy without choosing a runtime or module system |
| `neutral` | Bundled libraries that must not depend on browser or Node.js globals |
| `browser` | Browser applications, Vue libraries, Vite client code, and VitePress themes |
| `node-bundler` | Node.js packages whose source module graph is processed by a bundler such as tsdown |
| `node` | Native Node.js module resolution, including projects run directly by Node.js or emitted by `tsc` |
| `tooling` | Repository scripts, tests, and configuration files loaded by Node-based tools |

## Usage

Choose one runtime preset in the project-level `tsconfig.json`:

```json
{
	"extends": "@deviltea/tsconfig/neutral",
	"include": ["src/**/*.ts"]
}
```

A browser project can use:

```json
{
	"extends": "@deviltea/tsconfig/browser",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["src/**/*", "src/**/*.vue"]
}
```

Repository scripts and test files can use:

```json
{
	"extends": "@deviltea/tsconfig/tooling",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["scripts/**/*.ts", "tests/**/*.ts", "*.config.ts"]
}
```

## `node` or `node-bundler`?

Use `node` when Node.js owns the source module graph. It uses `NodeNext` resolution and therefore validates Node.js package boundaries, ESM/CommonJS interpretation, and relative import extensions.

Use `node-bundler` when a bundler owns the source module graph and the resulting output runs on Node.js. It uses Bundler resolution and permits bundler conventions such as extensionless relative imports.

## Keep project structure local

The presets intentionally do not set project-specific options such as:

- `include`, `exclude`, or `files`
- `paths`, `rootDir`, or `outDir`
- `composite`, `references`, or `tsBuildInfoFile`
- `noEmit`, declaration emit, or output directory policy

Set those options in each repository according to its own source layout and build pipeline.

## Migrating from v0

See the [v1 migration guide](./docs/migration-v1.md) for preset mappings, the breaking change to `node`, and TypeScript 6 migration checks.

## License

[MIT](./LICENSE)
