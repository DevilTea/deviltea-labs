/**
 * History lookup execution (10-query-and-trace.md "History Lookup").
 *
 * Walks the captured integration ref's complete first-parent history
 * (oldest to newest) and, for each commit, decodes exactly the two things
 * needed at that historical point in time -- the target Artifact's own
 * envelope and every CHG file's envelope -- by reusing the same
 * `splitFrontmatter` / `parseFrontmatterDocument` / `decodeEnvelope`
 * pipeline `./snapshot.ts` uses for the *current* snapshot, applied here to
 * historical Git blobs instead of working-tree files.
 *
 * Deliberately does not use `GitRepository#diffTrees`: the Artifact aggregate
 * for one ID is a small, explicitly known candidate path set (the canonical
 * file, its currently-or-previously declared local Resource locations, and,
 * for PROJECT, the two control files), so each commit's relevant changes are
 * found by comparing blob OIDs at exactly those candidate paths against the
 * previous commit, rather than diffing (and discarding most of) the
 * project's complete tree.
 *
 * Known scope limitation: this reads a full recursive tree listing
 * (`git ls-tree -r`) for every commit in the walked history, not only commits
 * that touch the target aggregate. Acceptable for EF Core v1's correctness
 * requirements; a real performance-sensitive implementation would want a
 * cheaper per-commit existence/oid probe instead.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope, Status } from '../domain/model'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { HistoryCommitData, HistoryEffectData } from './query-types'
import type { SnapshotArtifactRecord } from './snapshot-validation'
import { decodeEnvelope } from '../domain/envelope'
import { validateFilename } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { compareBytewise } from '../domain/model'
import { validateRelationEntries } from '../domain/relations'
import { validateResourceDescriptors } from '../domain/resources'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { detectInvalidUtf8 } from '../platform/text-checks'
import { decodeConfig } from '../repository/config'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'
import { rawArrayField } from './snapshot-raw-fields'

const EF_YAML_PATH = '.engineering/ef.yaml'
const PROJECT_MD_PATH = '.engineering/PROJECT.md'
const PROJECT_CONTROL_PATHS = [EF_YAML_PATH, '.engineering/.gitignore'] as const
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

/** A tree entry that is an ordinary file readable as a blob -- not a directory, gitlink, or symlink-mode (`120000`) blob. */
function isRegularBlobEntry(entry: GitTreeEntry | undefined): entry is GitTreeEntry {
	return entry !== undefined && entry.type === 'blob' && entry.mode !== '120000'
}

function hasErrorDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === 'error')
}

function isExternalResourceLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

/**
 * Whether `location` is a syntactically valid LOCAL Resource location
 * (06-resources.md "Location classification"/"Local path resolution"), used
 * only to decide the paths this walk treats as part of the target's owned
 * aggregate (`ownedPathsOf` below). Narrowly mirrors
 * `snapshot-validation.ts`'s own `isValidLocalLocation` predicate (not
 * imported: that module's concern is cross-Artifact resource ownership,
 * this one is aggregate path attribution) -- not an external HTTP(S) URL, no
 * other URI scheme, no backslash, does not escape the project root, and has
 * no empty/`.`/`..` path segment.
 */
function isValidLocalResourceLocation(location: string): boolean {
	if (location.length === 0 || isExternalResourceLocation(location))
		return false
	if (location.includes(':') || location.includes('\\'))
		return false
	if (location.startsWith('/') || location.startsWith('~'))
		return false
	return !location.split('/')
		.some(segment => segment === '' || segment === '.' || segment === '..')
}

export interface HistoryOutcome {
	effects: HistoryEffectData[]
	commits: HistoryCommitData[]
}

