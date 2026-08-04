# Release cutover

The workspace uses independent package versioning and a centralized release
flow. Package-local release commands are intentionally unavailable: official
releases only use GitHub Actions and npm Trusted Publishing (OIDC). No npm
credentials or long-lived npm token are stored in this repository.

## Trusted Publishing

Trusted Publishers are configured for the following packages with owner
`DevilTea`, repository `deviltea-labs`, workflow `publish.yml`, and no GitHub
environment:

| npm package | Release identifier | Tag example |
| --- | --- | --- |
| `@deviltea/eslint-config` | `eslint-config` | `eslint-config@9.0.1` |
| `@deviltea/tsconfig` | `tsconfig` | `tsconfig@1.0.1` |
| `@deviltea/vue-router-middleware` | `vue-router-middleware` | `vue-router-middleware@0.0.5` |
| `vue-temp-var` | `vue-temp-var` | `vue-temp-var@2.0.2` |
| `@deviltea/tiny-state-machine` | `tiny-state-machine` | `tiny-state-machine@0.0.6` |
| `@deviltea/tiny-state-machine-vue` | `tiny-state-machine-vue` | `tiny-state-machine-vue@0.0.6` |

## Release procedure

1. Manually dispatch **Create release PR** (`release-pr.yml`) and select one
   package plus a Bumpp release type or exact version.
2. The workflow creates a release branch and pull request after running
   `pnpm check`. Review and merge that pull request into `main`.
3. Create and push an annotated package-prefixed tag for the merged version,
   for example `git tag -a eslint-config@9.0.1 -m 'eslint-config@9.0.1'` and
   `git push origin eslint-config@9.0.1`.
4. **Publish package** (`publish.yml`) verifies that the tagged commit is on
   `main`, verifies the tag and package version match, runs `pnpm check`,
   packs exactly one tarball, and publishes it to npm with provenance.

The first release from this repository remains the final operational check for
each package's Trusted Publisher and npm provenance. Do not use an npm token
as a fallback if that check fails.
