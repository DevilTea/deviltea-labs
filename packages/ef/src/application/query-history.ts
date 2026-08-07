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
 *
 * Finding 4 (02-identity.md permanent retention): the target's own aggregate
 * lives at a small candidate path set as above, but PROVING `targetId` is not
 * ALSO sitting at some other, non-canonical path (or has disappeared after
 * having genuinely appeared) requires enumerating every OTHER Artifact
 * candidate path this commit's Artifact discovery scope contains
 * (`repository/layout.ts`'s own `listArtifactFiles`) and decoding each one far
 * enough to read its declared `id`. This is therefore an ADDITIONAL, full
 * discovery-scope decode pass per consumed commit, on top of the small
 * candidate-path comparison above -- a real cost, accepted here for
 * correctness (identity trust) rather than working around it with a cheaper
 * but weaker probe.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope, Status } from '../domain/model'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { WalkEntry } from '../platform/fs-facts'
import type { HistoryCommitData, HistoryEffectData } from './query-types'
import type { SnapshotArtifactRecord } from './snapshot-validation'
import { validateBody } from '../domain/body-schemas'
import { decodeEnvelope } from '../domain/envelope'
import { validateFilename } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { ALLOWED_TRANSITIONS, compareBytewise, RELATION_COMPATIBILITY, TERMINAL_STATUSES } from '../domain/model'
import { validateRelationEntries } from '../domain/relations'
import { validateResourceDescriptors } from '../domain/resources'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { detectInvalidUtf8 } from '../platform/text-checks'
import { decodeConfig } from '../repository/config'
import { listArtifactFiles } from '../repository/layout'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'
import { loadSnapshotFromCommit } from './snapshot'
import { rawArrayField } from './snapshot-raw-fields'
import { summarizeValidation, validateSnapshot } from './snapshot-validation'

const EF_YAML_PATH = '.engineering/ef.yaml'
const PROJECT_CONTROL_PATHS = [EF_YAML_PATH, '.engineering/.gitignore'] as const
/**
 * Bootstrap-only state rules (09-validation.md "Bootstrap exception"): no CHG
 * Artifact, and no terminal (`superseded`/`retired`) knowledge Artifact, may
 * be present at the very first EF state. Mirrors `bootstrap-validation.ts`'s
 * own (unexported) `KNOWLEDGE_TYPES` constant of the same name -- duplicated
 * here rather than imported because neither that constant nor the small
 * state-rule loop it drives is exported (Finding 5; see this round's review
 * report for the extraction that would let this module import it instead).
 */
const BOOTSTRAP_KNOWLEDGE_TYPES = new Set(['prd', 'requirement', 'decision', 'policy'])
/** Mirrors `bootstrap-validation.ts`'s own `DEFAULT_POLICY`: neither `strict` nor `warningsAsErrors`, so only error-severity diagnostics fail the boundary. */
const BOOTSTRAP_POLICY = { strict: false, warningsAsErrors: false }
const ENGINEERING_DIR_BYTES = new TextEncoder()
	.encode('.engineering')
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

/** A tree entry that is an ordinary file readable as a blob -- not a directory, gitlink, or symlink-mode (`120000`) blob. */
function isRegularBlobEntry(entry: GitTreeEntry | undefined): entry is GitTreeEntry {
	return entry !== undefined && entry.type === 'blob' && entry.mode !== '120000'
}

/**
 * Finding 6: Git's tree-entry `mode` is stored independently of the blob
 * object it names -- a later commit can rewrite `.engineering/ef.yaml`'s mode
 * from `100644` to the forbidden symlink mode `120000` while reusing the
 * EXACT SAME blob OID (the blob's content, and therefore its OID, never
 * changed). Caching only the entry's `oid` across commits (as this per-commit
 * re-check used to) would see no OID change on such a commit and wrongly skip
 * `evaluateEfYamlConfig` entirely, letting a now-forbidden symlink control
 * path pass through unnoticed. The cache key is therefore the full relevant
 * tree-entry identity -- `{ oid, mode, pathValid }` -- so a mode-only (or
 * path-validity-only) change still re-triggers the cheap regularity/decode
 * check even when the OID alone is unchanged. `pathValid` is included for the
 * same reason `isRegularBlobEntry` treats it as part of an entry's identity
 * elsewhere in this walk; in practice it is always `true` here (an entry
 * reached via this exact-string `treeMap.get(EF_YAML_PATH)` lookup can never
 * be a `pathValid: false` placeholder, which is keyed under a synthesized,
 * never-colliding path instead), but tracking it keeps this cache key
 * expressed as the complete identity rather than one accidentally-sufficient
 * field.
 */
interface EfYamlTreeEntryIdentity {
	oid: string
	mode: string
	pathValid: boolean
}

function efYamlIdentityOf(treeMap: ReadonlyMap<string, GitTreeEntry>): EfYamlTreeEntryIdentity | undefined {
	const entry = treeMap.get(EF_YAML_PATH)
	if (!entry)
		return undefined
	return { oid: entry.oid, mode: entry.mode, pathValid: entry.pathValid !== false }
}

function sameEfYamlIdentity(a: EfYamlTreeEntryIdentity | undefined, b: EfYamlTreeEntryIdentity | undefined): boolean {
	if (a === undefined || b === undefined)
		return a === b
	return a.oid === b.oid && a.mode === b.mode && a.pathValid === b.pathValid
}

