/**
 * Snapshot validation pipeline (09-validation.md "Validation Pipeline",
 * "Snapshot scope", "Cascading Diagnostics") and validation summary semantics
 * (09-validation.md "Validation Summary", "CI Contract").
 *
 * `validateSnapshot` composes the already-verified domain and repository
 * validators over one `ProjectSnapshot` (./snapshot) in the spec's phase
 * order, respecting cascading suppression, and produces the aggregated,
 * deterministically ordered diagnostic list plus derived indexes
 * (`byId`, incoming relation edges, Resource ownership, current-canonical
 * resolution, CHG effect edges) for the transition/query layer to reuse
 * without recomputing them.
 *
 * CHG net-effect classification, coverage, and truthfulness (`EF-CHG-002`,
 * `003`, `005`, `006`, `007`, `012`), lifecycle-transition legality, and
 * every other before/after comparison are out of snapshot scope
 * (09-validation.md "Snapshot validation cannot prove ... CHG effect
 * truthfulness ... because those checks require a trusted previous state.")
 * and are left for the transition-validation module to add once a baseline
 * is available; this module exposes the CHG effect edges it already knows
 * about (from the current graph's `introduces`/`modifies`/`retires`
 * relations) so that module does not need to re-derive them.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope, RelationType, Status } from '../domain/model'
import type { RelationGraphArtifact } from '../domain/relations'
import type { LocalResourceFileEntry, LocalResourceFileState, ResourceOwnershipEntry } from '../domain/resources'
import type { SupersessionGraphFact } from '../domain/supersession'
import type { ExtractedSections } from '../parsing/markdown'
import type { SymlinkFact } from '../repository/symlinks'
import type { PathNormalizationEntry } from '../repository/text-normalization'
import type { ProjectSnapshot, SnapshotEntryKind } from './snapshot'
import { validateBody } from '../domain/body-schemas'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { validateFilename, validateGraphIdentity, validateIdSyntax } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { RELATION_TYPES } from '../domain/model'
import { validateRelationEntries, validateRelationGraph } from '../domain/relations'
import {
	findOrphanResourceFiles,
	validateLocalResourceFiles,
	validateResourceDescriptors,
	validateResourceOwnership,
} from '../domain/resources'
import { resolveCurrent, validateSupersessionGraph } from '../domain/supersession'
import { splitFrontmatter } from '../parsing/frontmatter'
import { detectInvalidUtf8 } from '../platform/text-checks'
import { checkManagedSymlinks, managedSymlinkPaths } from '../repository/symlinks'
import { checkPathNormalization, checkTextNormalization } from '../repository/text-normalization'
import { rawArrayField } from './snapshot-raw-fields'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** One successfully decoded Artifact, reduced to the facts the graph indexes need. */
export interface SnapshotArtifactRecord {
	path: string
	id: string
	type: ArtifactType
	status: Status
	envelope: Envelope
	/** Relation entries that passed `validateRelationEntries`' own shape and vocabulary checks. */
	relations: RelationGraphArtifact['relations']
}

export interface IncomingRelationEdge {
	from: string
	type: RelationType
}

export interface ChgEffectEdge {
	chgId: string
	type: Extract<RelationType, 'introduces' | 'modifies' | 'retires'>
	target: string
}

