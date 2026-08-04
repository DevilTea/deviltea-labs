# 02. Draft Knowledge Authoring

## UC-010 — Create a new draft Artifact

**User Story:** As an author, I want EF to create a correctly located draft so
I can refine engineering knowledge before it becomes canonical.

**Preconditions:** EF project discovery succeeds and the caller supplies a
valid type (`prd`, `req`, `adr`, `pol`, or `chg`), title, and summary.

**Main flow:**

1. The author runs `ef artifact create <type>`.
2. EF allocates the next provisional type-scoped numeric ID after the greatest
   authoritative or current provisional number visible in the working graph,
   without filling gaps.
3. EF writes one canonical `<ID>.md` file with the matching schema/type,
   `status: draft`, all nine core fields, empty collections, and its required
   H2 body headings.
4. The author directly fills in the draft body and frontmatter as needed.

**Success assertions:** The only write is one atomically created new file in
the canonical type directory; all fields are explicit; title and filename do
not replace immutable identity; draft sections may be incomplete.

**Guardrails:** The command refuses existing paths/IDs and cannot overwrite;
it does not create PROJECT or edit/activate/retire/supersede existing files.

## UC-011 — Reconcile provisional IDs before integration

**User Story:** As an author merging parallel drafts, I want to repair an ID
collision before authority is established so every issued identity remains
unique and permanent.

**Main flow:**

1. Two branches independently create a provisional same-type ID.
2. Before integration, an author atomically assigns a fresh, never-issued ID
   to one unintegrated draft, renames it to the matching canonical filename,
   and moves any owner-encoded Resource paths.
3. Every governed structured reference and Resource descriptor in the
   unintegrated proposed tree is updated explicitly.
4. Transition validation confirms no collision enters authoritative history.

**Success assertions:** Allocation advances beyond the highest authoritative or
current provisional number visible in the working graph; gaps remain valid; a
final identity is project-scoped, immutable, and never reused even after
retirement.

**Guardrails:** An issued authoritative file is neither deleted nor renamed;
collision repair is not a reason to recycle an old number.

## UC-012 — Make an Artifact structurally complete for its lifecycle

**User Story:** As an author, I want to complete the correct body schema so
readers and validators can rely on an Artifact's type and lifecycle.

**Main flow:**

1. The author places no H1 or pre-section content in the Markdown body.
2. They supply exactly-once, ordered H2 core sections: PROJECT has Vision,
   Scope, Non-goals, Context, Terminology; PRD has Problem through Non-goals;
   REQ has Requirement, Rationale, Acceptance Criteria; ADR has Context,
   Decision, Alternatives, Consequences; POL has Policy, Scope, Rationale,
   Compliance.
3. For active knowledge, they replace placeholders with meaningful content and
   provide required non-empty criterion/compliance lists.
4. They add domain detail only as custom H2 sections after core sections.

**Success assertions:** Active bodies are meaningful; PROJECT Terminology
starts with exactly one correctly headed, canonically sorted glossary table;
PRD `Success Criteria` and REQ `Acceptance Criteria` contain non-empty list
items; ADR includes a meaningful alternative; POL says how compliance is
determined.

**Guardrails:** Markdown prose does not create relations, Resources, statuses,
or effects; `TODO`, `TBD`, and `Lorem ipsum` alone do not complete active
sections; custom headings cannot duplicate core or Lifecycle headings.

## UC-013 — Model an Artifact envelope and extension safely

**User Story:** As a tool or author, I want a stable discovery envelope so
selection can happen without loading full bodies or Resource bytes.

**Main flow:**

1. The author writes every required envelope field in canonical order and
   types, including explicit empty `tags`, `relations`, and `resources`.
2. If needed, they add only namespaced `x-*` extension fields after core
   fields, using JSON-compatible values.
3. Tools preserve valid unknown extensions but derive no Core semantics from
   them.

**Success assertions:** The type/schema/id combination and canonical path
match; duplicate YAML keys, aliases, anchors, merge keys, custom tags, unknown
core fields, and wrong collection types are errors; non-canonical field order
is reported as a warning. Representation uses UTF-8, LF, NFC paths, no BOM,
and one final newline.

