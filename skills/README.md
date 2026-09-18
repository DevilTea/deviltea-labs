# Agent Skills

This directory is the repository-level discovery surface for the
[Skills CLI](https://skills.sh/).

The Spec Tool skills mirror the copies shipped by `@deviltea/spec-tool`:

- `maintain-spec-workspace`
- `review-spec-workspace`

List or install them directly from this repository:

```sh
npx skills@latest add DevilTea/deviltea-labs --list
npx skills@latest add DevilTea/deviltea-labs --skill maintain-spec-workspace --skill review-spec-workspace
```

When changing a Spec Tool skill, update both this repository-level copy and the
matching `packages/spec-tool/skills/<name>/SKILL.md` file. The package smoke test
checks that they remain byte-for-byte identical.