export interface SnapshotValidationResult {
	/** Complete, deduplicated, deterministically ordered diagnostics (09-validation "Diagnostic aggregation"). */
	diagnostics: Diagnostic[]
	/** `false` only when the validator lacked context or capability required by snapshot scope (09-validation "Validation completeness"). */
	complete: boolean
	/** Every successfully decoded Artifact, keyed by its declared ID. Excludes files whose envelope failed to decode and files whose ID duplicates another file's (ambiguous; see 09-validation "Cascading Diagnostics"). */
	byId: ReadonlyMap<string, SnapshotArtifactRecord>
	/** Outgoing relation edges, indexed by target Artifact ID. */
	incomingRelations: ReadonlyMap<string, IncomingRelationEdge[]>
	/** Local Resource `location` -> the Artifact IDs that declare it (usually one; more than one is `EF-RES-009`). */
	resourceOwnership: ReadonlyMap<string, string[]>
	/** Artifact ID -> its current-resolution result (05-supersession "Current-resolution algorithm"); `[]` when resolution failed or the root is a CHG. */
	currentIds: ReadonlyMap<string, string[]>
	/** Every `introduces`/`modifies`/`retires` edge declared by a CHG whose relation entries passed shape/vocabulary validation. */
	chgEffects: ChgEffectEdge[]
	/**
	 * `false` when a parse/identity/layout condition prevents ANY query
	 * result over this snapshot from being complete and trustworthy
	 * (10-query-and-trace.md "Invalid Graph and Partial Results"): an
	 * Artifact file failed to decode, a layout entry could itself be an
	 * unparsed Artifact (`EF-FS-003`), or one of the identity findings whose
	 * ID/graph-membership consequence is untrustworthy rather than merely
	 * cosmetic -- `EF-ID-001`/`002`/`003` (the declared ID itself is
	 * malformed, wrong-prefix, or non-canonical, so whatever this file
	 * contributes to the graph is keyed on a fact that is not truly its ID),
	 * `EF-ID-004`/`006` (duplicate ID / PROJECT-singleton ambiguity), or
	 * `EF-ID-007`/`008` (PROJECT missing, or present under the wrong ID, so
	 * required project context is absent from the graph exactly as if no
	 * PROJECT existed). `EF-ID-005` (filename does not match ID) and
	 * `EF-ID-014` (file outside its canonical directory) do NOT gate: the
	 * declared ID itself is unique and decoded correctly in both cases, so
	 * `byId` and its dependent indexes remain trustworthy even though the
	 * file/layout convention is violated (that violation is reported on its
	 * own merits, independent of query trustworthiness). Callers building a
	 * `QueryContext` gate every query kind -- including exact lookup -- on
	 * this.
	 */
	graphTrustworthy: boolean
	/**
	 * Artifact IDs (by their own declared `id`) whose raw `relations` array
	 * had at least one entry excluded while `validateRelationEntries`
	 * sanitized it into the subset this module indexes the graph from, in a
	 * way that can make a graph edge `(source, type, target)` missing:
	 * `EF-REL-001` (unknown relation type), `EF-REL-002` (shape-invalid
	 * entry), or `EF-REL-005` (self-relation) -- OR that leaves a
	 * graph-integrity-invalid DUPLICATE `(type, target)` pair present in that
	 * subset instead of removing it: `EF-REL-006` (sixth-round Finding 7;
	 * `validateRelationEntries` reports the duplicate but does not exclude
	 * either occurrence from its returned `entries`, so this Artifact's own
	 * outgoing edge set is not reliably what it declares even though nothing
	 * was actually discarded). Every graph-traversal query kind (`relations`,
	 * `trace`, `impact`, `resolve-current`) walks
	 * `incomingRelations`/`byId[].relations`/`chgEffects`, all built from that
	 * sanitized subset across the whole project, so a discarded OR duplicated
	 * entry on any Artifact -- not only the one a given traversal starts from
	 * -- could be a missing or corrupted edge that traversal should not have
	 * silently trusted (Finding A, 10-query-and-trace.md "Invalid Graph and
	 * Partial Results": "MUST NOT return a partial graph ... that an Agent
	 * could mistake for complete context"). The query layer (Finding C)
	 * scopes exactly how far this reaches per traversal instead of always
	 * gating project-wide.
	 *
	 * `EF-REL-015` (invalid/non-JSON-compatible extension field) is
	 * deliberately EXCLUDED from this set: it only ever discards extension
	 * metadata alongside an otherwise-intact, still-indexed `(type, target)`
	 * pair, and every graph query's edges contain only `(source, type,
	 * target)` -- no edge is missing (Finding C). It is tracked separately in
	 * `relationExtensionLossArtifactIds` and folded into
	 * `projectionLossArtifactIds` instead.
	 *
	 * Also includes an Artifact whose top-level `relations` key (or a key
	 * nested within one `relations[i]` entry) is duplicated (`EF-ENV-005`,
	 * duplicate-key trust-scope adjudication): the file declares two
	 * conflicting candidate arrays for its own outgoing relations, and
	 * 01-artifact-envelope.md forbids resolving to either, so the actual
	 * outgoing edge set this Artifact declares could not be reliably
	 * determined -- the same graph-traversal-untrustworthy fact as an entry
	 * sanitized away by `validateRelationEntries` itself, gated the same
	 * direction-aware way (unlike an `id`/`type` duplicate, which makes the
	 * Artifact's own IDENTITY uncertain and so blocks `graphTrustworthy`
	 * project-wide instead -- see `envelopeStructuralLossArtifactIds`'s doc).
	 *
	 * `EF-REL-003` (dangling relation target) is deliberately NOT one of the
	 * codes tracked here either: it is a graph-integrity finding about a
	 * PRESENT, fully-sanitized entry whose target does not exist, already
	 * caught by the traversal itself reaching a missing `byId` node
	 * (`EF-QRY-007`), not a sanitization discard.
	 */
	edgeLossArtifactIds: ReadonlySet<string>
	/**
	 * Subset of `edgeLossArtifactIds` whose loss could NOT be attributed to
	 * one specific relation type (sixth-round Finding 9): `EF-REL-001`
	 * (unknown vocabulary) and `EF-REL-002` (shape-invalid, possibly missing
	 * `type` entirely) always land here, and a duplicated `relations` key
	 * (`EF-ENV-005`) does too, since no single entry's index identifies which
	 * type(s) are actually uncertain. A source in this set must gate an
	 * outgoing-only traversal regardless of the traversal's own selected
	 * relation type set -- the conservative behavior every artifact-scoped
	 * edge-trust check already applied before this round. Contrast with
	 * `edgeLossRelationTypesBySourceId`.
	 */
	edgeLossUntypedArtifactIds: ReadonlySet<string>
	/**
	 * Per-source relation types a TYPED `edgeLossArtifactIds` cause
	 * (`EF-REL-005`/`006`) actually identified (sixth-round Finding 9): an
	 * outgoing-only traversal restricted to a type set that does not
	 * intersect this source's recorded types here (and the source is absent
	 * from `edgeLossUntypedArtifactIds`) could never have read or returned
	 * the lossy entry, so it must not be gated by it. A source with NO typed
	 * loss recorded is simply absent from this map, even if it IS present in
	 * `edgeLossArtifactIds`/`edgeLossUntypedArtifactIds`.
	 */
	edgeLossRelationTypesBySourceId: ReadonlyMap<string, ReadonlySet<RelationType>>
	/**
	 * Artifact IDs whose raw `relations` array had an entry with a valid
	 * `type`/`target` pair but an invalid or non-JSON-compatible extension
	 * field (`EF-REL-015`) -- metadata-only loss that never removes a graph
	 * edge (see `edgeLossArtifactIds`'s doc). Folded into
	 * `projectionLossArtifactIds` below since a `lookup`/`list`/`search`
	 * projection of this Artifact still reflects the sanitization, not the
	 * raw declared extension content.
	 */
	relationExtensionLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs whose raw `resources` array had at least one entry
	 * `validateResourceDescriptors` flagged `EF-RES-001` for: either the
	 * entry itself was not a YAML mapping (entirely omitted from
	 * `envelope.resources`, `domain/envelope.ts`'s `decodeEnvelope`), or a
	 * present entry was missing/malformed a required core field (that field
	 * silently decoded to its empty/default value -- `''`/`false` -- instead
	 * of the file's actual, malformed content). Either way, this Artifact's
	 * raw decoded `resources` diverges from what the file declares.
	 */
	resourceLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs whose raw `tags` array had at least one non-string entry
	 * silently dropped during decode (`domain/envelope.ts` only collects
	 * string tag entries into `envelope.tags`; a non-string entry is skipped
	 * entirely, distinct from an invalid-pattern or duplicate string tag,
	 * both of which are kept). Detected structurally by comparing the raw
	 * array's entry count against the decoded `envelope.tags.length`, rather
	 * than by diagnostic code (every entry-content problem under `tags[i]`
	 * shares `EF-ENV-012`, including the invalid-pattern/duplicate cases that
	 * do NOT lose data), so this set is exact -- never a false positive.
	 */
	tagLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs with an `EF-ENV-007` (top-level `x-*` extension: an
	 * unnamespaced field name, entirely dropped rather than kept -- see
	 * `domain/envelope.ts`'s unknown-field classification -- or a non-finite
	 * numeric value) or `EF-RES-019` (a Resource `x-*` extension or unknown
	 * field with the same two failure modes) finding. A non-finite number is
	 * preserved verbatim in memory (`nodeToPlainValue`'s doc), but every
	 * JSON-based consumer of a query result -- the CLI's own output --
	 * silently launders it to `null` at serialization time (`JSON.stringify`),
	 * so this Artifact's projection is untrustworthy either way (seventh-round
	 * Finding 7).
	 */
	extensionValueLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs with an envelope-wide loss that can corrupt any of its
	 * core fields (not only relations/resources/tags): `EF-ENV-005` (a
	 * duplicate mapping key anywhere in the frontmatter -- the parser keeps
	 * exactly one of the conflicting values, discarding the other
	 * unrecoverably) or `EF-ENV-006` (an unrecognized top-level field, which
	 * `decodeEnvelope` drops entirely rather than preserving as an
	 * extension). Because either code can affect a field a `list`/`search`
	 * request filters or searches on (including `type`/`status`/`schema`,
	 * not just relations/resources/tags), a request that applies ANY filter
	 * cannot trust its matching/total while an Artifact in this set exists
	 * (see `query.ts`'s Finding B handling).
	 */
	envelopeWideLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs (by their own declared, first-occurrence-selected `id`)
	 * whose frontmatter has an `EF-ENV-005` duplicate mapping key on `id` or
	 * `type` -- the two fields that determine this file's own identity and
	 * graph membership. `domain/envelope.ts`'s field selection is
	 * deterministic (first occurrence wins, matching `rawArrayField`'s own
	 * selection -- fifth-round Finding 5), but the file itself remains invalid
	 * regardless of which declared value wins: "MUST NOT resolve to either"
	 * per 01-artifact-envelope.md ("Duplicate mapping keys are invalid even if
	 * a YAML parser would otherwise select one of the values"). Because a
	 * duplicate on `id` or `type` means this file's own declared identity --
	 * which Artifact ID it even IS, or what type it declares itself as -- was
	 * never reliably known (the file could equally be read as declaring
	 * either alternative), this is treated exactly like
	 * `EF-ID-001`/`002`/`003` (`graphTrustworthy`'s doc, identity-uncertain):
	 * it blocks `graphTrustworthy` project-wide rather than being merely this
	 * one Artifact's own concern, since an Agent looking up either candidate
	 * ID could otherwise be silently misled.
	 *
	 * A duplicate key on any OTHER field is deliberately EXCLUDED from this
	 * set (duplicate-key trust-scope adjudication, following fifth-round
	 * Finding 5): the file's OWN identity is not in question there, only some
	 * other fact it declares, so each is folded into the narrower,
	 * already-existing bucket that fact's own uncertainty belongs to instead
	 * of a project-wide gate -- a duplicate `relations` key (including nested
	 * within one `relations[i]` entry) is folded into `edgeLossArtifactIds`
	 * (this Artifact's own outgoing edge set could not be reliably determined,
	 * gated the same direction-aware way as any other edge-loss cause), a
	 * duplicate `status` key is folded into `statusInvalidArtifactIds` (this
	 * Artifact's own lifecycle-status fact could not be reliably determined,
	 * consumed by `impact`/`resolve-current`), and a duplicate
	 * `resources`/`tags`/`schema`/`title`/`summary`/any-other-field key is
	 * left to `envelopeWideLossArtifactIds` alone (folded into
	 * `projectionLossArtifactIds`), which fires unconditionally for ANY
	 * `EF-ENV-005` regardless of field and so is always ALSO true whenever
	 * this set is -- this Artifact's own `lookup`/`list`/`search` projection
	 * is gated the same way no matter which of these buckets its duplicate
	 * key falls into.
	 */
	envelopeStructuralLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs whose raw file bytes contain invalid UTF-8 (`EF-FS-005`,
	 * already reported by `checkTextNormalization`): the best-effort decode
	 * `platform/text-checks.ts`'s callers rely on (`TextDecoder(...,
	 * {fatal:false})`) replaces the offending byte(s) with U+FFFD, so any
	 * text derived from this Artifact -- `title`, `summary`, tag/relation/
	 * Resource string fields, or the Markdown body -- can silently embed a
	 * replacement character in place of content the file never actually
	 * declared. Folded into `projectionLossArtifactIds` (seventh-round Finding
	 * 7): `lookup`/`list`/`search` must not report `complete: true` while
	 * projecting or indexing that text as though it were faithful.
	 */
	byteDecodingLossArtifactIds: ReadonlySet<string>
	/**
	 * The union of every artifact-loss set above (`edgeLossArtifactIds`,
	 * `relationExtensionLossArtifactIds`, `resourceLossArtifactIds`,
	 * `tagLossArtifactIds`, `envelopeWideLossArtifactIds`,
	 * `extensionValueLossArtifactIds`, `byteDecodingLossArtifactIds`): any
	 * Artifact whose raw decoded envelope
	 * -- the object `lookup`/`list`/`search` project verbatim
	 * (`query-projection.ts`), not the sanitized graph-index subset -- silently
	 * discarded or coerced some structured content, whether or not a graph
	 * edge was also lost. A `lookup`/`list`/`search` result that would project
	 * this specific Artifact's envelope must not report `complete: true` while
	 * doing so (Finding A). `envelopeStructuralLossArtifactIds` is deliberately
	 * NOT unioned in here again (it is already a subset of
	 * `envelopeWideLossArtifactIds`, whose EF-ENV-005 detection is
	 * field-unscoped).
	 */
	projectionLossArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs (the SOURCE side) with a relation entry that is shape-valid
	 * and vocabulary-known but semantically invalid per `validateRelationGraph`
	 * (04-relations.md): `EF-REL-004` (source/target type incompatible for
	 * that relation type) or `EF-REL-008` (the entry participates in a
	 * `derived-from` cycle). Deliberately NOT folded into
	 * `projectionLossArtifactIds`: the entry is fully present and faithfully
	 * reflects the file's declared `(type, target)` pair in the raw projection
	 * -- nothing is dropped or coerced -- so this is a graph-TRUST fact, not a
	 * projection-loss fact (sixth-round Finding 6). A graph-traversal query
	 * kind that would otherwise walk this edge as though it were a
	 * trustworthy, semantically valid relation must not do so silently.
	 */
	semanticEdgeLossArtifactIds: ReadonlySet<string>
	/**
	 * Per-source relation types a `semanticEdgeLossArtifactIds` diagnostic
	 * identified (sixth-round Finding 9): `EF-REL-004` always names the exact
	 * relation type that is source/target-incompatible; `EF-REL-008` is
	 * always `derived-from` (the only type its cycle check applies to). Every
	 * entry in `semanticEdgeLossArtifactIds` has a corresponding entry here --
	 * unlike `edgeLossRelationTypesBySourceId`, there is no untyped case for
	 * this bucket -- so an outgoing-only traversal can always narrow this
	 * check to exactly the types it actually reads.
	 */
	semanticEdgeLossRelationTypesBySourceId: ReadonlyMap<string, ReadonlySet<RelationType>>
	/**
	 * Artifact IDs whose decoded `status` failed `validateStatus`
	 * (03-lifecycle.md): `EF-LIFE-001` (not a member of the status vocabulary)
	 * or `EF-LIFE-002` (a known status not allowed for this Artifact's type).
	 * The raw projection still faithfully reflects the file's declared
	 * `status` string either way (nothing is dropped/coerced), so this is NOT
	 * folded into `projectionLossArtifactIds`; it is a graph-TRUST fact
	 * consumed specifically by algorithms that branch on `status` --
	 * `impact`'s current-candidate pruning and `resolve-current`'s traversal
	 * (sixth-round Finding 6) -- which must not silently treat an invalid
	 * status as though it were a legitimate non-active/non-current value.
	 *
	 * Also includes an Artifact whose `status` key is duplicated
	 * (`EF-ENV-005`, duplicate-key trust-scope adjudication): the file
	 * declares two conflicting candidate status values, and
	 * 01-artifact-envelope.md forbids resolving to either, so the actual
	 * lifecycle-status fact this Artifact declares could not be reliably
	 * determined -- the same branch-on-an-unverified-status untrustworthiness
	 * as `EF-LIFE-001`/`002` (unlike an `id`/`type` duplicate, which makes the
	 * Artifact's own IDENTITY uncertain and so blocks `graphTrustworthy`
	 * project-wide instead -- see `envelopeStructuralLossArtifactIds`'s doc).
	 */
	statusInvalidArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs (the SOURCE side) with at least one `superseded-by` target
	 * of a different Artifact type (`EF-SUP-003`, 05-supersession.md).
	 * `domain/supersession.ts#resolveCurrent`'s own traversal does not check
	 * type compatibility (only existence, status, and cycles), so a cross-type
	 * replacement can otherwise be silently followed as though it were a
	 * legitimate supersession. NOT folded into `projectionLossArtifactIds`
	 * (the declared edge is faithfully reflected, not lost); a graph-trust
	 * fact consumed by `resolve-current` (and `impact`'s `resolve_current`
	 * option) (sixth-round Finding 6).
	 */
	supersessionCrossTypeArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs (by their own declared `id`) with an invalid per-artifact
	 * supersession fact, keyed from `EF-SUP-001`/`002`/`003`/`005`
	 * (05-supersession.md, sixth-round Finding 6) -- a strict superset of
	 * `supersessionCrossTypeArtifactIds` (kept separately above for its own,
	 * narrower cross-type-specific tests/consumers):
	 *
	 * - `EF-SUP-001`: a `superseded` Artifact with no direct replacement.
	 *   `domain/supersession.ts#resolveCurrent`'s own traversal treats this
	 *   exactly like a legitimate empty resolution (`currentIds: []`, zero
	 *   edges) -- indistinguishable from "correctly retired with no
	 *   replacement" (05-supersession "Retired replacement leaves") without
	 *   this fact.
	 * - `EF-SUP-002`: a non-`superseded` Artifact illegally declaring
	 *   `superseded-by`. `resolveCurrent` never reads a node's
	 *   `superseded-by` array once its status is `active`/`draft`/`retired`,
	 *   so this fact can never surface as a traversed edge -- only as the
	 *   INPUT (or an intermediate node) itself, resolved as though the
	 *   illegal declaration did not exist.
	 * - `EF-SUP-003`: cross-type replacement (also in
	 *   `supersessionCrossTypeArtifactIds`).
	 * - `EF-SUP-005`: every participant of a direct or indirect supersession
	 *   cycle (the diagnostic's own `artifactId` plus every `related` entry).
	 *
	 * Both zero-edge cases above (`EF-SUP-001`/`002`) mean a traversal can
	 * reach an invalid supersession fact WITHOUT following any
	 * `superseded-by` edge at all -- including when the AFFECTED Artifact is
	 * the exact input ID. The query layer therefore checks this set against
	 * EVERY node current resolution actually visits (`nodeIds`), not only the
	 * source side of a followed edge, unlike `edgeLossArtifactIds`'s
	 * consumed-source scoping. NOT folded into `projectionLossArtifactIds`
	 * (every declared fact here is faithfully reflected, not lost); consumed
	 * by `resolve-current` (and `impact`'s `resolve_current` option).
	 */
	supersessionFactInvalidArtifactIds: ReadonlySet<string>
	/**
	 * Artifact IDs whose raw `resources` array had at least one `EF-RES-001`
	 * finding, reduced to exactly WHICH named Resource fields were affected
	 * across every entry (`type`, `location`, `role`, `media_type`,
	 * `normative`, `description`) rather than a single project-wide-opaque
	 * "this Artifact has some Resource loss" boolean. An entry that was not a
	 * mapping at all (entirely omitted from `envelope.resources`) is recorded
	 * as losing every named field, since none of its declared content survived
	 * decoding. Ninth-round Finding 9: `list`'s `resourceType`/`resourceRole`/
	 * `resourceNormative` filters and `search`'s `resources.location`/
	 * `resources.description` surfaces each only care about the specific
	 * fields they actually read; a malformed `normative` field, for example,
	 * must not gate a search that never reads `normative`.
	 */
	resourceFieldLossById: ReadonlyMap<string, ReadonlySet<ResourceFieldName>>
	/**
	 * Artifact IDs (by their own declared `id`) whose discovered file path is
	 * itself explicitly non-canonical, tracked SEPARATELY from
	 * `graphTrustworthy` (seventh-round Finding 6): `EF-ID-005` (filename does
	 * not exactly match the declared ID), `EF-ID-014` (file outside its type's
	 * canonical directory), or an `EF-FS-006` finding whose `path` names this
	 * Artifact's own file (the discovered path is not itself
	 * Unicode-NFC-normalized -- see `checkPathNormalization`'s doc; a
	 * Resource-location `EF-FS-006` is deliberately excluded, since that
	 * finding names a Resource's declared `location`, not any Artifact's own
	 * path).
	 *
	 * `graphTrustworthy`'s own doc already explains why `EF-ID-005`/`014` do
	 * NOT gate query trustworthiness project-wide: the declared `id` itself is
	 * still unique and correctly decoded, so `byId` and every dependent index
	 * remain trustworthy. But 10-query-and-trace.md fixes a projected
	 * Artifact's `path` field as ITS canonical, project-relative path, while
	 * `buildArtifactSummary`/`buildArtifactFull` (`query-projection.ts`)
	 * project the actual discovered path verbatim (Finding A: raw,
	 * unsanitized projection) -- so for exactly this Artifact, the projected
	 * `path` is explicitly wrong. The query layer gates only the specific
	 * result that would project one of these Artifacts (`lookup`/`list`/
	 * `search` results, or a graph traversal's node set) with `EF-QRY-013`,
	 * leaving every unrelated Artifact's result unaffected -- the same
	 * per-node scoping `projectionLossArtifactIds` already uses, kept as its
	 * own separate set here (rather than folded into
	 * `projectionLossArtifactIds`) because the untrustworthy fact is
	 * specifically the `path` field, not the envelope content
	 * `projectionLossArtifactIds`'s causes corrupt.
	 */
	pathTrustLossArtifactIds: ReadonlySet<string>
}

/** A Resource descriptor's named core fields (06-resources.md), for `resourceFieldLossById`'s per-field loss granularity (Finding 9). */
export type ResourceFieldName = 'type' | 'location' | 'role' | 'media_type' | 'normative' | 'description'

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

function makeValDiagnostic(code: 'EF-VAL-004' | 'EF-VAL-007', message: string, path?: string, artifactId?: string): Diagnostic {
	return { code, severity: severityOf(code), message, path, artifactId, related: [] }
}

// ---------------------------------------------------------------------------
// Finding 8 (seventh-round): `.engineering/.gitignore` presence + exact content
// ---------------------------------------------------------------------------

const GITIGNORE_PATH = '.engineering/.gitignore'

/**
 * 11-filesystem-and-config.md: "`.engineering/.gitignore` is a tracked
 * PROJECT-owned control file with these exact Core v1 entries", LF-terminated
 * with exactly one final newline, in this exact order.
 */
const GITIGNORE_CANONICAL_BYTES = new TextEncoder()
	.encode('.cache/\n.generated/\n.tmp/\n.lock\n')

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length)
		return false
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i])
			return false
	}
	return true
}

function makeFsDiagnostic(code: 'EF-FS-009', message: string, path: string): Diagnostic {
	return { code, severity: severityOf(code), message, path, related: [] }
}

/**
 * `domain/envelope.ts` reports `EF-ENV-004` for a `relations[i]`/`resources[i]`
 * entry that is not a YAML mapping (its own documented "every entry must be a
 * mapping" rule). `domain/relations.ts`/`domain/resources.ts` independently
 * report the same "not a mapping" condition as `EF-REL-002`/`EF-RES-001` --
 * the diagnostics 09-validation.md's precedence table explicitly names as the
 * primary finding for that exact violation ("Relation entry is not a mapping
 * or lacks a required field -> EF-REL-002"). This filters out the redundant,
 * broader `EF-ENV-004` so only the more specific relation/resource-owned
 * diagnostic survives; `EF-ENV-004` for every other field (a genuinely
 * missing/malformed core field) is unaffected, since `envelope.ts` only ever
 * emits this exact `field` shape for the "not a mapping" array-entry case.
 */
const ARRAY_ENTRY_SHAPE_FIELD = /^(?:relations|resources)\[\d+\]$/

function withoutRedundantArrayEntryShapeFindings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	return diagnostics.filter(d => !(d.code === 'EF-ENV-004' && d.field !== undefined && ARRAY_ENTRY_SHAPE_FIELD.test(d.field)))
}

