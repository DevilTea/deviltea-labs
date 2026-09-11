# EF Specification Review Resolutions

Status: Accepted

## Purpose

This document records the cross-file specification review performed before
implementation began, the defects it confirmed, and the resolutions applied to
the EF Core specifications. The review used ten lens-scoped reviewers over all
specification files, followed by one adversarial verifier per candidate
finding. Twenty-three candidates were raised; twelve were refuted during
verification; the remaining findings deduplicate to the seven defects below.

The numbered EF Core specifications remain normative. This document is
traceability for why they changed.

## Confirmed defects and resolutions

### 1. Filesystem, configuration, workspace, and text rules had no diagnostic codes

`11-filesystem-and-config.md` imposed MUST-level rules (config schema, config
field ordering, canonical layout, symlink prohibition, UTF-8/LF/BOM/final
newline, NFC and exact-case paths, workspace checks) but owned no diagnostic
namespace, so a conforming implementation could not emit the mandatory stable
`code` for any of them.

**Resolution.** Added the `EF-FS-*` namespace owned by
`11-filesystem-and-config.md` with codes `EF-FS-001` through `EF-FS-008`, a
`Validation` section in that specification, a namespace-ownership row in
`09-validation.md`, and registry entries. This also resolves the overlapping
finding that BOM/CRLF/final-newline/invalid-UTF-8 diagnostics planned by
`planning/00-implementation-decisions.md` had no owning check (`EF-FS-005`).

### 2. Canonical directory-path violation had no diagnostic code

`02-identity.md` declared an Artifact outside its canonical type directory
invalid and `09-validation.md` assigned canonical-path findings to `EF-ID-*`,
but no code covered a correct basename in the wrong directory.

**Resolution.** Added `EF-ID-014` (error, "Artifact file is outside its type's
canonical directory") to `02-identity.md` and the registry.

### 3. Artifact-file discovery scope was undefined

No specification defined which files are parsed as Artifacts, and the
`EF-ID-004` example in `09-validation.md` cited `archive/REQ-031.md`, implying
repository-wide scanning.

**Resolution.** Added an "Artifact discovery scope" section to
`11-filesystem-and-config.md`: exactly `PROJECT.md` plus `*.md` directly inside
the five canonical type directories are Artifact files; unexpected entries
inside `.engineering` are `EF-FS-003`; files outside `.engineering` are never
Artifacts. The `09-validation.md` example now uses
`.engineering/req/REQ-044.md`.

### 4. The Resource owner-directory rule had no diagnostic code

`06-resources.md` required local Resource locations beneath
`.engineering/resources/<OWNER-ID>/` with `<OWNER-ID>` equal to the owning
Artifact ID, but no code reported a violation.

**Resolution.** Assigned reserved slot `EF-RES-014` (error, "Local Resource
location is not beneath its owner's managed Resource directory") in
`06-resources.md` and the registry. `EF-RES-007` remains scoped to root escape
and path normalization.

### 5. `ef resource read` failure exit codes were unmapped

`13-cli-contract.md` listed five preconditions but mapped no failure class to
exit `1` versus exit `2`, and the surrounding contracts provided conflicting
precedents.

**Resolution.** Added an explicit failure-to-exit table to the Resource Reading
section: nonexistent owner, undeclared location, or wrong owner are caller
reference failures and exit `2` (consistent with the query missing-ID rule);
a declared descriptor with a missing or non-regular file, or an
integrity-violating managed path, is a domain finding and exits `1`; a
permission failure on an existing file exits `2`.

### 6. The completed CHG-182 example omitted a required effect

The `03-lifecycle.md` completed-CHG example described a supersession of
`REQ-031` but declared only `introduces REQ-070`, violating the
`07-change-transactions.md` requirement that the source modification carry a
`modifies` effect.

**Resolution.** The example now declares `modifies REQ-031` and its `## Changes`
section lists the supersession.

### 7. The retired-draft ADR example omitted required core headings

The `03-lifecycle.md` retired-draft example showed a body containing only
`## Lifecycle`, but `08-artifact-schemas.md` requires the core headings to
remain present for a draft retired before activation.

**Resolution.** The example now contains the four ADR core headings with empty
content, which the body schema permits for retirement from draft.

## Refuted candidates

Twelve candidates were refuted with evidence during adversarial verification,
including: an alleged single-CHG-per-supersession conflict between
`05-supersession.md` and `07-change-transactions.md` (the multi-CHG allowance
requires disjoint effect sets, which one implementation can satisfy);
`EF-CHG-001` absence from the registry (namespaces may begin above `-001`;
nothing references the code); UC-060's "completion marker" wording (its
described semantics match the normative marker protocol); and several
overview-versus-detail wording differences covered by the overview's explicit
deference clause.

## Verification

The review and verification transcripts are session artifacts rather than
repository state. Every resolution above was applied to the owning
specification and `diagnostic-registry.md` in the same change, per the
registry maintenance rules.