/**
 * Byte-level (not string) test for whether raw tree-entry path bytes lie at or
 * beneath `.engineering` -- mirrors `application/snapshot.ts`'s own
 * `pathBytesUnderEngineering` (Finding 4 there), applied here to the same
 * problem for historical commits (Finding 10): an entry with
 * `pathValid === false` has a `path` that is a synthesized, collision-free
 * placeholder (never a real decoded string, and never equal to or prefixed by
 * a genuine `.engineering/...` path), so only the entry's RAW BYTES can prove
 * whether it actually lies beneath `.engineering`.
 */
function pathBytesUnderEngineering(pathBytes: Uint8Array): boolean {
	if (pathBytes.length < ENGINEERING_DIR_BYTES.length)
		return false
	for (let i = 0; i < ENGINEERING_DIR_BYTES.length; i++) {
		if (pathBytes[i] !== ENGINEERING_DIR_BYTES[i])
			return false
	}
	return pathBytes.length === ENGINEERING_DIR_BYTES.length || pathBytes[ENGINEERING_DIR_BYTES.length] === 0x2F /* '/' */
}

/**
 * Finding 10 (second omission variant): the CHG scan below discovers every
 * CHG purely by matching decoded `path` strings against the
 * `.engineering/chg/` prefix. An entry whose raw path bytes are invalid UTF-8
 * (`pathValid: false`) is decoded to a NUL-prefixed placeholder string that
 * can never match that prefix scan, regardless of where its actual raw bytes
 * point -- including beneath `.engineering/chg/` itself. Such an entry would
 * therefore be silently invisible to the whole walk (never counted as a
 * managed CHG, never causing a failure) even though it constitutes exactly
 * the same untrustworthy managed-path condition `application/snapshot.ts`
 * reports as `EF-FS-006` for the current snapshot. Checked once per consumed
 * commit (every commit from the bootstrap boundary onward): any such entry
 * anywhere beneath `.engineering` makes this commit's content untrustworthy
 * for this walk, independent of whether it happens to fall inside a path this
 * walk otherwise scans by prefix.
 */