/**
 * `validateRelationEntries` (04-relations.md) codes that exclude an entry
 * from the sanitized subset in a way that can make a graph edge
 * `(source, type, target)` missing (`EF-REL-001`/`002`/`005`; see
 * `SnapshotValidationResult.edgeLossArtifactIds` for the full reasoning,
 * Finding A/C), OR that leave a graph-integrity-invalid DUPLICATE
 * `(type, target)` pair present in the sanitized subset instead of removing
 * it (`EF-REL-006`, sixth-round Finding 7): either way, a graph-traversal
 * query kind that would otherwise walk this Artifact's outgoing array as
 * though it were completely and correctly sanitized must not do so silently.
 */
const EDGE_LOSS_RELATION_CODES = new Set<string>(['EF-REL-001', 'EF-REL-002', 'EF-REL-005', 'EF-REL-006'])

/**
 * `EF-REL-001` (unknown relation type) and `EF-REL-002` (shape-invalid entry)
 * can never identify a specific relation type this Artifact's outgoing edge
 * set actually lost (sixth-round Finding 9): an unrecognized vocabulary value
 * is by definition not a `RelationType` to intersect against a query's
 * selected type set, and a shape-invalid entry may be missing its `type`
 * field entirely. Both are always treated as untyped/conservative for
 * `edgeLossUntypedArtifactIds` regardless of what `rawRelationEntryType`
 * could otherwise resolve.
 */
