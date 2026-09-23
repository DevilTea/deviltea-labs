# Spec Tool v1 documentation

This directory documents the **shipped** frozen-v1 Spec Tool package. [GitHub Discussion #65, Thread 4](https://github.com/DevilTea/deviltea-labs/discussions/65) remains the design authority; implementation/docs are not independent design ledgers.

- [CLI and TypeScript API](v1-cli-api.md): exact resource-first operations, JSON stdin/stdout/stderr, optimistic revision, relational updates, cross-kind lifecycle, public exports.
- [Canonical persistence and graph](v1-persistence.md): workspace layout, YAML frontmatter, Scenario/Gherkin subset, normalized IR, effective Clause applicability, validation and file safety.
- [Package README](../README.md): installation, quick start, use cases, semantic model.
- [Maintain skill](../skills/maintain-spec-workspace/SKILL.md) and [Review skill](../skills/review-spec-workspace/SKILL.md): bounded agent workflows.

**There is no 0.0.1 compatibility layer.** The previous Artifact ontology, status transitions, Resources, `refines` commands, `.spec/config.yaml` layout and `docs/ef-core/` references are removed. Migration, arbitrary raw-file CRUD, comments API, test execution, Scenario repacking and invalid-state repair are not part of v1.