/**
 * `computeHistory`'s result: `complete` carries the materialized outcome;
 * the two failure kinds distinguish "the required Git history itself is
 * unavailable" from "the history walk touched a path or blob that cannot be
 * trusted" -- previously folded into the same `undefined` and reported as a
 * single `EF-QRY-010` by every caller. `./query.ts`'s `handleHistory` maps
 * these onto the two distinct registered diagnostics the review ruling for
 * this defect class specifies:
 *
 * - `history-unavailable`: the required first-parent history itself could
 *   not be completely materialized (shallow, unresolved, or otherwise
 *   inaccessible Git history), a historical commit's tree could not be read
 *   mid-walk, the claimed bootstrap boundary commit's `ef.yaml`/`PROJECT.md`
 *   blob could not be read due to an execution/read failure (see
 *   `evaluateBootstrapBoundary` below), or the walked history never contains
 *   a commit whose tree even contains `.engineering/ef.yaml` at all -- no
 *   authoritative EF history exists on this ref at all. This maps to
 *   `EF-QRY-010` ("Requested history context is unavailable",
 *   diagnostic-registry.md).
 * - `untrusted-data`: the target's current record sits at a path that
 *   violates its canonical placement (`EF-ID-005`/`EF-ID-014`; see the
 *   authoritative-path check below), the claimed bootstrap boundary commit
 *   exists but is not a valid, complete bootstrap (a non-regular-blob or
 *   undecodable `ef.yaml`, or a missing/invalid minimal-witness
 *   `PROJECT.md` -- see `evaluateBootstrapBoundary`), a historical blob this
 *   walk needed exists but cannot be completely read and decoded (unreadable
 *   blob, malformed frontmatter, or an envelope that fails to decode), or an
 *   error-severity finding on one of the other historical facts this walk
 *   consumes -- a CHG's relation entries (including a duplicate effect,
 *   `EF-REL-006`), a CHG's filename-vs-declared-id consistency, a declared
 *   Resource descriptor (shape, vocabulary, or owner-directory, `EF-RES-014`
 *   included) when used for aggregate path attribution, a non-regular tree
 *   entry at a declared local Resource location, or a projection-fidelity
 *   loss (relation-extension, Resource-field, or byte-decoding) on a CHG
 *   summary this walk is about to emit as an effect. This maps to
 *   `EF-QRY-013` ("Query cannot produce a complete trustworthy result",
 *   diagnostic-registry.md).
 */
export type ComputeHistoryResult
	= | ({ kind: 'complete' } & HistoryOutcome)
		| { kind: 'history-unavailable' }
		| { kind: 'untrusted-data' }