const FORCED_UNTYPED_EDGE_LOSS_CODES = new Set<string>(['EF-REL-001', 'EF-REL-002'])

const KNOWN_RELATION_TYPE_SET: ReadonlySet<string> = new Set(RELATION_TYPES)

function relationEntriesHaveEdgeLoss(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => EDGE_LOSS_RELATION_CODES.has(d.code))
}

function relationEntriesHaveExtensionLoss(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.code === 'EF-REL-015')
}

/** Extracts the numeric `relations[N]` array index a diagnostic's `field` names, or `undefined` when `field` does not name one at all. */
function relationEntryIndexFromField(field: string | undefined): number | undefined {
	if (field === undefined)
		return undefined
	const match = /^relations\[(\d+)\]/.exec(field)
	return match ? Number(match[1]) : undefined
}

/**
 * The known `RelationType` the RAW entry at `rawRelations[index]` itself
 * declares, or `undefined` when `index` is out of range, the entry is not a
 * mapping, or its `type` field is not a recognized EF Core relation type
 * (sixth-round Finding 9: an entry whose vocabulary is itself unrecognized
 * cannot be intersected against a query's selected type set, so it falls
 * back to untyped/conservative instead).
 */
function rawRelationEntryType(rawRelations: readonly unknown[], index: number | undefined): RelationType | undefined {
	if (index === undefined)
		return undefined
	const raw = rawRelations[index]
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return undefined
	const type = (raw as Record<string, unknown>).type
	return typeof type === 'string' && KNOWN_RELATION_TYPE_SET.has(type) ? (type as RelationType) : undefined
}

/**
 * Classifies one `EDGE_LOSS_RELATION_CODES` diagnostic into `untyped` or
 * `typed` (sixth-round Finding 9): `EF-REL-001`/`002` always fall to
 * `untyped` (`FORCED_UNTYPED_EDGE_LOSS_CODES`); `EF-REL-005`/`006` are typed
 * whenever the raw entry's own `type` field resolves to a known
 * `RelationType` (`rawRelationEntryType`), falling back to `untyped` only in
 * the defensive case where it does not (a shape that should not arise in
 * practice, since both codes already require a valid `type` field to have
 * been reached).
 */
function recordEdgeLossType(untyped: Set<string>, typed: Map<string, Set<RelationType>>, artifactId: string, code: string, rawRelations: readonly unknown[], field: string | undefined): void {
	if (!FORCED_UNTYPED_EDGE_LOSS_CODES.has(code)) {
		const type = rawRelationEntryType(rawRelations, relationEntryIndexFromField(field))
		if (type) {
			const set = typed.get(artifactId) ?? new Set<RelationType>()
			set.add(type)
			typed.set(artifactId, set)
			return
		}
	}
	untyped.add(artifactId)
}

/**
 * The exact `RelationType` an `EF-REL-004`/`EF-REL-008` semantic-edge-loss
 * diagnostic identifies (sixth-round Finding 9): `EF-REL-008` is always
 * `derived-from` (the only relation type its cycle check ever applies to);
 * `EF-REL-004`'s `field` names the exact index within `relationById`'s
 * already-typed, sanitized entry array whose `type` this diagnostic's own
 * SOURCE Artifact declares.
 */
function semanticEdgeLossType(diagnostic: Diagnostic, relationById: ReadonlyMap<string, RelationGraphArtifact>): RelationType | undefined {
	if (diagnostic.code === 'EF-REL-008')
		return 'derived-from'
	if (diagnostic.code !== 'EF-REL-004' || diagnostic.artifactId === undefined)
		return undefined
	const index = relationEntryIndexFromField(diagnostic.field)
	if (index === undefined)
		return undefined
	return relationById.get(diagnostic.artifactId)?.relations[index]?.type
}

// ---------------------------------------------------------------------------
// Finding 5 (duplicate-key trust-scope adjudication): EF-ENV-005 field
// classification
//
// A duplicate mapping key can land in one of three DIFFERENT trust buckets
// depending on WHICH field it duplicates, rather than one blanket
// project-wide gate for every graph-relevant field:
//
//   - `id`/`type`: this file's own declared IDENTITY is uncertain (it could
//     equally be read as declaring either candidate value) -- folded into
//     `envelopeStructuralLossArtifactIds`, the same identity-uncertain bucket
//     as `EF-ID-001`/`002`/`003`, blocking `graphTrustworthy` project-wide.
//   - `relations` (top-level, or nested within one `relations[i]` entry):
//     only this Artifact's own OUTGOING EDGE SET is uncertain, not its
//     identity -- folded into `edgeLossArtifactIds`, scoped by the query
//     layer's existing direction-aware edge-trust gates exactly like any
//     other edge-loss cause.
//   - `status`: only this Artifact's own LIFECYCLE-STATUS FACT is uncertain
//     -- folded into `statusInvalidArtifactIds`, consumed only by
//     `impact`/`resolve-current` exactly like an `EF-LIFE-001`/`002` invalid
//     status.
//   - `resources`/`tags`/`schema`/`title`/`summary`/any other field: no
//     graph fact this file contributes is uncertain (or the field is not
//     graph-relevant at all); `envelopeWideLossArtifactIds` (which fires
//     unconditionally for ANY `EF-ENV-005`, regardless of field) already
//     covers this Artifact's own projection-loss concern -- no further
//     bucket needed.
// ---------------------------------------------------------------------------

/**
 * Whether an `EF-ENV-005` diagnostic's `field` (the exact duplicated key
 * path, e.g. `'relations'` for a duplicated top-level key or
 * `'relations[2].type'` for a duplicated key nested inside one entry) names
 * `name` itself or a path nested under it.
 */
function duplicateKeyFieldNames(field: string | undefined, name: string): boolean {
	if (field === undefined)
		return false
	return field === name || field.startsWith(`${name}[`) || field.startsWith(`${name}.`)
}

/** `id`/`type`: the two fields whose duplication makes this file's own declared identity uncertain (folded into `envelopeStructuralLossArtifactIds`). */
const IDENTITY_DUPLICATE_KEY_FIELDS = ['id', 'type']

function isIdentityDuplicateKeyField(field: string | undefined): boolean {
	return IDENTITY_DUPLICATE_KEY_FIELDS.some(name => duplicateKeyFieldNames(field, name))
}

// ---------------------------------------------------------------------------
// Finding 7: byte-decoding loss and its frontmatter/body reach
// ---------------------------------------------------------------------------

/**
 * The exact raw-byte offset at which `bytes`' authoritative body text begins
 * (i.e. the length, in bytes, of the opening delimiter line through the
 * closing `---` delimiter's line terminator), or `undefined` when `bytes`
 * does not split into frontmatter/body at all. Decodes `bytes` as ISO-8859-1
 * (a lossless one-byte-to-one-code-unit mapping, unlike the best-effort UTF-8
 * decode `snapshot.ts` uses to build `SnapshotArtifactFile.text`) so the
 * ASCII structural markers `splitFrontmatter` looks for (`-`, CR, LF) are
 * recovered at their exact original byte positions even when `bytes` contains
 * invalid UTF-8 elsewhere -- letting `detectInvalidUtf8`'s byte offset be
 * compared directly against this boundary to tell whether the invalid byte
 * falls within the frontmatter (where it could corrupt `id`/`type`/`status`/
 * `relations`/`resources`/`tags`) or only within the Markdown body.
 */
function frontmatterByteLength(bytes: Uint8Array): number | undefined {
	const latin1 = new TextDecoder('iso-8859-1')
		.decode(bytes)
	const split = splitFrontmatter(latin1)
	if (!split.ok)
		return undefined
	return latin1.length - split.bodyText.length
}

// ---------------------------------------------------------------------------
// Finding 9: per-named-field Resource loss
// ---------------------------------------------------------------------------

