# DevilTea Labs

DevilTea Labs is the monorepo for maintained DevilTea packages. Each package
keeps its own npm identity and version while sharing workspace tooling,
continuous integration, and release orchestration.

Package documentation is available at
[deviltea.github.io/deviltea-labs](https://deviltea.github.io/deviltea-labs/).

| Package | Source |
| --- | --- |
| `@deviltea/eslint-config` | [`packages/eslint-config`](packages/eslint-config) |
| `@deviltea/tsconfig` | [`packages/tsconfig`](packages/tsconfig) |
| `@deviltea/vue-router-middleware` | [`packages/vue-router-middleware`](packages/vue-router-middleware) |
| `vue-temp-var` | [`packages/vue-temp-var`](packages/vue-temp-var) |
| `@deviltea/tiny-state-machine` | [`packages/tiny-state-machine`](packages/tiny-state-machine) |
| `@deviltea/tiny-state-machine-vue` | [`packages/tiny-state-machine-vue`](packages/tiny-state-machine-vue) |

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

See [`docs/migration/source-map.md`](docs/migration/source-map.md) for the
preserved source-history mapping.