export async function computeHistory(
	git: GitRepository,
	integrationRefOid: string,
	targetId: string,
	targetType: ArtifactType,
	byId: ReadonlyMap<string, SnapshotArtifactRecord>,
): Promise<ComputeHistoryResult> {
	const historyResult = await git.listFirstParentHistory(integrationRefOid)
	if (historyResult.kind !== 'complete')
		return { kind: 'history-unavailable' }

	const oidsOldestFirst = [...historyResult.oids].reverse()
	const canonicalPath = canonicalArtifactPath(targetType, targetId)
	const isProject = targetType === 'project'

	// History tracks an Artifact aggregate by scanning the *canonical* path
	// derived from (type, id) at each historical commit (see the module
	// docstring: a small, explicitly known candidate path set, not a tree
	// diff). `EF-ID-005` (filename does not match ID) and `EF-ID-014` (file
	// outside its canonical directory) deliberately do NOT gate
	// `graphTrustworthy` (snapshot-validation.ts) -- the declared ID is still
	// unique and correctly decoded, so lookup/relations/etc. over `byId`
	// remain trustworthy even though the file/layout convention is violated.
	// History is different: if the *current* record's actual authoritative
	// path does not match the canonical path this walk is about to scan, the
	// premise the whole aggregate-diffing walk relies on is already broken --
	// the file this ID currently resolves to is not at the path history
	// assumes it occupies, so scanning `canonicalPath` anyway could return an
	// empty or silently partial history for an aggregate whose blob actually
	// exists elsewhere. Treat this as a history-specific blocker instead
	// (`untrusted-data`, not `history-unavailable`: the Git history itself is
	// perfectly readable, only this target's own current placement is not
	// trustworthy).
	const currentRecord = byId.get(targetId)
	if (currentRecord && currentRecord.path !== canonicalPath)
		return { kind: 'untrusted-data' }

	const treeCache = new Map<string, Map<string, GitTreeEntry> | undefined>()
	async function treeMapAt(oid: string): Promise<Map<string, GitTreeEntry> | undefined> {
		if (treeCache.has(oid))
			return treeCache.get(oid)
		const result = await git.readTree(oid)
		const map = result.kind === 'resolved' ? new Map(result.entries.map(entry => [entry.path, entry] as const)) : undefined
		treeCache.set(oid, map)
		return map
	}

	// Distinguishes genuine tree absence (no entry, or a non-blob entry: the
	// path legitimately does not exist as a file at this historical commit --
	// e.g. the Artifact had not been created yet) from an entry that DOES
	// exist as a blob at this commit but could not be completely read and
	// decoded (unreadable blob, malformed frontmatter, or an envelope that
	// fails to decode). The former is a normal, expected input to the walk;
	// the latter means a historical blob this walk needed exists but its
	// content cannot be trusted, which must fail the whole query rather than
	// being silently treated the same as absence (the target could appear to
	// disappear, or a malformed/unreadable CHG could simply be skipped from
	// effects, while the command still reports `complete: true`).
	//
	// A successfully-decoded `envelope` (non-null) does NOT by itself mean the
	// data is trustworthy: `parseFrontmatterDocument`/`decodeEnvelope` still
	// populate `document`/`decoded` with error-severity diagnostics for things
	// like duplicate frontmatter keys (`EF-ENV-005`), an unsupported or
	// mismatched schema (`EF-ENV-008`/`EF-ENV-009`), or a duplicate tag
	// (`EF-ENV-012`) while still returning a usable-looking envelope (e.g. by
	// keeping the last of two duplicate keys). `lifecycle.ts`'s `validateStatus`
	// closes a further gap neither parser checks: an unknown or type-inapplicable
	// `status` value (`EF-LIFE-001`/`EF-LIFE-002`) decodes as a plain string with
	// no diagnostic of its own. Any error-severity finding from either source
	// makes this blob's content untrusted, exactly like an undecodable envelope.
	type EnvelopeLookup
		= | { kind: 'absent' }
			| { kind: 'error' }
			| { kind: 'resolved', envelope: Envelope, mapping: ReturnType<typeof parseFrontmatterDocument>['mapping'], bytes: Uint8Array }

	async function envelopeAt(treeMap: Map<string, GitTreeEntry>, path: string): Promise<EnvelopeLookup> {
		const entry = treeMap.get(path)
		if (!entry || entry.type !== 'blob')
			return { kind: 'absent' }
		const blobResult = await git.readBlob(entry.oid)
		if (blobResult.kind !== 'resolved')
			return { kind: 'error' }
		const text = utf8Decoder.decode(blobResult.bytes)
		const split = splitFrontmatter(text)
		if (!split.ok)
			return { kind: 'error' }
		const document = parseFrontmatterDocument(split.frontmatterText, path, { startLine: 2 })
		const decoded = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, path)
		if (!decoded.envelope)
			return { kind: 'error' }
		if (hasErrorDiagnostic(document.diagnostics) || hasErrorDiagnostic(decoded.diagnostics))
			return { kind: 'error' }
		const statusDiagnostics = validateStatus({ type: decoded.envelope.type, status: decoded.envelope.status, id: decoded.envelope.id }, path)
		if (hasErrorDiagnostic(statusDiagnostics))
			return { kind: 'error' }
		return { kind: 'resolved', envelope: decoded.envelope, mapping: document.mapping, bytes: blobResult.bytes }
	}

	function ownedPathsOf(treeMap: Map<string, GitTreeEntry> | undefined, envelope: Envelope | undefined): Set<string> {
		const owned = new Set<string>()
		if (!treeMap || !envelope)
			return owned
		owned.add(canonicalPath)
		for (const resource of envelope.resources) {
			if (isValidLocalResourceLocation(resource.location))
				owned.add(resource.location)
		}
		if (isProject) {
			for (const controlPath of PROJECT_CONTROL_PATHS) {
				if (treeMap.has(controlPath))
					owned.add(controlPath)
			}
		}
		return owned
	}

	let previousTreeMap: Map<string, GitTreeEntry> | undefined
	let previousEnvelope: Envelope | undefined
	let previousChgStatus = new Map<string, Status>()

	const commits: HistoryCommitData[] = []
	const effects: HistoryEffectData[] = []

	// The bootstrap commit is the first authoritative EF state
	// (11-filesystem-and-config.md: "Its first-parent ancestors MAY be
	// ordinary repository history without EF state. From bootstrap onward, the
	// branch's first-parent EF-bearing commit sequence is the sequence of
	// authoritative EF states."). The CLAIMED bootstrap boundary is the FIRST
	// first-parent commit whose tree contains the `.engineering/ef.yaml` path
	// AT ALL, regardless of its mode/type (`evaluateBootstrapBoundary` below):
	// per the bootstrap-validation contract (EF-VAL-009,
	// `bootstrap-validation.ts`'s `pathExistsInFirstParentHistory` probe), any
	// historical `ef.yaml` path -- valid, invalid, or not even a regular file
	// -- asserts an EF state at that commit, so the walk MUST NEVER look past
	// it hoping a later commit is "more valid". Earlier commits (the path
	// genuinely absent) are skipped entirely -- never decoded at
	// `canonicalPath` or scanned for `.engineering/chg/*.md` -- so ordinary
	// pre-EF repository content that happens to sit at an EF-shaped path (a
	// stale Artifact/CHG-looking file predating adoption) can neither
	// fabricate a commit/effect entry nor fail an otherwise-valid query.
	//
	// Once the boundary is claimed, it is evaluated exactly once, with no
	// fallback to a later commit either way:
	// - a read/execution failure while resolving or decoding ANY blob this
	//   probe needs (the `ef.yaml` blob itself, or the bootstrap witness
	//   `.engineering/PROJECT.md` blob) makes the required history itself
	//   unavailable (`history-unavailable`, `EF-QRY-010`) -- a transient read
	//   failure at the true boundary must never be papered over by silently
	//   accepting a later commit's successful read as though history started
	//   there instead (that would be a silent late start).
	// - a structural/validity failure -- the `ef.yaml` entry is not a regular
	//   blob (a directory, gitlink, or `120000` symlink-mode blob), it fails
	//   to decode as a valid `ef/config@1` configuration, or the tree lacks a
	//   regular-blob `.engineering/PROJECT.md` that itself decodes with
	//   `id: PROJECT`, `type: project`, `status: active` (the minimal
	//   bootstrap witness) -- makes this claimed boundary untrustworthy
	//   (`untrusted-data`, `EF-QRY-013`): a pre-EF commit that merely happens
	//   to carry a syntactically valid config (or any other partial EF-shaped
	//   state) but is not a genuine, complete bootstrap must be reported as
	//   untrusted, never silently skipped in favor of a later commit.
	//
	// `previousTreeMap`/`previousEnvelope`/`previousChgStatus` are left at
	// their initial (empty) values through every skipped pre-boundary commit,
	// so the first commit actually processed -- the bootstrap commit itself --
	// is diffed exactly as if it were `oidsOldestFirst[0]`.
	let reachedBootstrap = false

	type BootstrapBoundaryOutcome = 'not-present' | 'valid' | 'invalid' | 'read-error'

	async function evaluateBootstrapBoundary(treeMap: Map<string, GitTreeEntry>): Promise<BootstrapBoundaryOutcome> {
		const efYamlEntry = treeMap.get(EF_YAML_PATH)
		if (!efYamlEntry)
			return 'not-present'

		// From here on this commit IS the claimed boundary -- every path below
		// returns 'invalid' or 'read-error', never falls through to let the
		// caller consider a later commit instead.
		if (!isRegularBlobEntry(efYamlEntry))
			return 'invalid'

		const configBlobResult = await git.readBlob(efYamlEntry.oid)
		if (configBlobResult.kind === 'git-unavailable' || configBlobResult.kind === 'error')
			return 'read-error'
		if (configBlobResult.kind !== 'resolved')
			// The tree listing already proved this entry is a blob; `missing`/
			// `not-a-blob` here is repository/read corruption on an object
			// already known to exist, never proof of absence or invalidity.
			return 'read-error'

		const configText = utf8Decoder.decode(configBlobResult.bytes)
		if (decodeConfig(configText, EF_YAML_PATH).config === null)
			return 'invalid'

		const projectEntry = treeMap.get(PROJECT_MD_PATH)
		if (!isRegularBlobEntry(projectEntry))
			return 'invalid'

		const projectBlobResult = await git.readBlob(projectEntry.oid)
		if (projectBlobResult.kind === 'git-unavailable' || projectBlobResult.kind === 'error')
			return 'read-error'
		if (projectBlobResult.kind !== 'resolved')
			return 'read-error'

		const projectText = utf8Decoder.decode(projectBlobResult.bytes)
		const projectSplit = splitFrontmatter(projectText)
		if (!projectSplit.ok)
			return 'invalid'
		const projectDocument = parseFrontmatterDocument(projectSplit.frontmatterText, PROJECT_MD_PATH, { startLine: 2 })
		const projectDecoded = decodeEnvelope({ mapping: projectDocument.mapping, locate: projectDocument.locate }, PROJECT_MD_PATH)
		if (!projectDecoded.envelope)
			return 'invalid'
		if (projectDecoded.envelope.id !== 'PROJECT' || projectDecoded.envelope.type !== 'project' || projectDecoded.envelope.status !== 'active')
			return 'invalid'

		return 'valid'
	}

	for (const oid of oidsOldestFirst) {
		const treeMap = await treeMapAt(oid)
		if (!treeMap)
			return { kind: 'history-unavailable' }

		if (!reachedBootstrap) {
			const boundary = await evaluateBootstrapBoundary(treeMap)
			if (boundary === 'not-present')
				continue
			if (boundary === 'read-error')
				return { kind: 'history-unavailable' }
			if (boundary === 'invalid')
				return { kind: 'untrusted-data' }
			reachedBootstrap = true
		}

		const currentEnvelopeLookup = await envelopeAt(treeMap, canonicalPath)
		if (currentEnvelopeLookup.kind === 'error')
			return { kind: 'untrusted-data' }
		const currentEnvelope = currentEnvelopeLookup.kind === 'resolved' ? currentEnvelopeLookup.envelope : undefined

		// The canonical path is scanned under the premise that whatever blob
		// sits there IS this target's own envelope. If it decodes to a
		// different declared `id` or `type`, that premise is broken -- some
		// other Artifact's (or malformed) content occupies the path this walk
		// assumes belongs to `targetId` -- and continuing would silently
		// attribute an unrelated envelope's history to this target.
		if (currentEnvelope && (currentEnvelope.id !== targetId || currentEnvelope.type !== targetType))
			return { kind: 'untrusted-data' }

		// `ownedPathsOf` is about to treat every non-external declared Resource
		// `location` as a literal path into this commit's tree (owned-set
		// membership and OID comparison). This walk reuses the SAME
		// descriptor shape/vocabulary/owner-directory rules
		// `snapshot-validation.ts` runs for the current snapshot
		// (`domain/resources.ts`'s `validateResourceDescriptors`) rather than
		// a narrower location-syntax-only check: a location can be
		// syntactically valid yet still declare a Resource this walk must not
		// trust as this target's own aggregate content -- most notably
		// `EF-RES-014` (the location sits beneath ANOTHER Artifact's
		// canonical `.engineering/resources/<other-id>/` owner directory,
		// 06-resources.md), which a syntax-only check could never see and
		// would silently attribute to `targetId` anyway. Any error-severity
		// finding here -- including an invalid location (`EF-RES-004`/`007`),
		// a duplicate location (`EF-RES-008`), or a malformed descriptor
		// shape (`EF-RES-001`) -- makes the whole declared Resource set
		// untrustworthy for aggregate attribution.
		if (currentEnvelopeLookup.kind === 'resolved' && currentEnvelopeLookup.mapping) {
			const rawResources = rawArrayField(currentEnvelopeLookup.mapping, 'resources')
			const resourceDiagnostics = validateResourceDescriptors({ id: targetId, resources: rawResources }, canonicalPath)
			if (hasErrorDiagnostic(resourceDiagnostics))
				return { kind: 'untrusted-data' }
		}

		// A declared LOCAL Resource `location` is about to be compared as
		// this exact historical commit's Resource CONTENT (owned-set OID
		// comparison). The tree entry actually sitting at that location may
		// be a directory, a symlink-mode (`120000`) blob, or a gitlink
		// (`commit`-type entry) instead of the ordinary file the descriptor
		// claims to describe -- any of which would still silently compare as
		// though it were the Resource's real content. A location with NO
		// tree entry at all is the ordinary, expected "not created yet" case
		// and is left alone; only a location that DOES resolve to a tree
		// entry that is not a regular blob is untrusted.
		if (currentEnvelope) {
			for (const resource of currentEnvelope.resources) {
				if (isExternalResourceLocation(resource.location) || !isValidLocalResourceLocation(resource.location))
					continue
				const resourceEntry = treeMap.get(resource.location)
				if (resourceEntry && !isRegularBlobEntry(resourceEntry))
					return { kind: 'untrusted-data' }
			}
		}

		// ---- Aggregate diffing: did this commit change the target's owned paths? ----
		const prevOwned = ownedPathsOf(previousTreeMap, previousEnvelope)
		const curOwned = ownedPathsOf(treeMap, currentEnvelope)
		const changed: string[] = []
		for (const path of new Set([...prevOwned, ...curOwned])) {
			const prevOid = previousTreeMap?.get(path)?.oid
			const curOid = treeMap.get(path)?.oid
			if (prevOid !== curOid)
				changed.push(path)
		}
		if (changed.length > 0)
			commits.push({ oid, changed_paths: changed.sort(compareBytewise) })

		// ---- Engineering effects: newly completed CHGs targeting this Artifact ----
		const currentChgStatus = new Map<string, Status>()
		for (const [path, entry] of treeMap) {
			if (entry.type !== 'blob' || !path.startsWith('.engineering/chg/') || !path.endsWith('.md'))
				continue

			const chgLookup = await envelopeAt(treeMap, path)
			if (chgLookup.kind === 'error')
				return { kind: 'untrusted-data' }
			if (chgLookup.kind === 'absent')
				continue
			const chgEnvelope = chgLookup.envelope
			if (chgEnvelope.type !== 'change')
				continue

			// This walk discovers every CHG purely by scanning blob paths under
			// `.engineering/chg/` and indexes each one's completion status
			// (`currentChgStatus`/`previousChgStatus`, keyed by the CHG's own
			// declared `id`) across commits to detect the exact commit where it
			// transitions to `completed`. Unlike `snapshot-validation.ts`'s
			// `graphTrustworthy` -- whose `byId` indexing already keys correctly
			// on the declared `id` regardless of filename, so `EF-ID-005`/`014`
			// do not gate it -- this walk's cross-commit transition tracking
			// depends on every discovered CHG blob being reliably, uniquely
			// identifiable by that scan: a filename that does not match the
			// CHG's own declared `id` (`EF-ID-005`), or a CHG file that does not
			// sit directly inside `.engineering/chg/` (`EF-ID-014`, e.g. a
			// nested subdirectory this prefix scan would still match), means the
			// identity this walk is relying on for that tracking is not
			// trustworthy at this historical commit.
			const chgFilenameDiagnostics = validateFilename({ type: chgEnvelope.type, id: chgEnvelope.id }, path)
			if (hasErrorDiagnostic(chgFilenameDiagnostics))
				return { kind: 'untrusted-data' }

			currentChgStatus.set(chgEnvelope.id, chgEnvelope.status)

			const wasCompleted = previousChgStatus.get(chgEnvelope.id) === 'completed'
			if (chgEnvelope.status !== 'completed' || wasCompleted)
				continue

			// `chgEnvelope.relations` is `decodeEnvelope`'s raw-shape decoding of
			// each entry (missing `type`/`target` default to `''`, unknown
			// vocabulary passes through as-is) -- it does not apply
			// `domain/relations.ts`'s own shape/vocabulary/self-relation checks.
			// Re-derive the CHG's true raw `relations` array from the parsed YAML
			// mapping (`snapshot-raw-fields.ts`, exactly as `snapshot-validation.ts`
			// does for its own `chgEffects`) and run it through
			// `validateRelationEntries` so a relation entry with an unrecognized
			// type, invalid shape, or a self-relation can never be mistaken for a
			// genuine `introduces`/`modifies`/`retires` effect.
			const rawRelations = chgLookup.mapping ? rawArrayField(chgLookup.mapping, 'relations') : []
			const relationValidation = validateRelationEntries({ id: chgEnvelope.id, relations: rawRelations }, path)

			// Any error-severity finding on THIS completing CHG's relation
			// entries makes `relationValidation.entries` untrustworthy for the
			// effect this loop is about to emit -- most critically `EF-REL-006`
			// (duplicate `(type, target)` pair): `validateRelationEntries` does
			// NOT exclude a duplicate entry from `entries` (04-relations.md
			// "duplicate ... detection ... independent of vocabulary validity"),
			// so without this gate a single completed CHG declaring the same
			// effect relation twice would silently emit the same historical
			// effect twice while this query still reported `complete: true`.
			// `EF-REL-015` (an invalid/non-JSON-compatible extension field on an
			// otherwise valid `(type, target)` pair) is deliberately excluded,
			// consistent with `snapshot-validation.ts`'s `edgeLossArtifactIds`
			// vs `relationExtensionLossArtifactIds` split: the effect fact this
			// loop reads and emits is exactly the pair `(relation.type,
			// relation.target)`, and `EF-REL-015` never alters either -- only
			// extension metadata this loop never reads.
			if (relationValidation.diagnostics.some(d => d.severity === 'error' && d.code !== 'EF-REL-015'))
				return { kind: 'untrusted-data' }

			const qualifyingRelations = relationValidation.entries.filter(
				(relation): relation is typeof relation & { type: 'introduces' | 'modifies' | 'retires' } =>
					relation.target === targetId
					&& (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires'),
			)

			if (qualifyingRelations.length > 0) {
				// `EF-REL-015` was deliberately excluded from the FACT-trust gate
				// just above -- the `(relation.type, relation.target)` pair this
				// loop reads is unaffected by an invalid relation-extension field.
				// But the effect this loop is about to EMIT carries the CHG's
				// COMPLETE summary projection (`buildArtifactSummary`: every
				// relation, every Resource, every top-level extension this CHG
				// declares), not only that one pair. Apply the SAME
				// projection-fidelity checks `snapshot-validation.ts` folds into
				// `projectionLossArtifactIds` for the CURRENT snapshot, applied
				// here to this historical CHG blob instead: an invalid/
				// non-JSON-compatible relation extension (`EF-REL-015`,
				// serializes to `null` rather than the file's actual declared
				// value) or Resource extension (`EF-RES-019`), a malformed
				// Resource core field silently decoded to its empty/default
				// value (`EF-RES-001` -- `domain/resources.ts`'s validation is
				// never otherwise run over a CHG's own `resources`), or invalid
				// UTF-8 in the CHG's raw bytes (already best-effort-decoded to
				// U+FFFD by the `envelopeAt` read above) all mean the summary
				// this loop is about to emit cannot faithfully represent this
				// CHG's authoritative content -- so THIS query fails
				// (`untrusted-data`), even though the effect FACT itself (the
				// `(type, target)` pair) remains perfectly valid: the distinction
				// is the FACT stays valid, but the EMITTED SUMMARY must be
				// faithful, and it is the summary this loop is about to hand to
				// the caller.
				const rawChgResources = chgLookup.mapping ? rawArrayField(chgLookup.mapping, 'resources') : []
				const chgResourceDiagnostics = validateResourceDescriptors({ id: chgEnvelope.id, resources: rawChgResources }, path)
				const hasRelationExtensionLoss = relationValidation.diagnostics.some(d => d.code === 'EF-REL-015')
				const hasResourceProjectionLoss = chgResourceDiagnostics.some(d => d.code === 'EF-RES-001' || d.code === 'EF-RES-019')
				const hasByteDecodingLoss = detectInvalidUtf8(chgLookup.bytes) !== undefined
				if (hasRelationExtensionLoss || hasResourceProjectionLoss || hasByteDecodingLoss)
					return { kind: 'untrusted-data' }
			}

			for (const relation of qualifyingRelations) {
				// History is defined by the authoritative integration state
				// observed AT THIS COMMIT, not by whatever the CHG's current
				// (possibly since-edited, possibly uncommitted) record says now
				// -- the effect summary is built unconditionally from the
				// historically-decoded `chgEnvelope`/`path` at this `oid`
				// (10-query-and-trace.md history: effects carry the CHG summary
				// from the authoritative integration commit).
				const chgSummary = buildArtifactSummary(chgEnvelope, path)

				effects.push({
					chg: chgSummary,
					effect: relation.type,
					status_before: previousEnvelope?.status ?? null,
					status_after: currentEnvelope?.status ?? previousEnvelope?.status ?? 'retired',
					commit_oid: oid,
				})
			}
		}

		previousTreeMap = treeMap
		previousEnvelope = currentEnvelope
		previousChgStatus = currentChgStatus
	}

	// The walk never found a commit whose tree contained `.engineering/ef.yaml`
	// AT ALL: the configured integration ref's ENTIRE first-parent history is
	// pre-EF. (A commit that DOES contain the path -- even an invalid or
	// non-regular one -- would already have claimed the boundary above and
	// returned `untrusted-data` instead of reaching here.) No authoritative EF
	// state exists on this ref at all, so the required history this query
	// needs does not exist --
	// `history-unavailable` (`EF-QRY-010`) -- rather than the misleadingly
	// ordinary-looking `{ kind: 'complete', effects: [], commits: [] }` a
	// caller could mistake for "this Artifact simply has no history yet".
	if (!reachedBootstrap)
		return { kind: 'history-unavailable' }

	return { kind: 'complete', effects, commits }
}
