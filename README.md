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
| `@deviltea/spec-tool` | [`packages/spec-tool`](packages/spec-tool) |

## Agent Skills

Repository-installable Agent Skills live under [`skills/`](skills/). The
Spec Tool skills can be discovered and installed with the Skills CLI:

```sh
npx skills@latest add DevilTea/deviltea-labs --list
npx skills@latest add DevilTea/deviltea-labs --skill maintain-spec-workspace --skill review-spec-workspace
```

The root copies mirror the skills shipped in `@deviltea/spec-tool`; package
tests verify that the repository-installable and npm-distributed copies stay in
sync.

## Development

Use Node.js 24 LTS (24.11+) for development; Node.js 22.22.1+ also remains supported by the workspace toolchain. Use the pnpm version declared in the root package manifest.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

See [`docs/migration/source-map.md`](docs/migration/source-map.md) for the
preserved source-history mapping.

## Releasing

Releases are driven locally and published from GitHub Actions with npm Trusted
Publishing. Requires an authenticated [GitHub CLI](https://cli.github.com).

```sh
pnpm release <package> <patch|minor|major|prerelease|version>  # bump and open the release PR (auto-merge)
# wait for the pull request to merge, then:
pnpm release:tag <package>                                     # push the tag and publish
```

See [`docs/migration/release-cutover.md`](docs/migration/release-cutover.md)
for the full procedure.

## Compatibility

- Published packages declare their own Node.js and peer dependency requirements. Workspace tooling requirements do not automatically raise library runtime requirements.
- The workspace and current TypeScript tooling packages use TypeScript 6 (`>=6.0.0 <7.0.0`); TypeScript 5 is no longer supported by the current ESLint config.
- Minimum and latest supported TypeScript 6 versions are checked in packed consumers. TypeScript 7 is deferred.
- See [dependency maintenance](docs/dependency-maintenance.md) for the routine update process.
