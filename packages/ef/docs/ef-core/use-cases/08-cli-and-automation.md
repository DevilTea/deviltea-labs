# 08. CLI, Editor, and CI Automation

## UC-060 — Plan and authorize a safe CLI mutation

**User Story:** As a CLI user, I want to preview and explicitly authorize the limited write operations so a command cannot surprise me with partial or replacement writes.

**Main flow:** For `ef init` or `ef artifact create`, EF computes the complete
plan first. The user chooses `--dry-run`, confirms interactively, or supplies
`--yes` with `--no-input`. EF validates temporary content, rechecks target
absence and identity, and publishes by same-filesystem create-if-absent
semantics.

**Success assertions:** Dry run returns a complete unapplied plan; init creates
only a new `.engineering/` directory and artifact creation creates only one new
draft file; a race rejects without publication; optional writer locks are
advisory only.

**Guardrails:** JSON implies no input, so JSON mutation needs `--dry-run` or
`--yes`; declined or missing authorization is incomplete (exit 2); a normal
replacing rename is insufficient; Core has no general arbitrary multi-file
mutation CLI.

## UC-061 — Consume stable JSON command results programmatically

**User Story:** As a tool author, I want one fixed JSON object from each
JSON-capable command so automation can consume EF outcomes without parsing
human text.

**Main flow:** Invoke a recognized JSON-capable command with
`--format json --no-input`. For validation, query, and mutation, parse the
documented kind-specific envelope, including its explicit completeness,
nullable fields, arrays, and diagnostics, and inspect the process exit code.

**Success assertions:** Stdout is exactly one UTF-8 JSON object followed by LF,
with no prompts, ANSI escapes, or progress output; expected domain diagnostics
stay inside the envelope; human output remains non-contractual.

**Guardrails:** Unknown commands, invalid formats, or syntax that prevents
choosing an envelope yield empty stdout, a stderr diagnostic, and exit 2. Once
the envelope kind is known, later discovery or input failures use its incomplete
envelope rather than ad hoc output. `resource read` remains a raw-byte transport
and does not accept `--format`.

## UC-062 — Keep derived state disposable and deterministic

**User Story:** As an implementation, I want caches and generated state for speed without letting them alter EF truth.

**Main flow:** Maintain optional cache/index/generated data only in ignored conventional locations. Before use, compare its fingerprint to every relevant Artifact, Resource descriptor/text, config, parser/schema/Unicode/index version, and relevant integration history range; rebuild or fall back when stale.

**Success assertions:** Rebuilt and file-backed queries yield the same matches,
order, completeness, and diagnostics; stale or corrupt caches are ignored and
may be reported with the applicable informational finding.

**Guardrails:** Cache/generated/tmp/lock contents are not authoritative, committed, or validation inputs; readers never silently migrate unknown schema files.

## UC-063 — Integrate EF validation into editor feedback

**User Story:** As an editor integration author, I want on-demand diagnostics and full Artifact views so editing assistance relies on the same stable Core contract.

**Main flow:** Invoke snapshot validation and exact full lookup in JSON mode; map diagnostic project-relative paths, Unicode-scalar line/column positions, fields, sections, and related locations into the editor interface.

**Success assertions:** Integration can show deterministic whole-project findings and exact Artifact content without an LSP, daemon, watch protocol, or hidden editor-specific semantics.

**Guardrails:** Editor integration does not auto-format, repair, migrate, or convert a snapshot request into transition validation.

## UC-064 — Run authoritative CI validation

**User Story:** As CI, I want to reject an invalid candidate deterministically before the target branch moves so integrated EF state remains complete.

**Main flow:** Obtain the target-branch tip and exact candidate full commit OID; run `ef validate --scope transition --baseline <oid> --proposed <oid> --strict --format json --no-input`; review the result; then hand its expected ref state to the compare-and-swap publisher in UC-043.

**Success assertions:** EF's validation step is read-only, network-free,
cache-independent, and TTY-independent; it validates the complete candidate
tree and reports one of the four stable exits.

**Guardrails:** CI does not run Core mutation commands, format/repair/migrate, use changed-files-only validation, or publish merely because validation passed.
