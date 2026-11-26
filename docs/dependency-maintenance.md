# Dependency maintenance

The workspace uses a single pnpm catalog and lockfile. Node.js 24 LTS is the preferred development environment; the workspace also supports Node.js 22.22.1+. TypeScript is restricted to stable 6.x. Published package compatibility is separate from the workspace toolchain.

## Routine update process

1. Start from a clean branch and run `pnpm outdated -r` to inspect direct dependencies and their current/latest versions.
2. Group related changes: testing (Vitest, coverage, fast-check, StrykerJS), linting (ESLint and its config), compiler (TypeScript, Node types, vue-tsc), build (Vite, tsdown, unplugin-vue), Vue (Vue and Vue Router), or documentation (VitePress). Update one cohesive group per PR where practical.
3. Update catalog ranges explicitly when necessary. For compatible updates within declared ranges, use `pnpm -r --include-workspace-root update <package>...` with explicit package names. For intentionally pinned tools, edit the catalog and run `pnpm install`. Keep Vitest and its coverage provider on the same exact version, and keep StrykerJS packages aligned.
4. Retain the 72-hour release age, trust policy, strict dependency build policy, and existing security overrides. Never bypass a trust failure just to upgrade a package. Review security overrides periodically against upstream advisories.
5. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm test:mutation`. Review lockfile and packed consumer results before merging.

Major upgrades or changes to public compatibility (including a change of Node or TypeScript major) require independent review and migration notes. Do not use blanket latest updates to bypass the supported version boundaries. TypeScript 7, automatic Renovate PRs, and Antfu 10 migration are deferred; keep Node types on the preferred Node 24 line and retain the existing VitePress prerelease until its migration is reviewed.

## Compatibility checks

- Tooling: current workspace lockfile and supported Node lines.
- ESLint config: packed consumer with ESLint 10.4.0 and TypeScript 6.0.2, plus CI with latest supported ESLint 10 and TypeScript 6. Strict peer checking remains enabled.
- TypeScript presets: packed compiler contracts with the first stable TypeScript 6 release (6.0.2) and latest stable 6.x.
- Runtime libraries: retain existing package-specific runtime and framework peer ranges unless compatibility is explicitly changed. Do not introduce a TypeScript peer dependency merely because declarations are built with TypeScript 6.

A passing workspace install is not evidence of published-package compatibility: root overrides and the workspace lockfile are not inherited by downstream consumers. Keep packed consumer checks independent.