function hasInvalidUtf8PathUnderEngineering(treeMap: ReadonlyMap<string, GitTreeEntry>): boolean {
	for (const entry of treeMap.values()) {
		if (entry.pathValid === false) {
			const pathBytes = entry.pathBytes ?? new TextEncoder()
				.encode(entry.path)
			if (pathBytesUnderEngineering(pathBytes))
				return true
		}
	}
	return false
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

/**
 * Finding 4 (10-query-and-trace.md; 02-identity.md "ID immutability and
 * permanent retention"): the target's own canonical-path lookup
 * (`envelopeAt(treeMap, canonicalPath)`) only proves what sits at THAT one
 * path -- it says nothing about whether `targetId` is ALSO present at some
 * OTHER path this commit's Artifact discovery scope contains (a wrong/
 * non-canonical placement) or has disappeared entirely after having once
 * been genuinely present (a physical deletion, which 02-identity.md
 * forbids: "its Artifact MUST remain in the authoritative files ... rather
 * than be physically deleted"). Reusing `repository/layout.ts`'s own
 * `listArtifactFiles` -- the same canonical-layout candidate enumeration
 * `application/snapshot.ts` uses for the CURRENT snapshot -- over a
 * `WalkEntry[]` synthesized from this historical commit's own tree entries
 * gives the exact same "Artifact discovery scope" for a historical commit,
 * without redefining that scope's rules here.
 */
function engineeringWalkEntries(treeMap: ReadonlyMap<string, GitTreeEntry>): WalkEntry[] {
	const entries: WalkEntry[] = []
	for (const entry of treeMap.values()) {
		if (entry.pathValid === false)
			// Already reported separately by `hasInvalidUtf8PathUnderEngineering`
			// (which runs, and can already return `untrusted-data`, before this
			// scan is ever reached for a given commit) -- never a genuine
			// discovery-scope candidate here.
			continue
		if (entry.path !== '.engineering' && !entry.path.startsWith('.engineering/'))
			continue
		if (entry.path === '.engineering')
			continue
		const isDirectory = entry.type === 'tree'
		const isSymlink = entry.mode === '120000'
		const isRegularFile = !isDirectory && !isSymlink && entry.type === 'blob'
		entries.push({
			relativePath: entry.path.slice('.engineering/'.length),
			isRegularFile,
			isDirectory,
			isSymlink,
		})
	}
	return entries
}

/** Every canonical Artifact candidate path (`listArtifactFiles`' own "Artifact discovery scope") visible in this historical commit's tree. */
function artifactDiscoveryPaths(treeMap: ReadonlyMap<string, GitTreeEntry>): string[] {
	return listArtifactFiles(engineeringWalkEntries(treeMap)).artifactFiles
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
 *   mid-walk, a blob the claimed bootstrap boundary commit's COMPLETE
 *   snapshot materialization needed could not be read due to an
 *   execution/read failure (Finding 5, see `evaluateBootstrapBoundary`
 *   below), or the walked history never contains a commit whose tree even
 *   contains `.engineering/ef.yaml` at all -- no authoritative EF history
 *   exists on this ref at all. This maps to `EF-QRY-010` ("Requested history
 *   context is unavailable", diagnostic-registry.md).
 * - `untrusted-data`: the target's current record sits at a path that
 *   violates its canonical placement (`EF-ID-005`/`EF-ID-014`; see the
 *   authoritative-path check below), the claimed bootstrap boundary commit
 *   exists but is not a valid, complete bootstrap (an undecodable `ef.yaml`,
 *   an `ef.yaml` that decodes but declares a DIFFERENT `integration_ref` than
 *   the one this walk was asked to walk, when the caller supplied one
 *   (Finding 11, see `evaluateEfYamlConfig`), or the claimed boundary's
 *   COMPLETE tree fails full snapshot validation or a bootstrap-only state
 *   rule -- Finding 5: a non-canonical/missing control file, more than one
 *   active PROJECT, any CHG Artifact, or any terminal knowledge Artifact --
 *   see `evaluateBootstrapBoundary`), a LATER authoritative EF-bearing commit
 *   whose own `ef.yaml` blob changes and either fails to decode, is removed,
 *   or retargets `integration_ref` away from what the walk's OWN bootstrap
 *   commit declared (Finding 11, `integration_ref` is fixed by bootstrap and
 *   MUST NOT change within Core v1 -- this self-consistency check applies
 *   regardless of whether the caller supplied an expected ref at all), a
 *   managed entry this walk needed (the target's own
 *   canonical path, or a `.engineering/chg/*.md` candidate) that DOES exist
 *   at that path but is not a regular Git blob -- a symlink-mode (`120000`)
 *   blob, gitlink, or directory (Finding 10) -- an invalid-UTF-8 path
 *   anywhere beneath `.engineering` in a commit this walk consumes (Finding
 *   10, invisible to every prefix/exact-match scan otherwise), a historical
 *   blob this walk needed exists but cannot be completely read and decoded
 *   (unreadable blob, malformed frontmatter, or an envelope that fails to
 *   decode), or an error-severity finding on one of the other historical
 *   facts this walk consumes -- a CHG's relation entries (including a
 *   duplicate effect, `EF-REL-006`), a CHG's filename-vs-declared-id
 *   consistency, a declared Resource descriptor (shape, vocabulary, or
 *   owner-directory, `EF-RES-014` included) when used for aggregate path
 *   attribution, a non-regular tree entry at a declared local Resource
 *   location, or a projection-fidelity loss (relation-extension,
 *   Resource-field, or byte-decoding) on a CHG summary this walk is about to
 *   emit as an effect. This maps to `EF-QRY-013` ("Query cannot produce a
 *   complete trustworthy result", diagnostic-registry.md).
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
	/**
	 * The exact ref NAME (e.g. `refs/heads/main`) `integrationRefOid` was
	 * resolved from -- the ref this history walk was asked to walk.
	 * 11-filesystem-and-config.md: "`integration_ref` is fixed by bootstrap
	 * and MUST NOT change within Core v1." (Finding 11). When supplied, the
	 * bootstrap boundary commit's own decoded `ef.yaml` MUST declare exactly
	 * this ref, else `untrusted-data` -- this is what stops a config that was
	 * schema-validly edited to select a DIFFERENT ref (whose own history
	 * happens to carry an otherwise-plausible bootstrap) from being silently
	 * accepted merely because that other ref's history is internally
	 * consistent.
	 *
	 * Independently of whether this argument is supplied, EVERY later
	 * authoritative EF-bearing commit in the SAME walk whose `ef.yaml` blob
	 * changes is always required to still declare the SAME `integration_ref`
	 * the walk's own bootstrap commit declared (see `previousIntegrationRef`
	 * below) -- an in-history retarget partway through one ref's own history
	 * is detected on that self-consistency alone, with no need for this
	 * parameter at all.
	 *
	 * Optional: `./query.ts`'s `handleHistory` supplies it via
	 * `HistoryQueryContext.integrationRef` (populated by
	 * `cli/commands/query.ts`'s own `resolveRef` call, the same ref name used
	 * to obtain `integrationRefOid`). Remains optional so a caller without a
	 * ref name on hand degrades gracefully to the self-consistency check
	 * alone, rather than failing every history query closed.
	 */
	expectedIntegrationRef?: string,
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

	// Distinguishes genuine tree absence (no entry at all: the path
	// legitimately does not exist at this historical commit -- e.g. the
	// Artifact had not been created yet) from an entry that DOES exist at
	// this commit but is not a trustworthy regular file (Finding 10: a
	// symlink-mode `120000` blob, a gitlink, or a directory sitting at this
	// exact managed path), and from a regular-blob entry that could not be
	// completely read and decoded (unreadable blob, malformed frontmatter, or
	// an envelope that fails to decode). The first is a normal, expected
	// input to the walk; the other two mean a historical path this walk
	// needed exists but its content cannot be trusted, which must fail the
	// whole query rather than being silently treated the same as absence
	// (the target could appear to disappear, or a malformed/unreadable/
	// symlinked CHG could simply be skipped from effects, while the command
	// still reports `complete: true`).
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
		if (!entry)
			return { kind: 'absent' }
		// Finding 10: `entry.type === 'blob'` alone is insufficient -- a Git
		// mode `120000` symlink is ALSO reported as `type: 'blob'`, so a
		// symlink sitting at this managed path (the target's own canonical
		// path, or a `.engineering/chg/*.md` candidate) would otherwise have
		// its LINK-TARGET TEXT read and parsed as though it were the file's
		// own content. A gitlink (`type: 'commit'`) or directory (`type:
		// 'tree'`) at this same managed path is likewise not the regular file
		// this walk may trust -- but unlike the genuine "not created yet"
		// case (`!entry` above), something DOES exist at this exact path, so
		// this is reported as untrustworthy content, never conflated with
		// ordinary absence.
		if (!isRegularBlobEntry(entry))
			return { kind: 'error' }
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
	// Finding 4: whether `targetId` has EVER been observed present (at its own
	// canonical path, with matching type) at any consumed commit so far --
	// never reset per commit, unlike `previousEnvelope` (which only reflects
	// the immediately preceding commit). Once true, a later commit where the
	// target is absent from its entire Artifact discovery scope is a physical
	// deletion of an issued ID (02-identity.md forbids this), not ordinary
	// "not yet created" absence, and must fail the query rather than silently
	// resetting `previousEnvelope` back to `undefined` and letting a later
	// re-appearance be accepted as a fresh `introduces`.
	let targetEverAppeared = false
	// Finding 5 (03-lifecycle.md `ALLOWED_TRANSITIONS`; 07-change-transactions.md):
	// every CHG id's own MOST RECENTLY OBSERVED status across the WHOLE walk so
	// far -- never reset per commit (unlike the previous `previousChgStatus`/
	// `currentChgStatus` pair, which only ever compared one commit against its
	// immediate predecessor and therefore forgot a CHG entirely the moment it
	// was absent from even one commit's tree). Read as `priorStatus` before
	// this commit's own occurrence of a given CHG id is processed below, then
	// updated to that occurrence's status.
	const chgLifecycleStatus = new Map<string, Status>()

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
	// - a read/execution failure while resolving or decoding ANY blob the
	//   boundary's complete snapshot materialization needs makes the required
	//   history itself unavailable (`history-unavailable`, `EF-QRY-010`) -- a
	//   transient read failure at the true boundary must never be papered over
	//   by silently accepting a later commit's successful read as though
	//   history started there instead (that would be a silent late start).
	// - a structural/validity failure -- `ef.yaml` fails to decode as a valid
	//   `ef/config@1` configuration, or the claimed boundary's COMPLETE tree
	//   fails `validateSnapshot` (Finding 5: `application/snapshot-validation.ts`'s
	//   full pipeline -- every required control file in canonical form, exactly
	//   one active PROJECT, every Artifact decodable) or violates a
	//   bootstrap-only state rule (`bootstrap-validation.ts`'s own EF-VAL-010
	//   rules: no CHG Artifact, no terminal knowledge Artifact) -- makes this
	//   claimed boundary untrustworthy (`untrusted-data`, `EF-QRY-013`): a
	//   pre-EF commit that merely happens to carry a syntactically valid
	//   config (or any other partial EF-shaped state) but is not a genuine,
	//   complete bootstrap must be reported as untrusted, never silently
	//   skipped in favor of a later commit. See `evaluateBootstrapBoundary`'s
	//   own doc for why `validateBootstrap` itself is not called here.
	//
	// `previousTreeMap`/`previousEnvelope`/`targetEverAppeared`/
	// `chgLifecycleStatus` are left at their initial (empty) values through
	// every skipped pre-boundary commit, so the first commit actually
	// processed -- the bootstrap commit itself -- is diffed exactly as if it
	// were `oidsOldestFirst[0]`.
	let reachedBootstrap = false
	let previousEfYamlIdentity: EfYamlTreeEntryIdentity | undefined
	// The `integration_ref` the walk's OWN bootstrap commit declared -- the
	// baseline every later authoritative EF-bearing commit's own `ef.yaml` is
	// compared against (Finding 11's ALWAYS-ON self-consistency requirement,
	// independent of whether `expectedIntegrationRef` was supplied at all).
	let bootstrapIntegrationRef: string | undefined

	type EfYamlConfigOutcome
		= | { kind: 'not-present' }
			| { kind: 'read-error' }
			| { kind: 'invalid' }
			| { kind: 'valid', integrationRef: string }

	/**
	 * Decode `.engineering/ef.yaml` at `treeMap` and require a regular Git
	 * file mode (Finding 10: not a symlink, gitlink, or directory -- a plain
	 * `treeMap.get` lookup by its exact literal path can never accidentally
	 * match a `pathValid: false` placeholder entry, so no separate
	 * `pathValid` check is needed here) and a successfully decoded
	 * `ef/config@1` document, returning its declared `repository.integration_ref`
	 * on success (Finding 11) without yet judging whether that value is the
	 * "right" one -- that judgment differs at the two call sites below (the
	 * boundary compares it against `expectedIntegrationRef`; the per-commit
	 * drift check compares it against `bootstrapIntegrationRef`), so is left
	 * to each caller.
	 */
	async function evaluateEfYamlConfig(treeMap: Map<string, GitTreeEntry>): Promise<EfYamlConfigOutcome> {
		const efYamlEntry = treeMap.get(EF_YAML_PATH)
		if (!efYamlEntry)
			return { kind: 'not-present' }

		if (!isRegularBlobEntry(efYamlEntry))
			return { kind: 'invalid' }

		const configBlobResult = await git.readBlob(efYamlEntry.oid)
		if (configBlobResult.kind === 'git-unavailable' || configBlobResult.kind === 'error')
			return { kind: 'read-error' }
		if (configBlobResult.kind !== 'resolved')
			// The tree listing already proved this entry is a blob; `missing`/
			// `not-a-blob` here is repository/read corruption on an object
			// already known to exist, never proof of absence or invalidity.
			return { kind: 'read-error' }

		const configText = utf8Decoder.decode(configBlobResult.bytes)
		const decodedConfig = decodeConfig(configText, EF_YAML_PATH)
		if (decodedConfig.config === null)
			return { kind: 'invalid' }

		return { kind: 'valid', integrationRef: decodedConfig.config.repository.integrationRef }
	}

	type BootstrapBoundaryOutcome = 'not-present' | 'valid' | 'invalid' | 'read-error'

	/**
	 * Finding 5: a decodable `ef.yaml` plus a minimal `id`/`type`/`status`
	 * witness at `PROJECT.md` is NOT sufficient proof that the claimed boundary
	 * commit is a genuine, COMPLETE bootstrap (09-validation.md "Bootstrap
	 * exception"; 11-filesystem-and-config.md). Core bootstrap requires
	 * complete snapshot validation, every required control file in canonical
	 * form, no terminal knowledge Artifact, and no CHG Artifact at all -- so
	 * the claimed boundary's ENTIRE tree is materialized
	 * (`application/snapshot.ts`'s `loadSnapshotFromCommit`, the same
	 * commit-materialization `bootstrap-validation.ts` itself uses) and run
	 * through the SAME `validateSnapshot` pipeline every ordinary snapshot/
	 * transition validation uses, plus the bootstrap-only state rules
	 * `bootstrap-validation.ts`'s own `validateBootstrap` applies (EF-VAL-010:
	 * no CHG, no terminal knowledge). `validateBootstrap` itself is not called
	 * here -- it also drives ref-resolution/parentage orchestration for a
	 * caller-supplied CANDIDATE commit, which this walk has no use for: the
	 * boundary commit here is already GIVEN by the walk's own first-parent
	 * history scan, not a proposal needing its own proof of ref/parentage.
	 */
	async function evaluateBootstrapBoundary(oid: string, treeMap: Map<string, GitTreeEntry>): Promise<BootstrapBoundaryOutcome> {
		const efYamlEntry = treeMap.get(EF_YAML_PATH)
		if (!efYamlEntry)
			return 'not-present'

		// From here on, this commit IS the claimed boundary -- every path below
		// returns 'invalid' or 'read-error', never falls through to let the
		// caller consider a later commit instead.
		const loadResult = await loadSnapshotFromCommit(git, oid)
		if (!loadResult.ok)
			// `loadSnapshotFromCommit` fails this way only on a genuine
			// execution/read problem (Git unavailable, or a tree/blob already
			// proven to exist that then fails to read) -- never merely because
			// the boundary's content is invalid -- so this is
			// `history-unavailable`, mirroring every other read/execution
			// failure this probe already treats that way.
			return 'read-error'

		const snapshot = loadResult.snapshot
		const config = snapshot.config.config
		if (!config)
			return 'invalid'
		// Finding 11: `integration_ref` is fixed by bootstrap and MUST NOT
		// change within Core v1 (11-filesystem-and-config.md). When the caller
		// told us which ref it selected, a bootstrap config that is otherwise
		// perfectly valid but declares a DIFFERENT ref is exactly as
		// untrustworthy for this purpose as a config that fails to decode at
		// all -- accepting it would let a config that was schema-validly
		// edited to select a different ref be silently accepted merely
		// because THAT ref's own history happens to be internally consistent.
		if (expectedIntegrationRef !== undefined && config.repository.integrationRef !== expectedIntegrationRef)
			return 'invalid'

		const validation = validateSnapshot(snapshot)
		const summary = summarizeValidation({
			scope: 'bootstrap',
			diagnostics: validation.diagnostics,
			complete: true,
			policy: BOOTSTRAP_POLICY,
		})
		if (!summary.valid)
			return 'invalid'

		// Bootstrap-only state rules (mirrors `bootstrap-validation.ts`'s own
		// `validateBootstrap` loop over `validation.byId`): no CHG Artifact, and
		// no terminal (`superseded`/`retired`) knowledge Artifact, may be
		// present before the first EF state.
		for (const record of validation.byId.values()) {
			if (record.type === 'change')
				return 'invalid'
			if (BOOTSTRAP_KNOWLEDGE_TYPES.has(record.type) && (record.status === 'superseded' || record.status === 'retired'))
				return 'invalid'
		}

		bootstrapIntegrationRef = config.repository.integrationRef
		return 'valid'
	}

	for (const oid of oidsOldestFirst) {
		const treeMap = await treeMapAt(oid)
		if (!treeMap)
			return { kind: 'history-unavailable' }

		if (!reachedBootstrap) {
			const boundary = await evaluateBootstrapBoundary(oid, treeMap)
			if (boundary === 'not-present')
				continue
			if (boundary === 'read-error')
				return { kind: 'history-unavailable' }
			if (boundary === 'invalid')
				return { kind: 'untrusted-data' }
			reachedBootstrap = true
			// The boundary commit's `ef.yaml` was just proven (by
			// `evaluateBootstrapBoundary` above) to be a regular blob decoding
			// to a valid config, and `bootstrapIntegrationRef` now holds its
			// declared `integration_ref` (matched against
			// `expectedIntegrationRef` already, when supplied). Record its full
			// tree-entry identity as the baseline every later commit's own
			// `ef.yaml` entry is compared against (Finding 11, Finding 6).
			previousEfYamlIdentity = efYamlIdentityOf(treeMap)
		}
		else {
			// Finding 11: `integration_ref` is fixed by bootstrap and MUST NOT
			// change within Core v1 -- checked here regardless of whether
			// `expectedIntegrationRef` was supplied at all, purely against
			// `bootstrapIntegrationRef` (this SAME walk's own bootstrap
			// commit's declared ref): a self-consistency requirement that
			// needs no external input. Re-validate only when THIS commit's own
			// `.engineering/ef.yaml` TREE ENTRY actually changed since the last
			// commit this walk checked it at -- an unchanged entry was already
			// proven to declare `bootstrapIntegrationRef` (either at the
			// boundary, or at whichever later commit last changed it), so
			// re-decoding it again here would be redundant, not more correct.
			// Finding 6: comparing `oid` ALONE would miss a commit that
			// rewrites this same path's MODE (e.g. `100644` -> the forbidden
			// symlink mode `120000`) while reusing the identical blob OID --
			// `efYamlIdentityOf`'s `{ oid, mode, pathValid }` cache key re-runs
			// the cheap regularity/decode check on any such change, not only an
			// OID change.
			const currentEfYamlIdentity = efYamlIdentityOf(treeMap)
			if (!sameEfYamlIdentity(currentEfYamlIdentity, previousEfYamlIdentity)) {
				const configOutcome = await evaluateEfYamlConfig(treeMap)
				if (configOutcome.kind === 'read-error')
					return { kind: 'history-unavailable' }
				// `'not-present'` here means the control file the walk has
				// already proven authoritative EF state depends on has been
				// REMOVED at a later commit -- unlike the pre-boundary probe
				// (where absence just means "not yet"), this commit is
				// already known to be part of the authoritative EF-bearing
				// sequence, so its disappearance (or its replacement by a
				// config that fails to decode) makes this commit's state
				// untrustworthy.
				if (configOutcome.kind === 'not-present' || configOutcome.kind === 'invalid')
					return { kind: 'untrusted-data' }
				// The retarget check itself: this later commit's own declared
				// `integration_ref` MUST still equal whatever the walk's
				// bootstrap commit declared.
				if (configOutcome.integrationRef !== bootstrapIntegrationRef)
					return { kind: 'untrusted-data' }
				previousEfYamlIdentity = currentEfYamlIdentity
			}
		}

		// Finding 10 (second omission variant): checked once per consumed
		// commit -- an invalid-UTF-8 path anywhere beneath `.engineering`
		// (not only inside `.engineering/chg/`) is invisible to every
		// prefix/exact-match scan below (its decoded `path` can never equal
		// or start with a genuine managed path), so it must be surfaced here
		// instead of silently passing through as though it did not exist.
		if (hasInvalidUtf8PathUnderEngineering(treeMap))
			return { kind: 'untrusted-data' }

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

		// Finding 4: the canonical-path lookup above only proves what sits at
		// THAT one path. `targetId` may ALSO (or instead) be sitting at some
		// OTHER path this commit's Artifact discovery scope contains -- a
		// wrong/non-canonical placement (10-query-and-trace.md: history uses
		// the stable Artifact ID and MUST NOT rely only on current path) -- or
		// have vanished entirely after having genuinely appeared before
		// (02-identity.md: an issued ID's Artifact "MUST remain in the
		// authoritative files ... rather than be physically deleted"). Any of
		// these makes this commit's content untrustworthy for the aggregate
		// this walk is diffing: a wrong-path or duplicate occurrence is
		// ambiguous about which content is really `targetId`'s own, and a
		// disappearance-then-later-reappearance would otherwise reset
		// `previousEnvelope` to `undefined` and let the reappearance be
		// silently accepted as a fresh `introduces` effect.
		for (const candidatePath of artifactDiscoveryPaths(treeMap)) {
			if (candidatePath === canonicalPath)
				continue
			const candidateLookup = await envelopeAt(treeMap, candidatePath)
			if (candidateLookup.kind === 'error')
				return { kind: 'untrusted-data' }
			if (candidateLookup.kind === 'resolved' && candidateLookup.envelope.id === targetId)
				// A second, non-canonical occurrence of `targetId` -- whether or
				// not the canonical path ALSO currently resolves to it -- is
				// either a wrong-path placement or an ambiguous duplicate; either
				// way this walk cannot trust which content is `targetId`'s own.
				return { kind: 'untrusted-data' }
		}
		if (currentEnvelope === undefined && targetEverAppeared)
			// `targetId` was genuinely present (at its own canonical path) in an
			// earlier consumed commit and is now absent everywhere in this
			// commit's Artifact discovery scope -- a physical deletion of an
			// issued ID, never a legitimate "not yet created" state at this
			// point in the walk.
			return { kind: 'untrusted-data' }
		if (currentEnvelope !== undefined)
			targetEverAppeared = true

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
		// Finding 8 (EF-CHG-007, exactly-once at one integration boundary):
		// collected here, across EVERY completing CHG this commit's
		// `.engineering/chg/` scan discovers, and only pushed to `effects`
		// once the whole commit has been scanned -- never pushed one CHG at a
		// time -- so that two DIFFERENT CHGs both newly completing in this
		// SAME commit and both claiming `targetId` can be caught together
		// (below) instead of each independently looking like a single valid
		// claim.
		const pendingEffectsThisCommit: HistoryEffectData[] = []
		// Finding 5: which CHG ids this commit's tree actually contains (by
		// declared id, not path) -- used after this scan to detect a
		// previously-terminal (`completed`/`retired`) CHG that has vanished
		// from this commit's tree entirely (02-identity.md: an issued ID's
		// Artifact must never be physically deleted).
		const presentChgIds = new Set<string>()
		for (const path of treeMap.keys()) {
			if (!path.startsWith('.engineering/chg/') || !path.endsWith('.md'))
				continue

			// Finding 10: candidacy is now path-shape only -- `envelopeAt`
			// itself applies the regular Git mode classification (a
			// symlink-mode `120000` blob, gitlink, or directory sitting at
			// this exact CHG-shaped path returns `'error'`, never silently
			// treated as though no CHG existed there).
			const chgLookup = await envelopeAt(treeMap, path)
			if (chgLookup.kind === 'error')
				return { kind: 'untrusted-data' }
			if (chgLookup.kind === 'absent')
				continue
			const chgEnvelope = chgLookup.envelope
			// Finding 7(d): a managed path shaped exactly like a CHG
			// (`.engineering/chg/*.md`) whose envelope decodes to a NON-`change`
			// type is not a CHG this walk may simply ignore -- it is a
			// managed-path/type mismatch this walk cannot make sense of at all
			// (an Artifact of some OTHER declared type occupying a path this
			// commit's `.engineering/chg/` layout convention reserves for CHGs).
			// Silently `continue`-ing here would let such a commit still report
			// `complete: true` over content this walk never actually trusted.
			if (chgEnvelope.type !== 'change')
				return { kind: 'untrusted-data' }

			// This walk discovers every CHG purely by scanning blob paths under
			// `.engineering/chg/` and indexes each one's completion status
			// (`chgLifecycleStatus`, keyed by the CHG's own declared `id`)
			// across the WHOLE walk to detect the exact commit where it
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

			presentChgIds.add(chgEnvelope.id)

			// Finding 5 (03-lifecycle.md `ALLOWED_TRANSITIONS`): `priorStatus` is
			// this CHG id's MOST RECENTLY OBSERVED status across the ENTIRE walk
			// so far (never merely the immediately preceding commit -- see
			// `chgLifecycleStatus`'s own doc). A first appearance (`priorStatus
			// === undefined`) MAY itself be `completed` or `retired` directly
			// (a CHG can be created and completed in the same commit). Once an
			// id HAS appeared, though, its status sequence must obey Core's own
			// lifecycle rules: a terminal status (`completed`/`retired`) is
			// frozen -- it can never change to a different status again, and
			// (checked once the whole commit's scan completes, below) it can
			// never simply disappear either -- and any other status change must
			// be one of the type's own `ALLOWED_TRANSITIONS`. Without this, a
			// CHG that regresses `retired -> completed`, `completed -> draft ->
			// completed`, or `completed -> <deleted> -> completed` would make
			// `wasCompleted` false again at the illegitimate re-completion,
			// letting it emit another authoritative effect for content Core
			// itself would never have permitted to reach that state.
			const priorStatus = chgLifecycleStatus.get(chgEnvelope.id)
			if (priorStatus !== undefined && priorStatus !== chgEnvelope.status) {
				const isLegalTransition = !TERMINAL_STATUSES.includes(priorStatus)
					&& ALLOWED_TRANSITIONS.change.some(([from, to]) => from === priorStatus && to === chgEnvelope.status)
				if (!isLegalTransition)
					return { kind: 'untrusted-data' }
			}
			const wasCompleted = priorStatus === 'completed'
			chgLifecycleStatus.set(chgEnvelope.id, chgEnvelope.status)
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

			const effectRelationsOnTarget = relationValidation.entries.filter(
				(relation): relation is typeof relation & { type: 'introduces' | 'modifies' | 'retires' } =>
					relation.target === targetId
					&& (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires'),
			)

			// Finding 6 (04-relations.md `RELATION_COMPATIBILITY`; EF-CHG-017): an
			// effect relation's (source `change`, `type`, target type) triple must
			// satisfy the SAME compatibility matrix `domain/relations.ts`'s own
			// `validateRelationGraph` applies for the current graph -- CHG-only
			// `introduces`/`retires` targets are restricted to
			// prd/requirement/decision/policy, and `modifies` additionally allows
			// `project`, but NONE of the three ever allow another `change` as their
			// target (a CHG cannot effect another CHG). This walk only has ONE
			// target's own historical type on hand (`targetType`, fixed for the
			// whole call), so it applies the matrix narrowly against that type
			// rather than re-deriving the full graph. A relation that names
			// `targetId` with an effect type the matrix forbids for `targetType`
			// is not a plausible historical fact this CHG could ever have
			// legitimately declared -- Core's own commit-time transaction
			// validation would already have rejected it -- so its mere presence
			// here makes this commit's data untrustworthy, rather than being
			// silently dropped as though it simply did not qualify.
			if (effectRelationsOnTarget.some(relation => !RELATION_COMPATIBILITY[relation.type].targets.includes(targetType)))
				return { kind: 'untrusted-data' }
			const qualifyingRelations = effectRelationsOnTarget

			if (qualifyingRelations.length > 0) {
				// Finding 7(a) (EF-CHG-004 class): `EF-REL-006` above only
				// excludes a literal DUPLICATE `(type, target)` pair -- it does
				// NOT catch a single completed CHG declaring TWO DIFFERENT
				// effect types for the SAME target (e.g. both `introduces ->
				// REQ-001` AND `modifies -> REQ-001`). Those are not duplicate
				// pairs, so both entries survive `relationValidation.entries`
				// and would otherwise reach the emission loop below, making
				// this walk emit two conflicting authoritative effects for the
				// same commit -- violating the exactly-once/net-effect contract
				// (07-change-transactions.md). A CHG whose own relations are
				// this internally contradictory about ITS OWN target cannot be
				// trusted to report which (if either) effect is real.
				const qualifyingRelationTypes = new Set(qualifyingRelations.map(relation => relation.type))
				if (qualifyingRelationTypes.size > 1)
					return { kind: 'untrusted-data' }

				// Finding 7(b): a completed CHG's effects are only trustworthy
				// when its body actually satisfies 07-change-transactions.md's
				// completed-CHG structural requirements -- Rationale/Sources/
				// Changes/Verification each present exactly once, with a
				// well-formed Verification result marker compatible with
				// `status: completed`. `envelopeAt` only validates the
				// FRONTMATTER envelope; the body is independently re-parsed and
				// re-validated here via the SAME `parseBody`/`extractSections`/
				// `validateBody` pipeline `application/snapshot.ts`/
				// `snapshot-validation.ts` run for the current snapshot,
				// applied to this historical CHG blob's own bytes. A
				// `splitFrontmatter` re-run over the SAME bytes `envelopeAt`
				// already split successfully cannot newly fail here.
				const chgText = utf8Decoder.decode(chgLookup.bytes)
				const chgSplit = splitFrontmatter(chgText)
				const chgBody = chgSplit.ok ? parseBody(chgSplit.bodyText, chgSplit.bodyStartLine - 1) : undefined
				if (!chgSplit.ok || !chgBody || !chgBody.ok)
					return { kind: 'untrusted-data' }
				const chgBodyDiagnostics = validateBody({
					type: 'change',
					status: 'completed',
					path,
					body: extractSections(chgBody.root),
				})
				if (hasErrorDiagnostic(chgBodyDiagnostics))
					return { kind: 'untrusted-data' }

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

			// Finding 7(c): a completed CHG's declared effect FACT is never
			// taken on trust alone -- it must match the target's own before/
			// after aggregate transition ACROSS THIS EXACT COMMIT boundary
			// (07-change-transactions.md net-effect classification):
			// absent -> present is `introduces`; present -> `status: retired`
			// is `retires`; present -> present with the aggregate's own
			// content actually changed is `modifies`; anything else (no real
			// aggregate transition at all, or a physical absent -> absent /
			// present -> absent shape a CHG cannot legitimately claim) matches
			// NONE of the three effect types. This walk already tracks the
			// target aggregate's before/after presence (`previousEnvelope`/
			// `currentEnvelope`) and per-commit owned-path OID changes
			// (`changed`, computed above for `commits`) -- reused here rather
			// than re-derived.
			const targetContentChanged = changed.length > 0
			// Finding 7: `retires` requires a GENUINE transition INTO `retired`
			// (present, not already retired -> present, retired) -- not merely
			// "currently retired", which an already-terminal, byte-identical
			// target (`previousEnvelope.status === 'retired'` already) would also
			// satisfy. 07-change-transactions.md's own `retires` definition is
			// "before: present and not retired -> after: retired"; terminal
			// content is frozen, so a target that was ALREADY `retired` before
			// this commit can never be the subject of a fresh `retires` effect,
			// regardless of what a completing CHG declares.
			const actualEffect: 'introduces' | 'modifies' | 'retires' | undefined
				= previousEnvelope === undefined && currentEnvelope !== undefined
					? 'introduces'
					: previousEnvelope !== undefined && currentEnvelope !== undefined
						&& currentEnvelope.status === 'retired' && previousEnvelope.status !== 'retired'
						? 'retires'
						: previousEnvelope !== undefined && currentEnvelope !== undefined && targetContentChanged
							? 'modifies'
							: undefined
			if (qualifyingRelations.some(relation => relation.type !== actualEffect))
				return { kind: 'untrusted-data' }

			for (const relation of qualifyingRelations) {
				// History is defined by the authoritative integration state
				// observed AT THIS COMMIT, not by whatever the CHG's current
				// (possibly since-edited, possibly uncommitted) record says now
				// -- the effect summary is built unconditionally from the
				// historically-decoded `chgEnvelope`/`path` at this `oid`
				// (10-query-and-trace.md history: effects carry the CHG summary
				// from the authoritative integration commit).
				const chgSummary = buildArtifactSummary(chgEnvelope, path)

				// Finding 8: NOT pushed directly to `effects` -- collected in
				// `pendingEffectsThisCommit` and only released after every CHG in
				// this commit has been scanned, so a second, DIFFERENT completing
				// CHG that ALSO qualifies for `targetId` in this SAME commit can
				// still be caught (below) before either reaches the caller.
				pendingEffectsThisCommit.push({
					chg: chgSummary,
					effect: relation.type,
					status_before: previousEnvelope?.status ?? null,
					status_after: currentEnvelope?.status ?? previousEnvelope?.status ?? 'retired',
					commit_oid: oid,
				})
			}
		}

		// Finding 5: a CHG id previously observed at a TERMINAL status
		// (`completed`/`retired`) that is no longer present anywhere in this
		// commit's `.engineering/chg/` scan has been physically deleted --
		// 02-identity.md forbids this ("its Artifact MUST remain in the
		// authoritative files ... rather than be physically deleted"), so this
		// commit's content is untrustworthy rather than merely "this CHG has no
		// history at this point".
		for (const [chgId, status] of chgLifecycleStatus) {
			if (TERMINAL_STATUSES.includes(status) && !presentChgIds.has(chgId))
				return { kind: 'untrusted-data' }
		}

		// Finding 8 (EF-CHG-007): more than one completing CHG's qualifying claim
		// on `targetId` at this SAME integration boundary is exactly the
		// exactly-once violation Core's own commit-time validation exists to
		// prevent -- this walk must fail the whole query rather than emitting
		// either (or both) as though only one CHG had ever claimed this target
		// here.
		if (pendingEffectsThisCommit.length > 1)
			return { kind: 'untrusted-data' }
		effects.push(...pendingEffectsThisCommit)

		previousTreeMap = treeMap
		previousEnvelope = currentEnvelope
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
