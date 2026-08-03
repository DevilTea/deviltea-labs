# Source history map

This document records the immutable source heads used for the DevilTea Labs
migration. Legacy repositories and their tags remain intact; bare legacy tags
are deliberately not imported because version names collide across packages.

| Source repository | Source `main` HEAD | Target path | Legacy tags |
| --- | --- | --- | --- |
| `DevilTea/eslint-config` | `c020dce80fe7cdf5489c96792fd7ff1f588d5df8` | `packages/eslint-config` | 31 retained in legacy repo |
| `DevilTea/tsconfig` | `f28b2cf9826a10f2a2f441627455c6f698e645df` | `packages/tsconfig` | 8 retained in legacy repo |
| `DevilTea/vue-router-middleware` | `3c070db52c69d167f06a865e9ebb6cd3e170e5eb` | `packages/vue-router-middleware` | 4 retained in legacy repo |
| `DevilTea/vue-temp-var` | `8b449b6aa0d530d6ff804501f3a9756fd9e2b55d` | `packages/vue-temp-var` | 3 retained in legacy repo |
| `DevilTea/tiny-state-machine` | `226fc1ad5302f6fe5ff9efceb5324760bf577cef` | `packages/tiny-state-machine`, `packages/tiny-state-machine-vue`, and `docs/tiny-state-machine` | 5 retained in legacy repo |

Imported history was merged without squashing. An ordinary follow-up commit
moves tiny-state-machine packages and docs from their initial import path to
their final workspace locations. New releases use package-prefixed tags such
as `eslint-config@9.0.1`.
