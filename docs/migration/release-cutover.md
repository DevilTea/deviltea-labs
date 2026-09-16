# Release cutover

The workspace uses independent package versioning and a centralized release
flow. Established packages publish only in GitHub Actions through npm Trusted
Publishing (OIDC); the one-time `@deviltea/spec-tool@0.0.1` bootstrap exception
is documented below. No npm credentials or long-lived npm token are stored in
this repository.

Version bumps are driven locally by `pnpm release`, because GitHub Actions
cannot open pull requests in this repository (the "Allow GitHub Actions to
create and approve pull requests" setting is disabled), and because branches,
tags, and pull requests created with `GITHUB_TOKEN` do not trigger further
workflow runs. Driving the bump from a workstation keeps the release pull
request under normal CI and keeps the publish workflow triggered by a real tag
push.

## Trusted Publishing

Trusted Publisher configuration uses owner `DevilTea`, repository
`deviltea-labs`, workflow `publish.yml`, and no GitHub environment. The table
also lists `@deviltea/spec-tool`, whose Trusted Publisher is configured only
after its bootstrap `0.0.1` publish:

| npm package | Release identifier | Tag example |
| --- | --- | --- |
| `@deviltea/eslint-config` | `eslint-config` | `eslint-config@9.0.1` |
| `@deviltea/tsconfig` | `tsconfig` | `tsconfig@1.0.1` |
| `@deviltea/vue-router-middleware` | `vue-router-middleware` | `vue-router-middleware@0.0.5` |
| `vue-temp-var` | `vue-temp-var` | `vue-temp-var@2.0.2` |
| `@deviltea/tiny-state-machine` | `tiny-state-machine` | `tiny-state-machine@0.0.6` |
| `@deviltea/tiny-state-machine-vue` | `tiny-state-machine-vue` | `tiny-state-machine-vue@0.0.6` |
| `@deviltea/spec-tool` | `spec-tool` | `spec-tool@0.0.1` |

`@deviltea/widget-core` and `@deviltea/widget-vue` moved to [`DevilTea/widget`](https://github.com/DevilTea/widget) and are no longer released from this repository.

## First `@deviltea/spec-tool` publish

`@deviltea/spec-tool@0.0.1` is the bootstrap exception to the normal Trusted
Publishing-only flow because the npm package does not exist yet. After this
repository change is merged and validated, pack the package from `main`, publish
that exact tarball manually with npm authentication. This bootstrap publish cannot
carry npm provenance because provenance requires a supported cloud CI runner. Then
configure `publish.yml` as the Trusted Publisher; subsequent GitHub Actions publishes
receive provenance automatically. Do not push the
`spec-tool@0.0.1` release tag until the package's publishing setup is ready.

## Release procedure

The normal release commands require a local [GitHub CLI](https://cli.github.com)
installation authenticated with `gh auth login`.

1. From a clean, up-to-date `main`, run `pnpm release <package> <release>`,
   where `<release>` is a Bumpp release type (`patch`, `minor`, `major`,
   `prerelease`) or an exact version. The command bumps the package, commits it
   on `release/<package>/v<version>`, pushes that branch, opens its pull
   request, enables auto-merge (squash), and switches back to `main`.
2. Wait for the pull request. It runs the full CI matrix because it is created
   by a real account rather than `GITHUB_TOKEN`, and auto-merge squashes it into
   `main` as soon as every required check passes. Disable auto-merge on the pull
   request if it needs manual review instead.
3. Run `pnpm release:tag <package>`. It fast-forwards local `main`, refuses to
   reuse an existing tag, and pushes the annotated package-prefixed tag, for
   example `eslint-config@9.0.1`.
4. **Publish package** (`publish.yml`) verifies that the tagged commit is on
   `main`, verifies the tag and package version match, runs `pnpm check`,
   packs exactly one tarball, and publishes it to npm with provenance.

Both commands accept `--yes` to skip their confirmation prompt. `pnpm release`
refuses to run when the working tree is dirty, when the current branch is not
`main`, when `main` is out of sync with `origin/main`, or when the target tag or
release branch already exists. Nothing is pushed until the confirmation is
accepted; a declined prompt restores the bumped `package.json`.

`scripts/release-package.ts` remains the single source of truth for the package
table and is also invoked as a CLI by `publish.yml`.

For established packages, the first automated release remains the final operational
check for Trusted Publisher configuration and npm provenance. For `@deviltea/spec-tool`,
the manual `0.0.1` bootstrap establishes the package first; the next GitHub Actions
release performs that Trusted Publisher/provenance check. Do not use an npm token as a
fallback if trusted publishing fails.