const RESOURCE_FIELD_NAMES: readonly ResourceFieldName[] = ['type', 'location', 'role', 'media_type', 'normative', 'description']
const RESOURCE_FIELD_NAME_SET: ReadonlySet<string> = new Set(RESOURCE_FIELD_NAMES)
const RESOURCE_ENTRY_FIELD_PATTERN = /^resources\[\d+\](?:\.(.+))?$/

/**
 * Records which named Resource field(s) one `EF-RES-001` diagnostic affects
 * for `artifactId` into `target`: the exact sub-field named by the
 * diagnostic's `field` (e.g. `'resources[0].normative'` -> `'normative'`)
 * when there is one, or -- when the diagnostic instead names the whole entry
 * (`'resources[0]'`, "must be a mapping") -- every named field, since none of
 * that entry's declared content survived decoding at all. Ignores every other
 * diagnostic code and any `field` that does not match a `resources[i]` entry
 * shape.
 */
function addResourceFieldLoss(target: Map<string, Set<ResourceFieldName>>, artifactId: string, diagnostic: Diagnostic): void {
	if (diagnostic.code !== 'EF-RES-001' || diagnostic.field === undefined)
		return
	const match = RESOURCE_ENTRY_FIELD_PATTERN.exec(diagnostic.field)
	if (!match)
		return
	const subField = match[1]
	const set = target.get(artifactId) ?? new Set<ResourceFieldName>()
	if (subField !== undefined && RESOURCE_FIELD_NAME_SET.has(subField)) {
		set.add(subField as ResourceFieldName)
	}
	else {
		for (const name of RESOURCE_FIELD_NAMES) set.add(name)
	}
	target.set(artifactId, set)
}

/** Structured-location identity, ignoring message text (mirrors `diagnostics.ts`'s own dedup key, minus `code`). */
function diagnosticShapeIdentity(d: Diagnostic): string {
	return JSON.stringify([d.path ?? null, d.artifactId ?? null, d.location ?? null, d.field ?? null, d.section ?? null])
}

// ---------------------------------------------------------------------------
// validateSnapshot
// ---------------------------------------------------------------------------

interface FileOutcome {
	path: string
	envelope: Envelope
	relations: RelationGraphArtifact['relations']
}

function fileStateFor(kind: SnapshotEntryKind | undefined): LocalResourceFileState {
	if (kind === 'file')
		return 'file'
	if (kind === 'directory')
		return 'directory'
	if (kind === 'symlink')
		return 'symlink'
	return 'missing'
}

function isExternalLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

/**
 * Whether `location` is a syntactically valid LOCAL Resource location
 * (06-resources.md "Location classification"/"Local path resolution"): not
 * an external HTTP(S) URL, no other URI scheme, no backslash, does not
 * escape the project root, and has no empty/`.`/`..` path segment. Narrowly
 * mirrors `domain/resources.ts`'s own `analyzeLocation` local-valid branch --
 * duplicated as a small yes/no predicate here (rather than imported) because
 * this module only needs the local-ownership question, not that function's
 * full classification result.
 *
 * 06-resources.md "External URLs do not have exclusive ownership. The same
 * URL MAY appear once in each of multiple Artifacts.": only a location this
 * predicate accepts may participate in cross-Artifact ownership tracking
 * (`EF-RES-009`) below.
 */
function isValidLocalLocation(location: string): boolean {
	if (location.length === 0 || isExternalLocation(location))
		return false
	if (location.includes(':') || location.includes('\\'))
		return false
	if (location.startsWith('/') || location.startsWith('~'))
		return false
	return !location.split('/')
		.some(segment => segment === '' || segment === '.' || segment === '..')
}

/**
 * Whether a `draft` Artifact's body content is genuinely incomplete: rerun
 * `validateBody` as though the Artifact had reached the status whose
 * completeness rules are the strictest available for its type (`active` for
 * knowledge Artifacts, `completed` for CHG), and check whether that surfaces
 * any diagnostic the real `draft`-mode validation did not already report.
 * Comparing diagnostic identity (rather than hand-picking codes) reuses
 * `validateBody`'s own completeness logic exactly instead of duplicating it.
 */
function draftContentIsIncomplete(input: { type: ArtifactType, path: string, body: ExtractedSections }, realDiagnostics: readonly Diagnostic[]): boolean {
	const probeStatus: Status = input.type === 'change' ? 'completed' : 'active'
	const probeDiagnostics = validateBody({ type: input.type, status: probeStatus, path: input.path, body: input.body })
	const realIdentities = new Set(realDiagnostics.map(d => JSON.stringify([d.code, diagnosticShapeIdentity(d)])))
	return probeDiagnostics.some(d => !realIdentities.has(JSON.stringify([d.code, diagnosticShapeIdentity(d)])))
}