## UC-014 — Express explicit graph semantics

**User Story:** As an author, I want to connect knowledge with precise directed
relations so traceability and impact analysis are deterministic.

**Main flow:**

1. The author chooses the narrowest allowed relation and writes it once in
   canonical source direction: derivation, ADR coverage, policy governance,
   historical supersession, or informational reference.
2. A completed CHG alone records factual `introduces`, `modifies`, or
   `retires` effects.
3. Relations are sorted by `(type, target)` and target exact same-project IDs.

**Success assertions:** Incoming navigation is derived rather than stored;
compatibility, target existence, no self-edge, no duplicate pair, and required
active targets for new `addresses`/`governed-by` edges validate.

**Guardrails:** No generic `related-to`, inverse `supersedes`, cross-project
target, implicit relation from prose, or derived-from/supersession cycle is
accepted.

## UC-015 — Attach a Resource to one owner

**User Story:** As an author, I want to attach a contract, evidence, example,
or reference to its owning Artifact so it participates in authoritative state
without becoming a separate Artifact.

**Main flow:**

1. The author adds a complete descriptor with type, location, role, media
   type, normative boolean, and description, in canonical field/order rules.
2. For local content, they place the file under
   `.engineering/resources/<OWNER-ID>/` and use a normalized project-relative
   descriptor path.
3. They use a local Resource for normative content and an HTTP(S) URL only for
   non-normative external references.

**Success assertions:** A local file has exactly one owner and a matching
descriptor; descriptors are unique/sorted; no orphan or missing local file
exists; owner lifecycle controls Resource mutability.

**Guardrails:** External URLs are never fetched by Core validation and cannot
be normative; Resource paths cannot escape, use symlinks, or transfer between
owners, including after supersession.

## UC-016 — Choose the correct knowledge Artifact

**User Story:** As a reviewer, I want authors to store each kind of engineering
meaning in the appropriate Artifact so the graph remains understandable.

**Decision flow:** Product problem, user need, outcome, and success criteria
belong in PRD; one observable contract belongs in REQ; a significant chosen
solution/trade-off belongs in ADR; recurring cross-cutting rules belong in
POL; project boundaries and canonical language belong in PROJECT; a state
transition's rationale/evidence/effects belong in CHG; machine-readable
representations and evidence belong in Resources.

**Success assertions:** A REQ remains an observable contract rather than a
task; an ADR decision is not unresolved; external standards made authoritative
are restated locally; no separate terminology IDs or lifecycles are created.

**Guardrails:** Core validates structure and graph facts, not prose quality or
semantic taxonomy; human/agent review or optional lint owns that judgment.

## UC-017 — Record planned work in a draft CHG

**User Story:** As a change author, I want to prepare an editable transaction
record before integration so I can organize rationale, sources, changes, and
verification.

**Main flow:** Create a draft CHG using UC-010; add incomplete or pending body
sections, references, and CHG-owned evidence as necessary; edit it freely
until it becomes completed or retired.

**Success assertions:** Draft CHG is non-canonical and may be incomplete.

**Guardrails:** It has no factual effect relation; planned effects remain prose
or draft-local structure until the before/after result exists.

## UC-018 — Create drafts without a CHG

**User Story:** As an author, I want to iterate on unaccepted knowledge
without manufacturing execution history.

**Success assertions:** Draft creation/editing, draft-to-retired transition,
and pre-integration provisional collision repair can occur without a CHG.

**Guardrails:** Once active content or its Resource changes, the CHG-required
transaction path applies even to a spelling or formatting change.

## UC-019 — Preserve issued knowledge instead of deleting it

**User Story:** As a historian and reviewer, I want issued Artifacts retained
so identifiers, rationale, and change provenance remain auditable.

**Success assertions:** Issued Artifacts stay in the authoritative files;
terminal status and Git history preserve historical knowledge.

**Guardrails:** There is no delete CLI command and transition validation rejects
physical deletion of issued Artifacts.