export function validateSnapshot(snapshot: ProjectSnapshot): SnapshotValidationResult {
	const diagnostics: Diagnostic[] = []
	let complete = true

	// ---- Phase 1/2/3: discovery, config, layout ----------------------------

	diagnostics.push(...snapshot.config.diagnostics)
	if (snapshot.configBytes === undefined) {
		complete = false
		diagnostics.push(makeValDiagnostic('EF-VAL-007', 'No \'.engineering/ef.yaml\' configuration was found in the validated snapshot.'))
	}
	else {
		diagnostics.push(...checkTextNormalization('.engineering/ef.yaml', snapshot.configBytes))
	}
	// Finding 8 (seventh-round): `.engineering/.gitignore` is a tracked
	// PROJECT-owned control file that MUST exist with exactly the four
	// canonical entries (11-filesystem-and-config.md); absence or divergence
	// was previously silently accepted. `EF-FS-005` (encoding-level violation:
	// invalid UTF-8, forbidden BOM, CRLF, or missing final newline) keeps
	// precedence for the same file -- EF-FS-009 only fires when this file's
	// own text-normalization pass reported nothing, so an already-reported
	// encoding-level defect is never doubled up with a redundant EF-FS-009.
	if (snapshot.gitignoreBytes === undefined) {
		diagnostics.push(makeFsDiagnostic('EF-FS-009', `Required control file '${GITIGNORE_PATH}' is missing; it must contain the four canonical entries, in order, this specification defines.`, GITIGNORE_PATH))
	}
	else {
		const gitignoreTextNormalizationDiagnostics = checkTextNormalization(GITIGNORE_PATH, snapshot.gitignoreBytes)
		diagnostics.push(...gitignoreTextNormalizationDiagnostics)
		if (gitignoreTextNormalizationDiagnostics.length === 0 && !bytesEqual(snapshot.gitignoreBytes, GITIGNORE_CANONICAL_BYTES))
			diagnostics.push(makeFsDiagnostic('EF-FS-009', `Control file '${GITIGNORE_PATH}' does not exactly match the four canonical entries, in order, this specification defines.`, GITIGNORE_PATH))
	}

	diagnostics.push(...snapshot.layoutDiagnostics)

	// ---- Phase 2..8 per file: parse, envelope, identity, status, relations, --
	// ---- resources, body ----------------------------------------------------

	const fileOutcomes: FileOutcome[] = []
	// Whether any Artifact file could not be decoded into a `fileOutcomes`
	// entry at all (frontmatter split or envelope decode failure). A `list`,
	// `search`, or unrelated `lookup` result computed while this is `true`
	// could silently omit that Artifact from an otherwise `complete: true`
	// result (10-query-and-trace.md "Invalid Graph and Partial Results": "MUST
	// NOT return a partial ... collection that an Agent could mistake for
	// complete context"); `graphTrustworthy` below folds this into every
	// query's own completeness gate.
	let hasUndecodedArtifact = false

	// Per-artifact structured-data-loss tracking (Finding A/B/C) -- see each
	// field's doc on `SnapshotValidationResult` for what is discarded/coerced
	// and why it matters to query trustworthiness.
	const edgeLossArtifactIds = new Set<string>()
	const edgeLossUntypedArtifactIds = new Set<string>()
	const edgeLossRelationTypesBySourceId = new Map<string, Set<RelationType>>()
	const relationExtensionLossArtifactIds = new Set<string>()
	const resourceLossArtifactIds = new Set<string>()
	const tagLossArtifactIds = new Set<string>()
	const envelopeWideLossArtifactIds = new Set<string>()
	// Finding 5/6/7/9 fact tracking -- see each field's doc on
	// `SnapshotValidationResult`.
	const envelopeStructuralLossArtifactIds = new Set<string>()
	const byteDecodingLossArtifactIds = new Set<string>()
	const semanticEdgeLossArtifactIds = new Set<string>()
	const semanticEdgeLossRelationTypesBySourceId = new Map<string, Set<RelationType>>()
	const statusInvalidArtifactIds = new Set<string>()
	const supersessionCrossTypeArtifactIds = new Set<string>()
	const supersessionFactInvalidArtifactIds = new Set<string>()
	const resourceFieldLossById = new Map<string, Set<ResourceFieldName>>()
	const extensionValueLossArtifactIds = new Set<string>()
	// Finding 6 (seventh-round): `EF-ID-005`/`EF-ID-014` fact tracking; the
	// artifact-path `EF-FS-006` contribution is folded in further below, once
	// `checkPathNormalization` has run (`pathTrustLossArtifactIds`'s doc).
	const pathTrustLossArtifactIds = new Set<string>()

	for (const artifact of snapshot.artifacts) {
		if (!artifact.frontmatter.ok) {
			diagnostics.push({ ...artifact.frontmatter.diagnostic, path: artifact.path })
			hasUndecodedArtifact = true
			continue
		}

		diagnostics.push(...artifact.document!.diagnostics)

		const envelopeResult = artifact.envelope!
		diagnostics.push(...withoutRedundantArrayEntryShapeFindings(envelopeResult.diagnostics))

		if (artifact.body && !artifact.body.ok)
			diagnostics.push({ ...artifact.body.diagnostic, path: artifact.path })

		const envelope = envelopeResult.envelope
		if (!envelope) {
			hasUndecodedArtifact = true
			continue
		}

		diagnostics.push(...validateIdSyntax({ type: envelope.type, id: envelope.id }, artifact.path))
		const filenameDiagnostics = validateFilename({ type: envelope.type, id: envelope.id }, artifact.path)
		diagnostics.push(...filenameDiagnostics)
		// Finding 6 (seventh-round): `EF-ID-005` (filename mismatch) or
		// `EF-ID-014` (wrong canonical directory) each make this Artifact's own
		// discovered path non-canonical, even though -- unlike
		// `envelopeStructuralLossArtifactIds` -- its declared `id` remains
		// unique and correctly decoded, so `graphTrustworthy` itself stays
		// unaffected (`pathTrustLossArtifactIds`'s doc).
		if (filenameDiagnostics.some(d => d.code === 'EF-ID-005' || d.code === 'EF-ID-014'))
			pathTrustLossArtifactIds.add(envelope.id)

		const statusDiagnostics = validateStatus({ type: envelope.type, status: envelope.status, id: envelope.id }, artifact.path)
		diagnostics.push(...statusDiagnostics)
		if (statusDiagnostics.length > 0)
			statusInvalidArtifactIds.add(envelope.id)

		// Finding 7: invalid UTF-8 anywhere in the file's raw bytes (already
		// reported as `EF-FS-005` below, by the text-normalization pass) means
		// the best-effort decode this Artifact's `text`/`envelope`/`sections`
		// were all built from replaced at least one malformed byte with
		// U+FFFD. When that byte falls within the frontmatter block (rather
		// than only the Markdown body), WHICH field it corrupted cannot be
		// narrowed down the way an `EF-ENV-005` diagnostic's `field` can be, so
		// -- unlike the duplicate-key case above, which is scoped per field
		// (Finding 5 adjudication) -- any frontmatter-range corruption is
		// conservatively treated as though it could have corrupted `id`/`type`
		// themselves, folding this Artifact into
		// `envelopeStructuralLossArtifactIds` the same identity-uncertain way.
		const invalidUtf8 = detectInvalidUtf8(artifact.bytes)
		if (invalidUtf8) {
			byteDecodingLossArtifactIds.add(envelope.id)
			const bodyStartByte = frontmatterByteLength(artifact.bytes)
			if (bodyStartByte === undefined || invalidUtf8.offset < bodyStartByte)
				envelopeStructuralLossArtifactIds.add(envelope.id)
		}

		// Finding 5 (duplicate-key trust-scope adjudication): a duplicate
		// mapping key is folded into a DIFFERENT trust bucket depending on
		// which field it duplicates -- see the "Finding 5" section comment
		// above `isIdentityDuplicateKeyField`'s definition for the full
		// rationale.
		const duplicateKeyDiagnostics = artifact.document!.diagnostics.filter(d => d.code === 'EF-ENV-005')
		// `id`/`type`: this file's own declared identity is uncertain --
		// `envelopeStructuralLossArtifactIds`'s doc, same bucket as
		// `EF-ID-001`/`002`/`003`.
		if (duplicateKeyDiagnostics.some(d => isIdentityDuplicateKeyField(d.field)))
			envelopeStructuralLossArtifactIds.add(envelope.id)
		// `relations` (top-level or nested within one entry): only this
		// Artifact's own outgoing edge set is uncertain -- fold into
		// `edgeLossArtifactIds`'s doc, gated the same direction-aware way as
		// any other edge-loss cause instead of blocking `graphTrustworthy`
		// project-wide. No single entry index identifies which relation
		// type(s) are actually uncertain, so this is always untyped/
		// conservative (Finding 9), unlike a single lossy entry.
		if (duplicateKeyDiagnostics.some(d => duplicateKeyFieldNames(d.field, 'relations'))) {
			edgeLossArtifactIds.add(envelope.id)
			edgeLossUntypedArtifactIds.add(envelope.id)
		}
		// `status`: only this Artifact's own lifecycle-status fact is
		// uncertain -- fold into `statusInvalidArtifactIds`'s doc, consumed
		// only by `impact`/`resolve-current`.
		if (duplicateKeyDiagnostics.some(d => duplicateKeyFieldNames(d.field, 'status')))
			statusInvalidArtifactIds.add(envelope.id)

		const mapping = artifact.document!.mapping
		const rawRelations = mapping ? rawArrayField(mapping, 'relations') : []
		const rawResources = mapping ? rawArrayField(mapping, 'resources') : []
		const rawTags = mapping ? rawArrayField(mapping, 'tags') : []

		const relationResult = validateRelationEntries({ id: envelope.id, relations: rawRelations }, artifact.path)
		diagnostics.push(...relationResult.diagnostics)
		if (relationEntriesHaveEdgeLoss(relationResult.diagnostics))
			edgeLossArtifactIds.add(envelope.id)
		// Finding 9: attribute each edge-loss diagnostic to the specific
		// relation type it identifies, when it identifies one at all.
		for (const d of relationResult.diagnostics) {
			if (EDGE_LOSS_RELATION_CODES.has(d.code))
				recordEdgeLossType(edgeLossUntypedArtifactIds, edgeLossRelationTypesBySourceId, envelope.id, d.code, rawRelations, d.field)
		}
		if (relationEntriesHaveExtensionLoss(relationResult.diagnostics))
			relationExtensionLossArtifactIds.add(envelope.id)

		const resourceDiagnostics = validateResourceDescriptors({ id: envelope.id, resources: rawResources }, artifact.path)
		diagnostics.push(...resourceDiagnostics)
		if (resourceDiagnostics.some(d => d.code === 'EF-RES-001'))
			resourceLossArtifactIds.add(envelope.id)
		for (const d of resourceDiagnostics)
			addResourceFieldLoss(resourceFieldLossById, envelope.id, d)

		// Finding 7: `EF-ENV-007` (top-level extension) and `EF-RES-019`
		// (Resource extension) findings -- `extensionValueLossArtifactIds`'s doc.
		if (envelopeResult.diagnostics.some(d => d.code === 'EF-ENV-007') || resourceDiagnostics.some(d => d.code === 'EF-RES-019'))
			extensionValueLossArtifactIds.add(envelope.id)

		// A non-string tag entry is silently skipped by `decodeEnvelope` (never
		// appended to `envelope.tags`), unlike an invalid-pattern or duplicate
		// string tag (both of which are kept, sharing the same `EF-ENV-012`
		// code) -- so entry-count shrinkage is the only reliable, code-free
		// signal that a tag was actually lost (`tagLossArtifactIds`'s doc).
		if (rawTags.length > envelope.tags.length)
			tagLossArtifactIds.add(envelope.id)

		// `EF-ENV-005` (duplicate mapping key, reported by the parsing module
		// against this same file, anywhere in its frontmatter) and `EF-ENV-006`
		// (unrecognized top-level field, entirely dropped rather than kept as
		// an extension) can each corrupt any core field, not only
		// relations/resources/tags (`envelopeWideLossArtifactIds`'s doc).
		if (artifact.document!.diagnostics.some(d => d.code === 'EF-ENV-005') || envelopeResult.diagnostics.some(d => d.code === 'EF-ENV-006'))
			envelopeWideLossArtifactIds.add(envelope.id)

		if (artifact.sections) {
			const bodyDiagnostics = validateBody({ type: envelope.type, status: envelope.status, path: artifact.path, body: artifact.sections })
			diagnostics.push(...bodyDiagnostics)

			if (envelope.status === 'draft' && draftContentIsIncomplete({ type: envelope.type, path: artifact.path, body: artifact.sections }, bodyDiagnostics))
				diagnostics.push(makeValDiagnostic('EF-VAL-004', `Draft content for '${envelope.id}' is incomplete, which its lifecycle status permits.`, artifact.path, envelope.id))
		}

		fileOutcomes.push({ path: artifact.path, envelope, relations: relationResult.entries })
	}

	// ---- Phase 5/6: graph construction and graph integrity ------------------

	diagnostics.push(...validateGraphIdentity(fileOutcomes.map(o => ({ id: o.envelope.id, type: o.envelope.type, path: o.path }))))

	// 02-identity.md "Duplicate handling": "graph validation MUST NOT resolve
	// the ID to either file; tooling MUST NOT infer a canonical copy." Count
	// every declared ID first so every dependent index below -- `byId`,
	// relation-graph/supersession construction, `incomingRelations`,
	// `currentIds`, and `chgEffects` -- can exclude an ambiguous ID entirely
	// instead of the prior code silently keeping an arbitrary one of the
	// colliding files (a `Map` construction overwrites earlier entries for a
	// repeated key). A relation entry that TARGETS an ambiguous ID is excluded
	// the same way its target's own outgoing relations are: reporting it as a
	// dangling target (`EF-REL-003`) would be a speculative secondary
	// diagnostic once `EF-ID-004` already reports the collision
	// (09-validation.md "Cascading Diagnostics").
	const idCounts = new Map<string, number>()
	for (const outcome of fileOutcomes)
		idCounts.set(outcome.envelope.id, (idCounts.get(outcome.envelope.id) ?? 0) + 1)
	const ambiguousIds = new Set<string>([...idCounts.entries()].filter(([, count]) => count > 1)
		.map(([id]) => id))

	const resolvedOutcomes = fileOutcomes.filter(o => !ambiguousIds.has(o.envelope.id))

	function withoutAmbiguousTargets(relations: RelationGraphArtifact['relations']): RelationGraphArtifact['relations'] {
		return relations.filter(r => !ambiguousIds.has(r.target))
	}

	const relationGraphArtifacts: RelationGraphArtifact[] = resolvedOutcomes.map(o => ({
		path: o.path,
		id: o.envelope.id,
		type: o.envelope.type,
		relations: withoutAmbiguousTargets(o.relations),
	}))
	const relationById = new Map(relationGraphArtifacts.map(a => [a.id, a] as const))
	const relationGraphDiagnostics = validateRelationGraph(relationGraphArtifacts, relationById)
	diagnostics.push(...relationGraphDiagnostics)
	// Finding 6: an edge that is shape-valid and vocabulary-known but
	// semantically incompatible (`EF-REL-004`) or part of a `derived-from`
	// cycle (`EF-REL-008`) still exists as a graph edge -- both diagnostics
	// carry the SOURCE Artifact's own `artifactId`, which is exactly the fact
	// a traversal that walks this edge as trustworthy is missing.
	for (const d of relationGraphDiagnostics) {
		if ((d.code === 'EF-REL-004' || d.code === 'EF-REL-008') && d.artifactId !== undefined) {
			semanticEdgeLossArtifactIds.add(d.artifactId)
			// Finding 9: both codes always identify one specific relation type.
			const type = semanticEdgeLossType(d, relationById)
			if (type) {
				const set = semanticEdgeLossRelationTypesBySourceId.get(d.artifactId) ?? new Set<RelationType>()
				set.add(type)
				semanticEdgeLossRelationTypesBySourceId.set(d.artifactId, set)
			}
		}
	}

	const supersessionFacts: SupersessionGraphFact[] = resolvedOutcomes
		.filter(o => o.envelope.type !== 'change')
		.map(o => ({
			id: o.envelope.id,
			type: o.envelope.type,
			status: o.envelope.status,
			supersededBy: withoutAmbiguousTargets(o.relations)
				.filter(r => r.type === 'superseded-by')
				.map(r => r.target),
		}))
	const supersessionGraphDiagnostics = validateSupersessionGraph(supersessionFacts)
	diagnostics.push(...supersessionGraphDiagnostics)
	// Finding 6: `EF-SUP-003` (cross-type replacement) carries the SOURCE
	// Artifact's own `artifactId` -- `resolveCurrent`'s own traversal never
	// checks type compatibility, so this fact must be supplied here instead.
	// `EF-SUP-001`/`002`/`005` are folded into the broader
	// `supersessionFactInvalidArtifactIds` alongside it (sixth-round Finding
	// 6): `resolveCurrent`'s own traversal can reach an invalid supersession
	// fact -- an empty replacement set, an illegal declaration on a
	// non-superseded node, or a cycle -- without ever following an edge that
	// reveals it (see that field's doc for the zero-edge reasoning).
	for (const d of supersessionGraphDiagnostics) {
		if (d.code === 'EF-SUP-003' && d.artifactId !== undefined) {
			supersessionCrossTypeArtifactIds.add(d.artifactId)
			supersessionFactInvalidArtifactIds.add(d.artifactId)
		}
		if ((d.code === 'EF-SUP-001' || d.code === 'EF-SUP-002') && d.artifactId !== undefined)
			supersessionFactInvalidArtifactIds.add(d.artifactId)
		if (d.code === 'EF-SUP-005') {
			if (d.artifactId !== undefined)
				supersessionFactInvalidArtifactIds.add(d.artifactId)
			for (const rel of d.related) {
				if (rel.artifactId !== undefined)
					supersessionFactInvalidArtifactIds.add(rel.artifactId)
			}
		}
	}

	const incomingRelations = new Map<string, IncomingRelationEdge[]>()
	for (const artifact of relationGraphArtifacts) {
		for (const relation of artifact.relations) {
			const edges = incomingRelations.get(relation.target) ?? []
			edges.push({ from: artifact.id, type: relation.type })
			incomingRelations.set(relation.target, edges)
		}
	}

	const currentIds = new Map<string, string[]>()
	for (const fact of supersessionFacts) {
		const result = resolveCurrent(fact.id, supersessionFacts)
		currentIds.set(fact.id, result.ok ? result.currentIds : [])
	}

	const chgEffects: ChgEffectEdge[] = []
	for (const outcome of resolvedOutcomes) {
		if (outcome.envelope.type !== 'change')
			continue
		for (const relation of withoutAmbiguousTargets(outcome.relations)) {
			if (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires')
				chgEffects.push({ chgId: outcome.envelope.id, type: relation.type, target: relation.target })
		}
	}

	// ---- Phase 7: resource integrity ----------------------------------------

	const ownershipEntries: ResourceOwnershipEntry[] = []
	const localFileEntries: LocalResourceFileEntry[] = []
	const declaredLocations = new Set<string>()
	for (const outcome of fileOutcomes) {
		for (const resource of outcome.envelope.resources) {
			if (resource.location.length === 0)
				continue
			declaredLocations.add(resource.location)
			// Only a syntactically valid LOCAL location is exclusively owned
			// (06-resources.md); an external URL, or the same URL declared by
			// several Artifacts, must not be reported as EF-RES-009. The
			// within-one-Artifact duplicate-location check (`EF-RES-008`)
			// already covers every location -- local or external -- inside
			// `validateResourceDescriptors` and is unaffected by this filter.
			if (isValidLocalLocation(resource.location))
				ownershipEntries.push({ artifactId: outcome.envelope.id, path: outcome.path, location: resource.location })
			localFileEntries.push({ artifactId: outcome.envelope.id, path: outcome.path, location: resource.location })
		}
	}
	diagnostics.push(...validateResourceOwnership(ownershipEntries))

	const fileFacts = new Map<string, LocalResourceFileState>()
	for (const location of declaredLocations)
		fileFacts.set(location, fileStateFor(snapshot.entryKinds.get(location)))
	diagnostics.push(...validateLocalResourceFiles(localFileEntries, fileFacts))

	const managedRootFiles = snapshot.resourceFiles.filter(entry => entry.kind === 'file')
		.map(entry => entry.path)
	diagnostics.push(...findOrphanResourceFiles(managedRootFiles, declaredLocations))

	const resourceOwnership = new Map<string, string[]>()
	for (const entry of ownershipEntries) {
		const owners = resourceOwnership.get(entry.location) ?? []
		if (!owners.includes(entry.artifactId))
			owners.push(entry.artifactId)
		resourceOwnership.set(entry.location, owners)
	}

	// ---- Text normalization, layout, and symlink diagnostics ----------------

	for (const artifact of snapshot.artifacts)
		diagnostics.push(...checkTextNormalization(artifact.path, artifact.bytes))

	const localResourceLocations = [...declaredLocations].filter(location => !isExternalLocation(location))
	const symlinkPaths = managedSymlinkPaths({
		artifactFiles: snapshot.artifacts.map(a => a.path),
		resourceFiles: localResourceLocations,
	})
	const symlinkFacts: SymlinkFact[] = symlinkPaths.map(p => ({ path: p, isSymlink: snapshot.entryKinds.get(p) === 'symlink' }))
	diagnostics.push(...checkManagedSymlinks(symlinkFacts))

	// 11-filesystem-and-config.md "exact filesystem case": resolve each
	// declared local Resource location to its discovered case-preserving path
	// -- already captured, verbatim from the walked filesystem, as
	// `snapshot.entryKinds`' keys -- so `checkPathNormalization` can compare
	// declared case against actual case and report `EF-FS-006` for a
	// wrong-case descriptor, instead of that mismatch only ever surfacing (if
	// at all) as an ordinary EF-RES-006 "missing" finding. Artifact files
	// need no such resolution: `snapshot.artifacts[].path` already IS the
	// walked, case-preserving path used to read them.
	//
	// On a case-sensitive filesystem, `snapshot.entryKinds` can legitimately
	// contain BOTH `Foo.json` and `foo.json` as distinct discovered entries.
	// A `location` that names one of them EXACTLY must resolve to itself --
	// checked first, directly against `entryKinds`, before any case-folding --
	// rather than being compared against whichever spelling happened to be
	// discovered first and arbitrarily kept for that case-folded key (Finding
	// B: that prior behavior rejected a descriptor that exactly named the
	// OTHER, real, on-disk file as wrong-case). The case-fold fallback below
	// is reserved for a `location` that does not exactly match any discovered
	// path, and is itself ambiguity-aware: when more than one on-disk entry
	// folds to the same lowercase key, there is no non-arbitrary candidate to
	// report as "the" actual path, so it resolves to `undefined` (leaving the
	// separate "file does not exist" finding, `EF-RES-006`, as the only
	// diagnostic for that genuinely-not-matched spelling) instead of guessing.
	const discoveredPathsByLowercase = new Map<string, string[]>()
	for (const discoveredPath of snapshot.entryKinds.keys()) {
		const key = discoveredPath.toLowerCase()
		const candidates = discoveredPathsByLowercase.get(key)
		if (candidates)
			candidates.push(discoveredPath)
		else
			discoveredPathsByLowercase.set(key, [discoveredPath])
	}
	function resolveActualPath(location: string): string | undefined {
		if (snapshot.entryKinds.has(location))
			return location
		const candidates = discoveredPathsByLowercase.get(location.toLowerCase())
		return candidates?.length === 1 ? candidates[0] : undefined
	}

	const pathNormalizationEntries: PathNormalizationEntry[] = [
		...snapshot.artifacts.map(a => ({ path: a.path })),
		...localResourceLocations.map(location => ({ path: location, actualPath: resolveActualPath(location) })),
	]
	const pathNormalizationDiagnostics = checkPathNormalization(pathNormalizationEntries)
	diagnostics.push(...pathNormalizationDiagnostics)
	// Finding 6 (seventh-round): fold an `EF-FS-006` whose `path` names one of
	// THIS Artifact's own discovered paths (not a Resource `location`, which
	// also flows through `checkPathNormalization` above) into
	// `pathTrustLossArtifactIds`. Built from `fileOutcomes` (every Artifact
	// whose envelope decoded, including an ambiguous-ID one) rather than
	// `resolvedOutcomes`/`byId`: an ambiguous ID already blocks
	// `graphTrustworthy` project-wide, so whether it is additionally present
	// here is immaterial to any query result.
	const artifactIdByPath = new Map(fileOutcomes.map(o => [o.path, o.envelope.id] as const))
	for (const d of pathNormalizationDiagnostics) {
		if (d.code !== 'EF-FS-006' || d.path === undefined)
			continue
		const affectedId = artifactIdByPath.get(d.path)
		if (affectedId !== undefined)
			pathTrustLossArtifactIds.add(affectedId)
	}

	const byId = new Map<string, SnapshotArtifactRecord>()
	for (const outcome of resolvedOutcomes) {
		byId.set(outcome.envelope.id, {
			path: outcome.path,
			id: outcome.envelope.id,
			type: outcome.envelope.type,
			status: outcome.envelope.status,
			envelope: outcome.envelope,
			relations: outcome.relations,
		})
	}

	// 10-query-and-trace.md "Invalid Graph and Partial Results": a query
	// result is untrustworthy whenever an error condition prevented an
	// Artifact file from being decoded (`hasUndecodedArtifact`), flagged a
	// layout entry that could itself be an unparsed Artifact (`EF-FS-003`),
	// or made the graph's identity/membership facts themselves untrustworthy:
	//
	// - `EF-ID-004` (duplicate ID) / `EF-ID-006` (more than one PROJECT):
	//   ambiguity -- graph validation deliberately excludes the colliding
	//   ID from `byId` rather than picking one file, so any query result
	//   naming or omitting it would be a guess.
	// - `EF-ID-007` (no PROJECT Artifact) / `EF-ID-008` (PROJECT declares an
	//   ID other than `PROJECT`): required PROJECT context is absent from the
	//   graph. Without this, `lookup PROJECT` would return the ordinary
	//   `complete: true, found: false` result and `list`/`search` would
	//   return an otherwise-"complete" collection, even though mandatory
	//   project context never loaded.
	// - `EF-ID-001`/`002`/`003` (ID missing/malformed, wrong type prefix, or
	//   non-canonical numeric component): the file's own declared identity is
	//   defective, so whatever it contributed to `byId`/relation/supersession
	//   indexes is keyed on a fact that was never truly its ID -- the same
	//   graph-membership untrustworthiness `EF-ID-004`/`006` already gate on.
	//
	// `EF-ID-005` (filename does not match ID) and `EF-ID-014` (file outside
	// its canonical directory) are deliberately excluded: in both cases the
	// declared ID itself is unique and decoded correctly, so `byId` and every
	// dependent index remain trustworthy even though the file/layout
	// convention is violated -- that violation is reported on its own merits
	// and does not need to block every query kind. Every other diagnostic
	// (body-schema, resource, ordering warnings, ...) likewise leaves every
	// already-decoded Artifact in the graph and does not affect this.
	const BLOCKING_IDENTITY_OR_LAYOUT_CODES = new Set<string>([
		'EF-ID-001',
		'EF-ID-002',
		'EF-ID-003',
		'EF-ID-004',
		'EF-ID-006',
		'EF-ID-007',
		'EF-ID-008',
		'EF-FS-003',
	])
	const hasBlockingIdentityOrLayoutFinding = diagnostics.some(d => BLOCKING_IDENTITY_OR_LAYOUT_CODES.has(d.code))
	// Finding 5 (duplicate-key trust-scope adjudication): a duplicate mapping
	// key on `id`/`type` (`envelopeStructuralLossArtifactIds`'s doc) is not
	// detected by a fixed diagnostic-code bucket the way the codes above are
	// -- `EF-ENV-005` also fires for a duplicate `relations`/`status`/
	// `resources`/`tags`/`schema`/`title`/`summary`, none of which gate here
	// (each is folded into a narrower, non-blocking bucket instead -- see the
	// "Finding 5" section comment above `isIdentityDuplicateKeyField`'s
	// definition) -- so it is folded in directly as its own precisely-scoped
	// fact rather than added to `BLOCKING_IDENTITY_OR_LAYOUT_CODES`.
	const graphTrustworthy = !hasUndecodedArtifact && !hasBlockingIdentityOrLayoutFinding && envelopeStructuralLossArtifactIds.size === 0

	const projectionLossArtifactIds = new Set<string>([
		...edgeLossArtifactIds,
		...relationExtensionLossArtifactIds,
		...resourceLossArtifactIds,
		...tagLossArtifactIds,
		...envelopeWideLossArtifactIds,
		...byteDecodingLossArtifactIds,
		...extensionValueLossArtifactIds,
	])

	return {
		diagnostics: aggregateDiagnostics(diagnostics),
		complete,
		byId,
		incomingRelations,
		resourceOwnership,
		currentIds,
		chgEffects,
		graphTrustworthy,
		edgeLossArtifactIds,
		edgeLossUntypedArtifactIds,
		edgeLossRelationTypesBySourceId,
		relationExtensionLossArtifactIds,
		resourceLossArtifactIds,
		tagLossArtifactIds,
		envelopeWideLossArtifactIds,
		extensionValueLossArtifactIds,
		envelopeStructuralLossArtifactIds,
		byteDecodingLossArtifactIds,
		projectionLossArtifactIds,
		semanticEdgeLossArtifactIds,
		semanticEdgeLossRelationTypesBySourceId,
		statusInvalidArtifactIds,
		supersessionCrossTypeArtifactIds,
		supersessionFactInvalidArtifactIds,
		resourceFieldLossById,
		pathTrustLossArtifactIds,
	}
}

// ---------------------------------------------------------------------------
// summarizeValidation
// ---------------------------------------------------------------------------

export type ValidationScope = 'snapshot' | 'transition' | 'bootstrap'

export interface ValidationPolicy {
	strict: boolean
	warningsAsErrors: boolean
}

export interface ValidationRefs {
	baselineOid?: string | null
	proposedOid?: string | null
	integrationRef?: string | null
	expectedRefOid?: string | null
}

export interface SummarizeValidationInput {
	scope: ValidationScope
	/** Diagnostics from `validateSnapshot` (or a transition/bootstrap orchestrator); re-aggregated defensively. */
	diagnostics: readonly Diagnostic[]
	/** Whether the validator had every required context/capability for `scope` (09-validation "Validation completeness"). */
	complete: boolean
	/** Set by the caller when an internal invariant failed (`EF-VAL-008`); forces exit `3` regardless of `complete`. */
	internalFailure?: boolean
	policy: ValidationPolicy
	refs?: ValidationRefs
}

export interface ValidationCounts {
	error: number
	warning: number
	info: number
}

export interface ValidationSummary {
	scope: ValidationScope
	baselineOid: string | null
	proposedOid: string | null
	integrationRef: string | null
	expectedRefOid: string | null
	strict: boolean
	/** Effective warnings-as-errors, `true` whenever `strict` is `true` (09-validation "Strict mode is equivalent to: warnings-as-errors + ..."). */
	warningsAsErrors: boolean
	complete: boolean
	valid: boolean
	counts: ValidationCounts
	exitCode: 0 | 1 | 2 | 3
}

/**
 * Compute the 09-validation.md "Validation Summary" object: `valid`/`complete`
 * interplay, deduplicated counts, and exit-code priority
 * (`internal failure (3) > incomplete (2) > invalid findings (1) > success (0)`).
 *
 * `complete`/`internalFailure` are caller-supplied facts rather than inferred
 * from diagnostic codes: this module has no registry of which `EF-VAL-*` code
 * maps to which exit class (that mapping lives in the owning specification,
 * not in `diagnostic-codes.ts`'s severity-only table), so a caller that emits
 * an exit-class-`2` or `3` `EF-VAL-*` diagnostic MUST also set `complete:
 * false` (or `internalFailure: true`) at the same call site.
 */
export function summarizeValidation(input: SummarizeValidationInput): ValidationSummary {
	const aggregated = aggregateDiagnostics(input.diagnostics)
	const counts: ValidationCounts = { error: 0, warning: 0, info: 0 }
	for (const d of aggregated)
		counts[d.severity] += 1

	const strict = input.policy.strict
	const warningsAsErrors = input.policy.warningsAsErrors || strict
	const internalFailure = input.internalFailure ?? false
	const refs = input.refs ?? {}

	let complete: boolean
	let valid: boolean
	let exitCode: 0 | 1 | 2 | 3

	if (internalFailure) {
		complete = false
		valid = false
		exitCode = 3
	}
	else if (!input.complete) {
		complete = false
		valid = false
		exitCode = 2
	}
	else {
		complete = true
		const fails = counts.error > 0 || (counts.warning > 0 && warningsAsErrors)
		valid = !fails
		exitCode = fails ? 1 : 0
	}

	return {
		scope: input.scope,
		baselineOid: refs.baselineOid ?? null,
		proposedOid: refs.proposedOid ?? null,
		integrationRef: refs.integrationRef ?? null,
		expectedRefOid: refs.expectedRefOid ?? null,
		strict,
		warningsAsErrors,
		complete,
		valid,
		counts,
		exitCode,
	}
}
